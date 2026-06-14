import 'dotenv/config';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import http from "http";
import { SheetsAdapter } from "./adapters/sheets.adapter.js";
import { registerBITools } from "./tools/bi.js";
import { registerCobrosTools } from "./tools/cobros.js";
import { registerInventarioTools } from "./tools/inventario.js";
import { logger } from "./utils/logger.js";

// Inicializar adaptador
const sheets = new SheetsAdapter();

// Mapa de sesiones activas
const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

// Servidor HTTP
const httpServer = http.createServer(async (req, res) => {

  // Health check
  if (req.url === "/health" && req.method === "GET") {
    const empresaConfig = sheets.getEmpresaConfig();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "OK",
      timestamp: new Date().toISOString(),
      version: "1.0.0",
      empresa: empresaConfig?.nombre_empresa ?? "Cargando...",
      ciudad: empresaConfig?.ciudad ?? "",
      moneda: empresaConfig?.moneda ?? "BOB",
      uptime: process.uptime(),
    }));
    return;
  }

  // Endpoint MCP
  if (req.url === "/mcp") {
    const sessionId = req.headers["mcp-session-id"] as string ?? randomUUID();
    let session = sessions.get(sessionId);

    if (!session) {
      const server = new McpServer({
        name: "pyme-brain",
        version: "1.0.0",
      });

      registerBITools(server, sheets);
      registerCobrosTools(server, sheets);
      registerInventarioTools(server, sheets);

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
  res.end("Not found");
});

const PORT = process.env.PORT ?? 3000;

// Inicializar configuración de empresa antes de arrancar
sheets.initialize().then(() => {
  const config = sheets.getEmpresaConfig();
  httpServer.listen(PORT, () => {
    logger.info('PyME Brain iniciado', {
      message: `✅ Corriendo en http://localhost:${PORT}`,
      data: {
        port: PORT,
        empresa: config?.nombre_empresa,
        ciudad: config?.ciudad,
        moneda: config?.moneda,
        nit: config?.nit,
      }
    });
    console.log(`✅ PyME Brain MCP Server — ${config?.nombre_empresa}`);
    console.log(`   Ciudad:  ${config?.ciudad} · ${config?.pais}`);
    console.log(`   Moneda:  ${config?.moneda}`);
    console.log(`   Health:  http://localhost:${PORT}/health`);
    console.log(`   MCP:     http://localhost:${PORT}/mcp`);
  });
}).catch(err => {
  logger.error('Error al inicializar configuración', { error: String(err) });
  process.exit(1);
});