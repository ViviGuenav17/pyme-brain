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
import { WhatsAppAdapter } from "./adapters/whatsapp.adapter.js";
import { WhatsappSheetAdapter } from "./adapters/whatsapp-sheet.adapter.js";
import { registerBITools } from "./tools/bi.js";
import { registerCobrosTools } from "./tools/cobros.js";
import { registerInventarioTools } from "./tools/inventario.js";
import { registerVentasTools } from "./tools/ventas.js";
import { registerGoogleTools } from "./tools/google.js";
import { registerFacturacionTools } from "./tools/facturacion.js";
import { registerWhatsappTools } from "./tools/whatsapp.js";
import { logger } from "./utils/logger.js";
import { initDB, upsertEmpresa, updateEmpresaWhatsapp } from "./auth/db.js";
import { getAuthUrl, exchangeCodeForTokens, getUserInfo } from "./auth/oauth.js";
import { getAdaptersForEmpresa, invalidateTenantCache } from "./auth/tenant.js";
import { handleWhatsAppWebhookVerify, handleWhatsAppWebhookEvent } from "./webhooks/whatsapp-webhook.handler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Adaptadores demo — usados cuando no hay empresa_id
const sheets = new SheetsAdapter();
const gmail = new GmailAdapter();
const drive = new DriveAdapter();
const calendar = new CalendarAdapter();
const tasks = new TasksAdapter();
const docs = new DocsAdapter();
const whatsapp = new WhatsAppAdapter(); // fallback a .env — número de prueba demo, sin empresa_id fija
const whatsappSheet = new WhatsappSheetAdapter(); // Sheet separado de Mensajes/Contactos/Plantillas WhatsApp

// ── Estado de salud del tenant demo (Sheet/Google) ──────────────────
// Si el refresh token demo vence (invalid_grant) o el Sheet falla al
// arrancar, el servidor NO debe morir: sigue sirviendo HTTP (onboarding,
// health, OAuth callback, multi-tenant) en modo degradado para ese tenant.
let demoSheetsStatus: { ok: boolean; error?: string } = { ok: false, error: 'No inicializado aún' };

const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const params = new URLSearchParams(url.slice(idx + 1));
  const result: Record<string, string> = {};
  params.forEach((v, k) => result[k] = v);
  return result;
}

