// Cache con TTL e invalidación inteligente
// Guarda resultados de APIs externas por 5 minutos
// Cuando se escribe algo, invalida el cache relacionado inmediatamente

import { logger } from '../utils/logger.js';

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

class CacheManager {
  private store = new Map<string, CacheEntry>();
  private readonly DEFAULT_TTL = 5 * 60 * 1000; // 5 minutos

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    logger.debug(`Cache hit`, { data: { key } });
    return entry.data as T;
  }

  set(key: string, data: unknown, ttlMs = this.DEFAULT_TTL): void {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
    logger.debug(`Cache set`, { data: { key, ttlMs } });
  }

  // Invalida claves específicas — se llama después de cada escritura
  invalidate(...keys: string[]): void {
    keys.forEach(k => {
      this.store.delete(k);
      logger.debug(`Cache invalidado`, { data: { key: k } });
    });
  }

  // Invalida todas las claves que empiecen con un prefijo
  invalidatePattern(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  clear(): void {
    this.store.clear();
  }
}

export const cache = new CacheManager();