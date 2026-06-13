import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import http from "http";
import { SheetsAdapter } from "./adapters/sheets.adapter.js";
import { registerBITools } from "./tools/bi.js";
import { logger } from "./utils/logger.js";

// Inicializar adaptadores
const sheets = new SheetsAdapter();

// Servidor MCP
const server = new McpServer({
  name: "pyme-brain",
  version: "1.0.0",
});

// Registrar tools
registerBITools(server, sheets);

// Mapa de sesiones activas
const transports = new Map<string, StreamableHTTPServerTransport>();

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

  // Endpoint MCP
  if (req.url === "/mcp") {
    const sessionId = req.headers["mcp-session-id"] as string ?? randomUUID();
    let transport = transports.get(sessionId);

    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
      });
      transports.set(sessionId, transport);
      await server.connect(transport);
    }

    await transport.handleRequest(req, res);
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