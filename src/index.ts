import 'dotenv/config';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { SheetsAdapter } from "./adapters/sheets.adapter.js";
import { GmailAdapter } from "./adapters/gmail.adapter.js";
import { DriveAdapter } from "./adapters/drive.adapter.js";
import { CalendarAdapter } from "./adapters/calendar.adapter.js";
import { TasksAdapter } from "./adapters/tasks.adapter.js";
import { DocsAdapter } from "./adapters/docs.adapter.js";
import { registerBITools } from "./tools/bi.js";
import { registerCobrosTools } from "./tools/cobros.js";
import { registerInventarioTools } from "./tools/inventario.js";
import { registerVentasTools } from "./tools/ventas.js";
import { registerGoogleTools } from "./tools/google.js";
import { logger } from "./utils/logger.js";
import { initDB, upsertEmpresa, getEmpresaById } from "./auth/db.js";
import { getAuthUrl, exchangeCodeForTokens, getUserInfo } from "./auth/oauth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Adaptadores base (empresa de demo)
const sheets = new SheetsAdapter();
const gmail = new GmailAdapter();
const drive = new DriveAdapter();
const calendar = new CalendarAdapter();
const tasks = new TasksAdapter();
const docs = new DocsAdapter();

// Mapa de sesiones activas
const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

// Parsear body de requests
function parseBody(req: http.IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

// Parsear query string
function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const params = new URLSearchParams(url.slice(idx + 1));
  const result: Record<string, string> = {};
  params.forEach((v, k) => result[k] = v);
  return result;
}

const httpServer = http.createServer(async (req, res) => {
  const url = req.url ?? '/';

  // ── Página de onboarding ──────────────────────────────────────────
  if (url === '/' && req.method === 'GET') {
    const html = fs.readFileSync(
      path.join(__dirname, 'web', 'onboarding.html'), 'utf-8'
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // ── Iniciar OAuth Google ──────────────────────────────────────────
  if (url === '/auth/google' && req.method === 'GET') {
    const authUrl = getAuthUrl();
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // ── Callback OAuth Google ─────────────────────────────────────────
  if (url.startsWith('/auth/google/callback') && req.method === 'GET') {
    const query = parseQuery(url);
    const code = query['code'];

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>Error: no se recibió el código de autorización.</h2>');
      return;
    }

    try {
      const tokens = await exchangeCodeForTokens(code);
      const userInfo = await getUserInfo(tokens.access_token!);

      const empresa = await upsertEmpresa({
        email: userInfo.email!,
        nombre: userInfo.name ?? userInfo.email!,
        google_refresh_token: tokens.refresh_token!,
        sheet_id: query['sheet_id'],
      });

      logger.info('Empresa conectada via OAuth', {
        data: { email: userInfo.email, empresa_id: empresa.id }
      });

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
          <meta charset="UTF-8"/>
          <title>PyME Brain — Conectado</title>
          <style>
            body { font-family: -apple-system, sans-serif; background: #f8f9fa;
                   display: flex; align-items: center; justify-content: center;
                   min-height: 100vh; margin: 0; }
            .card { background: white; border-radius: 16px; padding: 48px 40px;
                    max-width: 480px; width: 90%; text-align: center;
                    box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
            h1 { color: #2e7d32; font-size: 24px; margin: 16px 0 8px; }
            p { color: #666; font-size: 15px; line-height: 1.6; margin-bottom: 8px; }
            .id { font-family: monospace; background: #f0f0f0; padding: 8px 16px;
                  border-radius: 8px; font-size: 13px; margin: 16px 0;
                  word-break: break-all; }
            .tip { font-size: 13px; color: #888; margin-top: 24px; }
          </style>
        </head>
        <body>
          <div class="card">
            <div style="font-size:48px">✅</div>
            <h1>¡Negocio conectado!</h1>
            <p>Hola <strong>${userInfo.name ?? userInfo.email}</strong>,<br/>
               tu cuenta Google está vinculada a PyME Brain.</p>
            <p>Tu ID de empresa:</p>
            <div class="id">${empresa.id}</div>
            <p class="tip">
              Usa este ID como parámetro <code>empresa_id</code> al conectar 
              tu MCP server en Claude o ChatGPT.
            </p>
          </div>
        </body>
        </html>
      `);
    } catch (err) {
      logger.error('Error en OAuth callback', { error: String(err) });
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h2>Error al conectar: ${String(err)}</h2>`);
    }
    return;
  }

  // ── Health check ──────────────────────────────────────────────────
  if (url === '/health' && req.method === 'GET') {
    const empresaConfig = sheets.getEmpresaConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'OK',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      empresa: empresaConfig?.nombre_empresa ?? 'Cargando...',
      ciudad: empresaConfig?.ciudad ?? '',
      moneda: empresaConfig?.moneda ?? 'BOB',
      uptime: process.uptime(),
      integraciones: {
        sheets: '✅', gmail: '✅', drive: '✅',
        calendar: '✅', tasks: '✅', docs: '✅',
        database: '✅',
      }
    }));
    return;
  }

  // ── Endpoint MCP ──────────────────────────────────────────────────
  if (url === '/mcp') {
    const sessionId = req.headers['mcp-session-id'] as string ?? randomUUID();
    let session = sessions.get(sessionId);

    if (!session) {
      const server = new McpServer({ name: 'pyme-brain', version: '1.0.0' });

      registerBITools(server, sheets);
      registerCobrosTools(server, sheets);
      registerInventarioTools(server, sheets);
      registerVentasTools(server, sheets);
      registerGoogleTools(server, gmail, drive, calendar, tasks, docs);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
      });

      await server.connect(transport);
      session = { server, transport };
      sessions.set(sessionId, session);

      logger.info('Nueva sesión MCP creada', { data: { sessionId } });
    }

    await session.transport.handleRequest(req, res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const PORT = process.env.PORT ?? 3000;

// Inicializar DB y servidor
async function main() {
  await initDB();
  logger.info('Base de datos PostgreSQL inicializada');

  await sheets.initialize();
  const config = sheets.getEmpresaConfig();

  httpServer.listen(PORT, () => {
    logger.info('PyME Brain iniciado', { data: { port: PORT } });
    console.log(`✅ PyME Brain MCP Server — ${config?.nombre_empresa}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   MCP:    http://localhost:${PORT}/mcp`);
    console.log(`   Web:    http://localhost:${PORT}/`);
  });
}

main().catch(err => {
  logger.error('Error al iniciar', { error: String(err) });
  process.exit(1);
});