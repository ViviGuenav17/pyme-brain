// Adapter de WhatsApp Business API — Meta Cloud API v18+
// Multi-tenant: acepta credenciales por empresa (token, phoneNumberId) con fallback a .env (modo demo)
// Patrón idéntico a SheetsAdapter: circuit breaker, retry con backoff, cache con TTL, logging estructurado

import { CircuitBreaker } from '../infra/circuit-breaker.js';
import { withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import { cache } from '../infra/cache.js';

const GRAPH_API_VERSION = 'v18.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export interface WhatsAppMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  type: 'text' | 'image' | 'document' | 'audio' | 'video' | 'template' | 'unknown';
  timestamp: string;
  direction: 'inbound' | 'outbound';
  status?: 'sent' | 'delivered' | 'read' | 'failed';
}

export interface WhatsAppContact {
  telefono: string;
  nombre?: string;
  ultimo_mensaje?: string;
  ultimo_mensaje_fecha?: string;
  no_leidos: number;
}

export interface SendMessageResult {
  message_id: string;
  to: string;
  status: 'sent' | 'failed';
  timestamp: string;
}

export interface WhatsAppCredentials {
  token: string;
  phoneNumberId: string;
  businessAccountId?: string;
}

/**
 * Adapter de WhatsApp Business API.
 *
 * Multi-tenant: si se pasan credenciales (auth?: WhatsAppCredentials) las usa.
 * Si no, cae a las variables de entorno (modo demo / fallback) — mismo patrón
 * que SheetsAdapter con auth?: any y GOOGLE_REFRESH_TOKEN.
 */
export class WhatsAppAdapter {
  private breaker = new CircuitBreaker('WhatsApp');
  private readonly token: string;
  private readonly phoneNumberId: string;
  private readonly businessAccountId?: string;
  private readonly configured: boolean;

  // Almacén en memoria de mensajes inbound recibidos (en producción real
  // esto vendría de un webhook persistido en PostgreSQL; para la demo el
  // historial completo se reconstruye via Graph API + este buffer local)
  private static inboundBuffer: WhatsAppMessage[] = [];

  constructor(auth?: WhatsAppCredentials) {
    this.token = auth?.token ?? process.env.WHATSAPP_TOKEN ?? '';
    this.phoneNumberId = auth?.phoneNumberId ?? process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
    this.businessAccountId = auth?.businessAccountId ?? process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;

    this.configured = Boolean(this.token && this.phoneNumberId);

    if (!this.configured) {
      logger.warn('WhatsAppAdapter inicializado sin credenciales — tools devolverán SKIP', {
        data: { hasToken: Boolean(this.token), hasPhoneNumberId: Boolean(this.phoneNumberId) },
      });
    }
  }

  isConfigured(): boolean {
    return this.configured;
  }

  /**
   * Normaliza un número a formato internacional E.164 sin '+', como exige
   * la Graph API. Acepta números con prefijo +591, 591 o sin prefijo.
   */
  private normalizePhone(phone: string): string {
    let clean = phone.replace(/[^0-9]/g, '');
    if (!clean.startsWith('591') && clean.length <= 8) {
      clean = `591${clean}`;
    }
    return clean;
  }

