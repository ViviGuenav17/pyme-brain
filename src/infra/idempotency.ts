// IdempotencyStore — evita que una acción se ejecute dos veces
// Si el agente reintenta con el mismo request_id, devuelve el resultado anterior
// Cada entrada expira después de 24 horas

import { logger } from '../utils/logger.js';

interface IdempotencyEntry {
  result: unknown;
  createdAt: number;
  ttlMs: number;
}

class IdempotencyStore {
  private store = new Map<string, IdempotencyEntry>();
  private readonly DEFAULT_TTL = 24 * 60 * 60 * 1000; // 24 horas

  check(requestId: string): unknown | null {
    const entry = this.store.get(requestId);
    if (!entry) return null;

    if (Date.now() - entry.createdAt > entry.ttlMs) {
      this.store.delete(requestId);
      return null;
    }

    logger.info(`Idempotency hit — request_id ya procesado`, { data: { requestId } });
    return entry.result;
  }

  register(requestId: string, result: unknown, ttlMs = this.DEFAULT_TTL): void {
    this.store.set(requestId, { result, createdAt: Date.now(), ttlMs });
  }

  // Limpia entradas expiradas para evitar memory leak
  purgeExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now - entry.createdAt > entry.ttlMs) {
        this.store.delete(key);
      }
    }
  }
}

export const idempotencyStore = new IdempotencyStore();