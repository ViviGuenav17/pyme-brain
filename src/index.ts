import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import http from "http";
import { SheetsAdapter } from "./adapters/sheets.adapter.js";
import { registerBITools } from "./tools/bi.js";
import { registerCobrosTools } from "./tools/cobros.js";
import { logger } from "./utils/logger.js";

// Inicializar adaptadores
const sheets = new SheetsAdapter();

// Mapa de sesiones activas — una por conexión
const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

// Servidor HTTP
const httpServer = http.createServer(async (req, res) => {

  // Health check
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "OK",
      timestamp: new Date().toISOString(),
      version: "1.0.0",
      country: "BO",
      currency: "BOB",
      uptime: process.uptime(),
    }));
    return;
  }

  // Endpoint MCP — una instancia de McpServer por sesión
  if (req.url === "/mcp") {
    const sessionId = req.headers["mcp-session-id"] as string ?? randomUUID();
    let session = sessions.get(sessionId);

    if (!session) {
      // Crear nuevo servidor MCP para esta sesión
      const server = new McpServer({
        name: "pyme-brain",
        version: "1.0.0",
      });

      // Registrar tools en esta instancia
      registerBITools(server, sheets);
      registerCobrosTools(server, sheets);

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
httpServer.listen(PORT, () => {
  logger.info(`PyME Brain MCP Server iniciado`, {
    message: `✅ Corriendo en http://localhost:${PORT}`,
    data: { port: PORT, country: 'BO', currency: 'BOB' }
  });
  console.log(`✅ PyME Brain MCP Server corriendo en http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   MCP:    http://localhost:${PORT}/mcp`);
  console.log(`   País:   Bolivia (BOB · UTC-4)`);
});