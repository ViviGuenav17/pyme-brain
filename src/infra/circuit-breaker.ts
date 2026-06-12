// Circuit Breaker — protege el servidor cuando una API externa falla
// Tres estados:
// CLOSED — todo normal, las llamadas pasan
// OPEN — demasiados fallos, devuelve error inmediato sin llamar a la API
// HALF_OPEN — prueba si la API se recuperó

import { logger } from '../utils/logger.js';

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private lastFailTime = 0;
  private readonly THRESHOLD = 3;       // fallos antes de abrir
  private readonly TIMEOUT_MS = 30_000; // tiempo antes de probar recuperación

  constructor(private readonly name: string) {}

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailTime > this.TIMEOUT_MS) {
        this.state = 'HALF_OPEN';
        logger.info(`Circuit ${this.name} en HALF_OPEN — probando recuperación`);
      } else {
        throw new Error(`Circuit ${this.name} OPEN — servicio no disponible temporalmente`);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  private onFailure() {
    this.failures++;
    this.lastFailTime = Date.now();
    if (this.failures >= this.THRESHOLD) {
      this.state = 'OPEN';
      logger.error(`Circuit ${this.name} OPEN — ${this.failures} fallos consecutivos`);
    }
  }

  getState() {
    return { name: this.name, state: this.state, failures: this.failures };
  }
}