function getOnboardingHTML(): string {
  const paths = [
    path.join(__dirname, 'web', 'onboarding.html'),
    path.join(__dirname, '..', 'src', 'web', 'onboarding.html'),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
  }
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/>
    <title>PyME Brain</title>
    <style>body{font-family:sans-serif;display:flex;align-items:center;
    justify-content:center;min-height:100vh;margin:0;background:#f8f9fa;}
    .card{background:white;border-radius:16px;padding:48px 40px;max-width:480px;
    width:90%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.08);}
    h1{color:#1a1a2e;margin-bottom:8px;}p{color:#666;margin-bottom:32px;}
    a{display:inline-block;padding:14px 32px;background:#4285F4;color:white;
    border-radius:10px;text-decoration:none;font-size:16px;font-weight:500;}
    a:hover{background:#3367d6;}</style>
    </head><body><div class="card">
    <div style="font-size:48px">🧠</div>
    <h1>PyME Brain</h1>
    <p>Tu asistente de IA para PYMEs bolivianas.<br/>
    Conecta tu cuenta Google para comenzar.</p>
    <a href="/auth/google">Conectar con Google</a>
    </div></body></html>`;
}

const httpServer = http.createServer(async (req, res) => {
  const url = req.url ?? '/';

  // ── Página de onboarding ──────────────────────────────────────────
  if (url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getOnboardingHTML());
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

      // Si esta empresa reconectada es el tenant demo, invalidamos su
      // cache de adapters para que tome el refresh_token nuevo de inmediato.
      invalidateTenantCache(empresa.id);

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
        <html lang="es"><head><meta charset="UTF-8"/>
        <title>PyME Brain — Conectado</title>
        <style>
          body{font-family:sans-serif;background:#f8f9fa;display:flex;
          align-items:center;justify-content:center;min-height:100vh;margin:0;}
          .card{background:white;border-radius:16px;padding:48px 40px;
          max-width:480px;width:90%;text-align:center;
          box-shadow:0 4px 24px rgba(0,0,0,0.08);}
          h1{color:#2e7d32;font-size:24px;margin:16px 0 8px;}
          p{color:#666;font-size:15px;line-height:1.6;margin-bottom:8px;}
          .id{font-family:monospace;background:#f0f0f0;padding:8px 16px;
          border-radius:8px;font-size:13px;margin:16px 0;word-break:break-all;}
          .tip{font-size:13px;color:#888;margin-top:24px;}
        </style></head>
        <body><div class="card">
          <div style="font-size:48px">✅</div>
          <h1>¡Negocio conectado!</h1>
          <p>Hola <strong>${userInfo.name ?? userInfo.email}</strong>,<br/>
          tu cuenta Google está vinculada a PyME Brain.</p>
          <p>Tu ID de empresa:</p>
          <div class="id">${empresa.id}</div>
          <p class="tip">Usa este ID como parámetro <code>empresa_id</code>
          al conectar tu MCP server en Claude o ChatGPT.</p>
        </div></body></html>`);

    } catch (err) {
      logger.error('Error en OAuth callback', { error: String(err) });
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h2>Error al conectar: ${String(err)}</h2>`);
    }
    return;
  }

  // ── Vincular WhatsApp a una empresa manualmente (temporal, mientras no ──
  // ── existe el flujo OAuth completo de Meta — Solución B simplificada) ──
  // POST body JSON, NO query params — evita exponer el token en la URL/logs.
  if (url === '/auth/whatsapp/manual' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const { empresa_id, whatsapp_token, whatsapp_phone_number_id, whatsapp_business_account_id } = data;

        if (!empresa_id || !whatsapp_token || !whatsapp_phone_number_id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Faltan campos: empresa_id, whatsapp_token, whatsapp_phone_number_id' }));
          return;
        }

        const empresa = await updateEmpresaWhatsapp(empresa_id, {
          whatsapp_token,
          whatsapp_phone_number_id,
          whatsapp_business_account_id,
        });

        if (!empresa) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Empresa ${empresa_id} no encontrada` }));
          return;
        }

        logger.info('WhatsApp vinculado manualmente a empresa', {
          data: { empresa_id, nombre: empresa.nombre }
        });

        invalidateTenantCache(empresa_id);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'OK',
          empresa_id: empresa.id,
          nombre: empresa.nombre,
          whatsapp_phone_number_id: empresa.whatsapp_phone_number_id,
        }));
      } catch (err) {
        logger.error('Error vinculando WhatsApp manual', { error: String(err) });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  // ── Webhook de WhatsApp — verificación (Meta llama esto una sola vez) ──
  if (url.startsWith('/webhooks/whatsapp') && req.method === 'GET') {
    handleWhatsAppWebhookVerify(req, res);
    return;
  }

  // ── Webhook de WhatsApp — mensajes entrantes en tiempo real ─────────
  if (url.startsWith('/webhooks/whatsapp') && req.method === 'POST') {
    await handleWhatsAppWebhookEvent(req, res);
    return;
  }

  // ── Health check ──────────────────────────────────────────────────
  if (url === '/health' && req.method === 'GET') {
    const empresaConfig = demoSheetsStatus.ok ? sheets.getEmpresaConfig() : undefined;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: demoSheetsStatus.ok ? 'OK' : 'DEGRADED',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      empresa: empresaConfig?.nombre_empresa ?? 'Cargando...',
      ciudad: empresaConfig?.ciudad ?? '',
      moneda: empresaConfig?.moneda ?? 'BOB',
      uptime: process.uptime(),
      integraciones: {
        sheets: demoSheetsStatus.ok ? '✅' : `⚠️ ${demoSheetsStatus.error ?? 'no disponible'}`,
        gmail: '✅', drive: '✅',
        calendar: '✅', tasks: '✅', docs: '✅',
        database: '✅',
        whatsapp: whatsapp.isConfigured() ? '✅' : '⚠️ no configurado',
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

      // Resolver adapters — usa empresa_id si viene en header, sino usa demo
      const empresaId = req.headers['x-empresa-id'] as string | undefined;
      let activeSheets = sheets;
      let activeGmail = gmail;
      let activeDrive = drive;
      let activeCalendar = calendar;
      let activeTasks = tasks;
      let activeDocs = docs;
      let activeWhatsapp = whatsapp;

      if (empresaId) {
        try {
          const tenant = await getAdaptersForEmpresa(empresaId);
          activeSheets = tenant.sheets;
          activeGmail = tenant.gmail;
          activeDrive = tenant.drive;
          activeCalendar = tenant.calendar;
          activeTasks = tenant.tasks;
          activeDocs = tenant.docs;
          activeWhatsapp = tenant.whatsapp;
          logger.info('Sesión MCP multi-tenant', {
            data: { sessionId, empresa_id: empresaId, nombre: tenant.empresa_nombre }
          });
        } catch (err) {
          logger.warn('empresa_id inválido, usando demo', {
            data: { empresaId, error: String(err) }
          });
        }
      } else if (!demoSheetsStatus.ok) {
        // No vino empresa_id Y el tenant demo está degradado (token vencido, etc).
        // Avisamos explícitamente en vez de dejar que las tools fallen en silencio.
        logger.warn('Sesión MCP demo solicitada pero el Sheet demo está degradado', {
          data: { sessionId, error: demoSheetsStatus.error }
        });
      }

      registerBITools(server, activeSheets);
      registerCobrosTools(server, activeSheets);
      registerInventarioTools(server, activeSheets);
      registerVentasTools(server, activeSheets);
      registerGoogleTools(server, activeGmail, activeDrive, activeCalendar, activeTasks, activeDocs);
      registerFacturacionTools(server, sheets);
      registerWhatsappTools(server, activeWhatsapp, activeSheets, whatsappSheet);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
      });

      await server.connect(transport);
      session = { server, transport };
      sessions.set(sessionId, session);

      logger.info('Nueva sesión MCP creada', {
        data: { sessionId, empresaId: empresaId ?? 'demo' }
      });
    }

    await session.transport.handleRequest(req, res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const PORT = process.env.PORT ?? 3000;

async function main() {
  await initDB();
  logger.info('Base de datos PostgreSQL inicializada');

  // ── Graceful Degradation ────────────────────────────────────────
  // Si el refresh token del tenant demo venció (invalid_grant) o el Sheet
  // falla por cualquier motivo, NO matamos el proceso. El servidor sigue
  // arrancando y sirviendo HTTP (onboarding, OAuth, multi-tenant, health),
  // solo el tenant demo queda marcado como degradado hasta que alguien
  // reconecte Google desde "/".
  try {
    await sheets.initialize();
    demoSheetsStatus = { ok: true };
    logger.info('Sheet demo inicializado correctamente');
  } catch (err) {
    demoSheetsStatus = { ok: false, error: String(err) };
    logger.error('Sheet demo no disponible al iniciar — continuando en modo degradado', {
      error: String(err)
    });
  }

  const config = demoSheetsStatus.ok ? sheets.getEmpresaConfig() : undefined;

  httpServer.listen(PORT, () => {
    logger.info('PyME Brain iniciado', { data: { port: PORT, demoSheets: demoSheetsStatus.ok } });
    console.log(`✅ PyME Brain MCP Server — ${config?.nombre_empresa ?? '(tenant demo degradado)'}`);
    console.log(`   Health:   http://localhost:${PORT}/health`);
    console.log(`   MCP:      http://localhost:${PORT}/mcp`);
    console.log(`   Web:      http://localhost:${PORT}/`);
    console.log(`   Webhook:  http://localhost:${PORT}/webhooks/whatsapp`);
  });
}

main().catch(err => {
  // Esto solo debería dispararse ante errores realmente fatales
  // (ej: initDB() falla porque DATABASE_URL está mal, o el puerto
  // ya está en uso) — no ante fallos de un adaptador individual.
  logger.error('Error fatal al iniciar', { error: String(err) });
  process.exit(1);
});