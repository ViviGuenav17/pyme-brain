// Métricas de latencia por tool
// Registra cuántas veces se llamó cada tool, cuánto tardó y cuántos errores tuvo
// Al final de la demo se puede mostrar estadísticas reales de performance

interface ToolMetric {
  calls: number;
  totalMs: number;
  errors: number;
}

const metrics: Record<string, ToolMetric> = {};

// Envuelve cualquier tool y mide su latencia automáticamente
export async function measureTool<T>(
  toolName: string,
  fn: () => Promise<T>
): Promise<T> {
  if (!metrics[toolName]) {
    metrics[toolName] = { calls: 0, totalMs: 0, errors: 0 };
  }

  const start = Date.now();

  try {
    const result = await fn();
    metrics[toolName].calls++;
    metrics[toolName].totalMs += Date.now() - start;
    return result;
  } catch (err) {
    metrics[toolName].errors++;
    throw err;
  }
}

// Devuelve un resumen de todas las métricas
export function getMetrics() {
  return Object.entries(metrics).map(([tool, m]) => ({
    tool,
    calls: m.calls,
    avgMs: m.calls > 0 ? Math.round(m.totalMs / m.calls) : 0,
    errorRate: m.calls > 0 ? `${((m.errors / m.calls) * 100).toFixed(1)}%` : '0%',
  }));
}