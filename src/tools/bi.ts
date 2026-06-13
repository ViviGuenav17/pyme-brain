// Dominio: Inteligencia del Negocio
// Primera tool: get_daily_dashboard
// Lee las 4 pestañas en paralelo y devuelve un resumen completo del negocio
// Es el punto de entrada principal del agente cada mañana

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SheetsAdapter } from '../adapters/sheets.adapter.js';
import { measureTool } from '../utils/metrics.js';
import { logger } from '../utils/logger.js';
import { randomUUID } from 'crypto';

export function registerBITools(server: McpServer, sheets: SheetsAdapter) {

  server.tool(
    'get_daily_dashboard',
    `Devuelve un snapshot completo del estado del negocio para hoy.
    
    CUÁNDO USAR: El dueño pregunta "¿cómo está mi negocio?", "¿qué pasó hoy?", 
    "dame un resumen", "¿cómo estoy?", o al iniciar cualquier conversación.
    
    CUÁNDO NO USAR: Si pregunta por un cliente específico → usar get_client_360.
    Si pregunta por predicción futura → usar forecast_cashflow.
    
    DEVUELVE: Total de cobros pendientes en BOB, clientes con mora, 
    leads activos por etapa, productos bajo punto de reorden y 
    comparación con la semana anterior.`,
    {},
    async () => {
      const correlationId = randomUUID();
      logger.info('get_daily_dashboard iniciado', { correlationId, tool: 'get_daily_dashboard' });

      return measureTool('get_daily_dashboard', async () => {

        // Lee las 4 pestañas en PARALELO — decisión #17
        const [clientes, cobros, leads, productos] = await Promise.all([
          sheets.getClientes(),
          sheets.getCobros(),
          sheets.getLeads(),
          sheets.getProductos(),
        ]);

        // Análisis de cobros
        const cobrosPendientes = cobros.filter(c => c.estado === 'pendiente');
        const totalPendiente = cobrosPendientes.reduce((s, c) => s + c.monto, 0);
        const clientesEnMora = cobrosPendientes.filter(c => c.dias_mora > 30).length;
        const moraCritica = cobrosPendientes.filter(c => c.dias_mora > 60).length;

        // Análisis de leads
        const leadsPorEtapa = leads.reduce((acc, l) => {
          acc[l.etapa] = (acc[l.etapa] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);

        // Análisis de inventario
        const productosEnAlerta = productos.filter(
          p => p.stock_actual <= p.punto_reorden
        );
        const productosCriticos = productos.filter(
          p => p.stock_actual === 0
        );

        const dashboard = {
          fecha: new Date().toISOString().split('T')[0],
          moneda: 'BOB',
          cobros: {
            total_pendiente_bob: totalPendiente,
            cantidad_pendientes: cobrosPendientes.length,
            clientes_en_mora_30d: clientesEnMora,
            clientes_mora_critica_60d: moraCritica,
          },
          leads: {
            total_activos: leads.length,
            por_etapa: leadsPorEtapa,
          },
          inventario: {
            productos_en_alerta: productosEnAlerta.length,
            productos_criticos: productosCriticos.length,
            detalle_alerta: productosEnAlerta.map(p => ({
              producto: p.producto,
              stock_actual: p.stock_actual,
              punto_reorden: p.punto_reorden,
            })),
          },
          resumen_texto: `Tienes Bs. ${totalPendiente.toLocaleString('es-BO')} en cobros pendientes. ` +
            `${clientesEnMora} clientes con mora mayor a 30 días. ` +
            `${leads.length} leads activos. ` +
            `${productosEnAlerta.length} productos bajo punto de reorden.`,
        };

        logger.info('get_daily_dashboard completado', {
          correlationId,
          tool: 'get_daily_dashboard',
          data: { total_pendiente: totalPendiente, leads: leads.length },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(dashboard, null, 2),
          }],
        };
      });
    }
  );
  server.tool(
    'analyze_cashflow_risk',
    `Analiza el riesgo de flujo de caja para los próximos N días.
    
    CUÁNDO USAR: El dueño pregunta "¿cómo está mi caja?", "¿quién me debe?",
    "¿voy a tener problemas de liquidez?", "muéstrame los morosos".
    
    CUÁNDO NO USAR: Si pregunta por UN cliente específico → usar get_client_360.
    Si pregunta por predicción futura → usar forecast_cashflow.
    
    DEVUELVE: Clientes en tres segmentos: critico (mora >60d), alerta (mora >30d),
    ok. Monto total en riesgo en BOB. Días promedio de mora por segmento.`,
    {
      horizon_days: z.number().min(1).max(365).default(30).describe(
        'Días hacia adelante para analizar. Default: 30'
      ),
    },
    async ({ horizon_days }) => {
      const correlationId = randomUUID();
      logger.info('analyze_cashflow_risk iniciado', { correlationId, tool: 'analyze_cashflow_risk' });

      return measureTool('analyze_cashflow_risk', async () => {
        const [clientes, cobros] = await Promise.all([
          sheets.getClientes(),
          sheets.getCobros(),
        ]);

        const clienteMap = new Map(clientes.map(c => [c.id, c]));
        const pendientes = cobros.filter(c => c.estado === 'pendiente');

        // Segmentar por nivel de mora
        const criticos = pendientes.filter(c => c.dias_mora > 60);
        const alerta = pendientes.filter(c => c.dias_mora > 30 && c.dias_mora <= 60);
        const ok = pendientes.filter(c => c.dias_mora <= 30);

        const formatSegmento = (cobros: typeof pendientes) =>
          cobros.map(c => ({
            cliente: clienteMap.get(c.cliente_id)?.nombre ?? c.cliente_id,
            telefono: clienteMap.get(c.cliente_id)?.telefono ?? '',
            ciudad: clienteMap.get(c.cliente_id)?.ciudad ?? '',
            monto_bob: c.monto,
            dias_mora: c.dias_mora,
            notas: c.notas,
          }));

        const totalEnRiesgo = [...criticos, ...alerta].reduce((s, c) => s + c.monto, 0);

        const result = {
          moneda: 'BOB',
          horizon_days,
          resumen: {
            total_en_riesgo_bob: totalEnRiesgo,
            criticos: criticos.length,
            en_alerta: alerta.length,
            al_dia: ok.length,
          },
          segmentos: {
            critico: {
              descripcion: 'Mora mayor a 60 días — acción inmediata',
              clientes: formatSegmento(criticos),
              total_bob: criticos.reduce((s, c) => s + c.monto, 0),
            },
            alerta: {
              descripcion: 'Mora entre 30 y 60 días — seguimiento urgente',
              clientes: formatSegmento(alerta),
              total_bob: alerta.reduce((s, c) => s + c.monto, 0),
            },
            ok: {
              descripcion: 'Al día o mora menor a 30 días',
              clientes: formatSegmento(ok),
              total_bob: ok.reduce((s, c) => s + c.monto, 0),
            },
          },
          recomendacion: criticos.length > 0
            ? `⚠️ Hay ${criticos.length} cliente(s) en estado crítico. Iniciar campaña de cobranza inmediata.`
            : alerta.length > 0
            ? `📋 Hay ${alerta.length} cliente(s) en alerta. Contactar esta semana.`
            : '✅ Flujo de caja en buen estado.',
        };

        logger.info('analyze_cashflow_risk completado', {
          correlationId,
          tool: 'analyze_cashflow_risk',
          data: { total_en_riesgo: totalEnRiesgo },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          }],
        };
      });
    }
  );
}