  private async fetchGraphAPI<T>(
    path: string,
    options: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    if (!this.configured) {
      throw new Error('WhatsApp no configurado — falta WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID');
    }

    return this.breaker.call(() =>
      withRetry(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);

        try {
          const response = await fetch(`${GRAPH_API_BASE}/${path}`, {
            method: options.method ?? 'GET',
            headers: {
              Authorization: `Bearer ${this.token}`,
              'Content-Type': 'application/json',
            },
            body: options.body ? JSON.stringify(options.body) : undefined,
            signal: controller.signal,
          });

          if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Meta Graph API error ${response.status}: ${errorBody}`);
          }

          return (await response.json()) as T;
        } finally {
          clearTimeout(timer);
        }
      })
    );
  }

  /**
   * Envía un mensaje de texto libre. Solo funciona dentro de la ventana de
   * 24h de conversación abierta por el cliente (regla de Meta). Para
   * mensajes fuera de esa ventana, usar sendTemplate().
   */
  async sendTextMessage(to: string, body: string): Promise<SendMessageResult> {
    const toNormalized = this.normalizePhone(to);

    const data = await this.fetchGraphAPI<{ messages: Array<{ id: string }> }>(
      `${this.phoneNumberId}/messages`,
      {
        method: 'POST',
        body: {
          messaging_product: 'whatsapp',
          to: toNormalized,
          type: 'text',
          text: { body },
        },
      }
    );

    const result: SendMessageResult = {
      message_id: data.messages[0].id,
      to: toNormalized,
      status: 'sent',
      timestamp: new Date().toISOString(),
    };

    cache.invalidatePattern(`whatsapp:history:${toNormalized}`);
    logger.info('Mensaje WhatsApp enviado', { data: { to: toNormalized, messageId: result.message_id } });

    return result;
  }

  /**
   * Envía un mensaje usando un template pre-aprobado por Meta.
   * Necesario para iniciar conversación fuera de la ventana de 24h
   * (ej: recordatorios de cobranza, confirmaciones de pedido).
   */
  async sendTemplateMessage(
    to: string,
    templateName: string,
    languageCode = 'es',
    parameters: string[] = []
  ): Promise<SendMessageResult> {
    const toNormalized = this.normalizePhone(to);

    const components = parameters.length > 0
      ? [{ type: 'body', parameters: parameters.map(p => ({ type: 'text', text: p })) }]
      : undefined;

    const data = await this.fetchGraphAPI<{ messages: Array<{ id: string }> }>(
      `${this.phoneNumberId}/messages`,
      {
        method: 'POST',
        body: {
          messaging_product: 'whatsapp',
          to: toNormalized,
          type: 'template',
          template: {
            name: templateName,
            language: { code: languageCode },
            ...(components ? { components } : {}),
          },
        },
      }
    );

    const result: SendMessageResult = {
      message_id: data.messages[0].id,
      to: toNormalized,
      status: 'sent',
      timestamp: new Date().toISOString(),
    };

    logger.info('Template WhatsApp enviado', {
      data: { to: toNormalized, template: templateName, messageId: result.message_id },
    });

    return result;
  }

  /**
   * Envía un mensaje con media (imagen, documento, audio) via URL pública.
   */
  async sendMediaMessage(
    to: string,
    mediaUrl: string,
    mediaType: 'image' | 'document' | 'audio' | 'video',
    caption?: string
  ): Promise<SendMessageResult> {
    const toNormalized = this.normalizePhone(to);

    const mediaPayload: Record<string, unknown> = { link: mediaUrl };
    if (caption && (mediaType === 'image' || mediaType === 'document' || mediaType === 'video')) {
      mediaPayload.caption = caption;
    }

    const data = await this.fetchGraphAPI<{ messages: Array<{ id: string }> }>(
      `${this.phoneNumberId}/messages`,
      {
        method: 'POST',
        body: {
          messaging_product: 'whatsapp',
          to: toNormalized,
          type: mediaType,
          [mediaType]: mediaPayload,
        },
      }
    );

    const result: SendMessageResult = {
      message_id: data.messages[0].id,
      to: toNormalized,
      status: 'sent',
      timestamp: new Date().toISOString(),
    };

    logger.info('Media WhatsApp enviado', {
      data: { to: toNormalized, mediaType, messageId: result.message_id },
    });

    return result;
  }

  /**
   * Registra un mensaje entrante (llamado desde el webhook de Meta).
   * En producción esto se persiste en PostgreSQL; aquí se mantiene un
   * buffer en memoria por sesión del proceso para la demo.
   */
  static recordInboundMessage(message: WhatsAppMessage): void {
    WhatsAppAdapter.inboundBuffer.push(message);
    cache.invalidatePattern(`whatsapp:history:${message.from}`);
  }

  /**
   * Devuelve el historial de mensajes (entrantes + salientes) con un número.
   * Combina el buffer local de inbound con lo que Meta permite consultar.
   *
   * NOTA: La Graph API de Meta NO expone un endpoint para listar mensajes
   * históricos salientes/entrantes arbitrariamente — solo se reciben via
   * webhook en tiempo real. Por eso el historial real depende de que el
   * webhook esté activo y haya ido acumulando mensajes en este buffer
   * (o en PostgreSQL en producción).
   */
  async getConversationHistory(phone: string, limit = 20): Promise<WhatsAppMessage[]> {
    const phoneNormalized = this.normalizePhone(phone);
    const cacheKey = `whatsapp:history:${phoneNormalized}`;

    const cached = cache.get<WhatsAppMessage[]>(cacheKey);
    if (cached) return cached.slice(-limit);

    const history = WhatsAppAdapter.inboundBuffer
      .filter(m => this.normalizePhone(m.from) === phoneNormalized || this.normalizePhone(m.to) === phoneNormalized)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    cache.set(cacheKey, history, 60_000); // TTL corto — 1 min, datos conversacionales cambian rápido
    return history.slice(-limit);
  }

  /**
   * Lista contactos con mensajes no leídos o recientes, agregando el buffer
   * de inbound. Útil para score_and_prioritize_leads y para detectar leads
   * que escribieron y no fueron atendidos.
   */
  async getRecentContacts(): Promise<WhatsAppContact[]> {
    const porTelefono = new Map<string, WhatsAppContact>();

    for (const msg of WhatsAppAdapter.inboundBuffer) {
      if (msg.direction !== 'inbound') continue;
      const tel = this.normalizePhone(msg.from);
      const existing = porTelefono.get(tel);

      if (!existing || new Date(msg.timestamp) > new Date(existing.ultimo_mensaje_fecha ?? 0)) {
        porTelefono.set(tel, {
          telefono: tel,
          ultimo_mensaje: msg.body,
          ultimo_mensaje_fecha: msg.timestamp,
          no_leidos: (existing?.no_leidos ?? 0) + 1,
        });
      } else if (existing) {
        existing.no_leidos += 1;
      }
    }

    return Array.from(porTelefono.values())
      .sort((a, b) => new Date(b.ultimo_mensaje_fecha ?? 0).getTime() - new Date(a.ultimo_mensaje_fecha ?? 0).getTime());
  }

  getStatus() {
    return {
      configured: this.configured,
      phoneNumberId: this.configured ? this.phoneNumberId : null,
      circuitState: this.breaker.getState(),
    };
  }
}