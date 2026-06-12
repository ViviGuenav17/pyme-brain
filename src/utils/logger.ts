// Logger estructurado — registra todo en formato JSON
// Cada log incluye nivel, timestamp, correlationId y datos adicionales
// Esto permite buscar y filtrar logs en producción

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

interface LogEntry {
  level: LogLevel;
  timestamp: string;
  correlationId?: string;
  tool?: string;
  clientId?: string;
  durationMs?: number;
  message: string;
  data?: unknown;
  error?: string;
}

function log(level: LogLevel, message: string, extra?: Partial<LogEntry>) {
  const entry: LogEntry = {
    level,
    timestamp: new Date().toISOString(),
    message,
    ...extra,
  };
  console.log(JSON.stringify(entry));
}

export const logger = {
  info:  (message: string, extra?: Partial<LogEntry>) => log('INFO',  message, extra),
  warn:  (message: string, extra?: Partial<LogEntry>) => log('WARN',  message, extra),
  error: (message: string, extra?: Partial<LogEntry>) => log('ERROR', message, extra),
  debug: (message: string, extra?: Partial<LogEntry>) => log('DEBUG', message, extra),
};