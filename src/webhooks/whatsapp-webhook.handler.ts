// Webhook de WhatsApp Business API (Meta Cloud API)
// Escrito para http nativo de Node (mismo estilo que index.ts) — NO Express.
//
// Dos responsabilidades, igual que cualquier webhook de Meta:
//   GET  /webhooks/whatsapp  — verificación única al configurar el webhook
//   POST /webhooks/whatsapp  — Meta empuja aquí cada mensaje entrante
//
// Se importan estas dos funciones en index.ts y se llaman dentro del mismo
// http.createServer((req, res) => {...}) que ya maneja /auth/google, /health, etc.

import http from 'http';
import { WhatsAppAdapter, WhatsAppMessage } from '../adapters/whatsapp.adapter.js';
import { logger } from '../utils/logger.js';

function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const params = new URLSearchParams(url.slice(idx + 1));
  const result: Record<string, string> = {};
  params.forEach((v, k) => result[k] = v);
  return result;
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * GET /webhooks/whatsapp — verificación de Meta.
 * Meta llama esto UNA vez al configurar el webhook en el panel de
 * desarrollador, para confirmar que el endpoint es tuyo.
 */
export function handleWhatsAppWebhookVerify(req: http.IncomingMessage, res: http.ServerResponse): void {
  const query = parseQuery(req.url ?? '');
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  const expectedToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === expectedToken) {
    logger.info('Webhook de WhatsApp verificado correctamente por Meta');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(challenge ?? '');
  } else {
    logger.warn('Verificación de webhook de WhatsApp falló', {
      data: { mode, tokenMatch: token === expectedToken },
    });
    res.writeHead(403);
    res.end();
  }
}

/**
 * POST /webhooks/whatsapp — Meta empuja aquí cada evento: mensajes
 * entrantes, cambios de estado de mensajes salientes (delivered/read), etc.
 */
export async function handleWhatsAppWebhookEvent(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  // Responder 200 lo antes posible — Meta espera respuesta rápida y
  // reintenta el evento si no responde en pocos segundos.
  const rawBody = await readRequestBody(req);
  res.writeHead(200);
  res.end();

  try {
    const payload = JSON.parse(rawBody || '{}');
    const entry = payload?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Mensajes entrantes
    const messages = value?.messages ?? [];
    for (const msg of messages) {
      const inbound: WhatsAppMessage = {
        id: msg.id,
        from: msg.from,
        to: value.metadata?.phone_number_id ?? '',
        body: msg.text?.body ?? msg.button?.text ?? `[${msg.type}]`,
        type: msg.type ?? 'unknown',
        timestamp: new Date(Number(msg.timestamp) * 1000).toISOString(),
        direction: 'inbound',
      };

      WhatsAppAdapter.recordInboundMessage(inbound);

      logger.info('Mensaje WhatsApp entrante recibido', {
        data: { from: inbound.from, type: inbound.type },
      });
    }

    // Actualizaciones de estado de mensajes salientes (sent/delivered/read/failed)
    const statuses = value?.statuses ?? [];
    for (const status of statuses) {
      logger.info('Estado de mensaje WhatsApp actualizado', {
        data: { messageId: status.id, status: status.status, recipient: status.recipient_id },
      });
    }
  } catch (err) {
    // Ya respondimos 200 — solo loguear, nunca lanzar desde acá.
    logger.error('Error procesando webhook de WhatsApp', { error: String(err) });
  }
}