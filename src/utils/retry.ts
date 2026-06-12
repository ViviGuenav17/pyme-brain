// Retry con exponential backoff y jitter
// Si una llamada a API externa falla, reintenta automáticamente
// El jitter evita que múltiples reintentos ocurran exactamente al mismo tiempo

import { logger } from './logger.js';

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1000
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;

      // Backoff exponencial + jitter aleatorio ±20%
      const base = baseDelayMs * Math.pow(2, attempt - 1);
      const jitter = base * 0.2 * Math.random();
      const delay = Math.round(base + jitter);

      logger.warn(`Intento ${attempt} fallido. Reintentando en ${delay}ms...`, {
        data: { attempt, delay, error: String(err) },
      });

      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw new Error('unreachable');
}