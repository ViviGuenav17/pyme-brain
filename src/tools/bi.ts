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
  server.tool(
    'get_overdue_clients',
    `Lista clientes con mora superior al umbral definido, ordenados por monto descendente.
    
    CUÁNDO USAR: El dueño pregunta "¿quiénes me deben más?", "dame la lista de morosos",
    "¿quién tiene más días sin pagar?".
    
    CUÁNDO NO USAR: Si quiere análisis de riesgo completo → usar analyze_cashflow_risk.
    Si quiere datos de UN cliente → usar get_client_360.
    
    DEVUELVE: Lista paginada de clientes morosos con monto, días de mora y datos de contacto.`,
    {
      days_threshold: z.number().default(30).describe('Días mínimos de mora. Default: 30'),
      limit: z.number().max(100).default(20).describe('Máximo de resultados. Default: 20'),
      offset: z.number().default(0).describe('Para paginación. Default: 0'),
    },
    async ({ days_threshold, limit, offset }) => {
      const correlationId = randomUUID();
      logger.info('get_overdue_clients iniciado', { correlationId, tool: 'get_overdue_clients' });

      return measureTool('get_overdue_clients', async () => {
        const [clientes, cobros] = await Promise.all([
          sheets.getClientes(),
          sheets.getCobros(),
        ]);

        const clienteMap = new Map(clientes.map(c => [c.id, c]));

        // Filtrar y ordenar por monto descendente
        const morosos = cobros
          .filter(c => c.estado === 'pendiente' && c.dias_mora >= days_threshold)
          .sort((a, b) => b.monto - a.monto);

        // Paginación — decisión #27
        const page = morosos.slice(offset, offset + limit);
        const totalMonto = morosos.reduce((s, c) => s + c.monto, 0);

        const result = {
          moneda: 'BOB',
          days_threshold,
          total: morosos.length,
          total_monto_bob: totalMonto,
          limit,
          offset,
          has_more: offset + limit < morosos.length,
          clientes: page.map(c => ({
            cliente_id: c.cliente_id,
            nombre: clienteMap.get(c.cliente_id)?.nombre ?? c.cliente_id,
            telefono: clienteMap.get(c.cliente_id)?.telefono ?? '',
            ciudad: clienteMap.get(c.cliente_id)?.ciudad ?? '',
            monto_bob: c.monto,
            dias_mora: c.dias_mora,
            fecha_vencimiento: c.fecha_vencimiento,
            notas: c.notas,
          })),
        };

        logger.info('get_overdue_clients completado', {
          correlationId,
          tool: 'get_overdue_clients',
          data: { total: morosos.length, total_monto: totalMonto },
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
  server.tool(
    'detect_anomalies',
    `Detecta patrones inusuales en el negocio — mora inesperada, caída de ventas, stock crítico.
    
    CUÁNDO USAR: El dueño pregunta "¿algo raro está pasando?", "¿hay algún problema?",
    "avísame si algo está mal", o como revisión proactiva matutina del agente.
    
    CUÁNDO NO USAR: Si quiere análisis de caja específico → usar analyze_cashflow_risk.
    
    DEVUELVE: Lista priorizada de anomalías detectadas con nivel de urgencia y acción recomendada.`,
    {},
    async () => {
      const correlationId = randomUUID();
      logger.info('detect_anomalies iniciado', { correlationId, tool: 'detect_anomalies' });

      return measureTool('detect_anomalies', async () => {
        const [clientes, cobros, leads, productos] = await Promise.all([
          sheets.getClientes(),
          sheets.getCobros(),
          sheets.getLeads(),
          sheets.getProductos(),
        ]);

        const anomalias: Array<{
          tipo: string;
          urgencia: 'CRITICA' | 'ALTA' | 'MEDIA';
          descripcion: string;
          accion: string;
          entidad?: string;
        }> = [];

        const clienteMap = new Map(clientes.map(c => [c.id, c]));

        // Anomalía 1 — Clientes con mora crítica (>60 días)
        const moraCritica = cobros.filter(c => c.estado === 'pendiente' && c.dias_mora > 60);
        moraCritica.forEach(c => {
          const cliente = clienteMap.get(c.cliente_id);
          anomalias.push({
            tipo: 'MORA_CRITICA',
            urgencia: 'CRITICA',
            descripcion: `${cliente?.nombre ?? c.cliente_id} tiene ${c.dias_mora} días de mora por Bs. ${c.monto.toLocaleString('es-BO')}`,
            accion: 'Contactar hoy. Considerar suspender crédito.',
            entidad: c.cliente_id,
          });
        });

        // Anomalía 2 — Productos agotados o bajo punto crítico
        const productosCriticos = productos.filter(p => p.stock_actual <= p.punto_reorden * 0.5);
        productosCriticos.forEach(p => {
          anomalias.push({
            tipo: 'STOCK_CRITICO',
            urgencia: p.stock_actual === 0 ? 'CRITICA' : 'ALTA',
            descripcion: `${p.producto} tiene solo ${p.stock_actual} unidades (punto de reorden: ${p.punto_reorden})`,
            accion: p.stock_actual === 0
              ? 'Producto agotado — ordenar reposición urgente.'
              : 'Stock bajo — generar orden de compra esta semana.',
            entidad: p.id,
          });
        });

        // Anomalía 3 — Leads sin contacto por más de 14 días
        const hoy = new Date();
        const leadsFrios = leads.filter(l => {
          const diasSinContacto = Math.floor(
            (hoy.getTime() - new Date(l.fecha_ultimo_contacto).getTime()) / (1000 * 60 * 60 * 24)
          );
          return diasSinContacto > 14 && l.etapa !== 'ganado' && l.etapa !== 'perdido';
        });

        if (leadsFrios.length > 0) {
          anomalias.push({
            tipo: 'LEADS_FRIOS',
            urgencia: 'MEDIA',
            descripcion: `${leadsFrios.length} lead(s) sin contacto por más de 14 días: ${leadsFrios.map(l => l.nombre).join(', ')}`,
            accion: 'Enviar mensaje de seguimiento esta semana.',
          });
        }

        // Anomalía 4 — Clientes con score bajo y crédito alto
        const clientesRiesgo = clientes.filter(c => c.score_pago < 50 && c.credito_limite > 30000);
        clientesRiesgo.forEach(c => {
          anomalias.push({
            tipo: 'RIESGO_CREDITICIO',
            urgencia: 'ALTA',
            descripcion: `${c.nombre} tiene score de pago ${c.score_pago}/100 con límite de crédito Bs. ${c.credito_limite.toLocaleString('es-BO')}`,
            accion: 'Revisar límite de crédito. Considerar reducción.',
            entidad: c.id,
          });
        });

        // Ordenar por urgencia
        const orden = { CRITICA: 0, ALTA: 1, MEDIA: 2 };
        anomalias.sort((a, b) => orden[a.urgencia] - orden[b.urgencia]);

        const result = {
          fecha: new Date().toISOString().split('T')[0],
          total_anomalias: anomalias.length,
          criticas: anomalias.filter(a => a.urgencia === 'CRITICA').length,
          altas: anomalias.filter(a => a.urgencia === 'ALTA').length,
          medias: anomalias.filter(a => a.urgencia === 'MEDIA').length,
          anomalias,
          estado_general: anomalias.filter(a => a.urgencia === 'CRITICA').length > 0
            ? '🔴 REQUIERE ATENCIÓN INMEDIATA'
            : anomalias.filter(a => a.urgencia === 'ALTA').length > 0
            ? '🟡 HAY SITUACIONES A ATENDER'
            : '🟢 TODO EN ORDEN',
        };

        logger.info('detect_anomalies completado', {
          correlationId,
          tool: 'detect_anomalies',
          data: { total: anomalias.length },
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
  server.tool(
    'get_best_clients',
    `Rankea los mejores clientes según el criterio elegido.
    
    CUÁNDO USAR: El dueño pregunta "¿quiénes son mis mejores clientes?", 
    "¿a quién le doy más crédito?", "¿quién me compra más?", "¿quién siempre paga puntual?".
    
    DEVUELVE: Lista rankeada de clientes por volumen de compra, puntualidad de pago o score compuesto.`,
    {
      metric: z.enum(['monto', 'score_pago', 'compuesto']).default('compuesto').describe(
        'Criterio de ranking: monto (mayor comprador), score_pago (más puntual), compuesto (ambos). Default: compuesto'
      ),
      limit: z.number().max(20).default(5).describe('Cantidad de clientes a mostrar. Default: 5'),
    },
    async ({ metric, limit }) => {
      const correlationId = randomUUID();
      logger.info('get_best_clients iniciado', { correlationId, tool: 'get_best_clients' });

      return measureTool('get_best_clients', async () => {
        const [clientes, cobros] = await Promise.all([
          sheets.getClientes(),
          sheets.getCobros(),
        ]);

        // Calcular monto total por cliente
        const montoPorCliente = cobros.reduce((acc, c) => {
          acc[c.cliente_id] = (acc[c.cliente_id] || 0) + c.monto;
          return acc;
        }, {} as Record<string, number>);

        // Construir ranking
        const ranking = clientes.map(c => ({
          cliente_id: c.id,
          nombre: c.nombre,
          ciudad: c.ciudad,
          tipo_cliente: c.tipo_cliente,
          score_pago: c.score_pago,
          monto_total_bob: montoPorCliente[c.id] || 0,
          score_compuesto: Math.round(
            (c.score_pago * 0.5) + ((montoPorCliente[c.id] || 0) / 1000 * 0.5)
          ),
        }));

        // Ordenar según métrica
        ranking.sort((a, b) => {
          if (metric === 'monto') return b.monto_total_bob - a.monto_total_bob;
          if (metric === 'score_pago') return b.score_pago - a.score_pago;
          return b.score_compuesto - a.score_compuesto;
        });

        const top = ranking.slice(0, limit);

        const result = {
          moneda: 'BOB',
          metric,
          total_clientes: clientes.length,
          top_clientes: top,
          recomendacion: `Los ${top.length} mejores clientes por ${metric}. ` +
            `Priorizar atención y crédito a: ${top.slice(0, 3).map(c => c.nombre).join(', ')}.`,
        };

        logger.info('get_best_clients completado', {
          correlationId,
          tool: 'get_best_clients',
          data: { metric, total: clientes.length },
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
  server.tool(
    'get_supplier_performance',
    `Analiza el desempeño de proveedores según historial de compras e inventario.
    
    CUÁNDO USAR: El dueño pregunta "¿cómo me ha ido con mis proveedores?",
    "¿qué proveedor es más confiable?", "¿a quién le compro más?".
    
    DEVUELVE: Ranking de proveedores por volumen de productos y valor de inventario.`,
    {},
    async () => {
      const correlationId = randomUUID();
      logger.info('get_supplier_performance iniciado', { correlationId, tool: 'get_supplier_performance' });

      return measureTool('get_supplier_performance', async () => {
        const productos = await sheets.getProductos();

        const proveedores = new Map<string, {
          productos: typeof productos;
          valor_inventario: number;
        }>();

        productos.forEach(p => {
          const prov = p.proveedor_id ?? 'Sin proveedor';
          if (!proveedores.has(prov)) {
            proveedores.set(prov, { productos: [], valor_inventario: 0 });
          }
          const data = proveedores.get(prov)!;
          data.productos.push(p);
          data.valor_inventario += p.stock_actual * p.costo_unitario;
        });

        const ranking = Array.from(proveedores.entries()).map(([proveedor_id, data]) => ({
          proveedor_id,
          total_productos: data.productos.length,
          valor_inventario_bob: data.valor_inventario,
          productos: data.productos.map(p => ({
            producto: p.producto,
            sku: p.sku,
            stock_actual: p.stock_actual,
            costo_unitario_bob: p.costo_unitario,
          })),
          productos_bajo_stock: data.productos.filter(p => p.stock_actual <= p.punto_reorden).length,
        })).sort((a, b) => b.valor_inventario_bob - a.valor_inventario_bob);

        const result = {
          moneda: 'BOB',
          total_proveedores: ranking.length,
          ranking_proveedores: ranking,
          recomendacion: `El proveedor con mayor valor de inventario es ${ranking[0]?.proveedor_id} ` +
            `con Bs. ${ranking[0]?.valor_inventario_bob.toLocaleString('es-BO')} en stock.`,
        };

        logger.info('get_supplier_performance completado', {
          correlationId, tool: 'get_supplier_performance',
          data: { total_proveedores: ranking.length },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'get_revenue_by_channel',
    `Compara leads y ventas potenciales por canal de origen.
    
    CUÁNDO USAR: El dueño pregunta "¿de dónde vienen mis clientes?",
    "¿qué canal me funciona mejor?", "¿debo invertir más en Instagram o WhatsApp?".
    
    DEVUELVE: Leads y valor potencial por canal con recomendación de dónde enfocarse.`,
    {},
    async () => {
      const correlationId = randomUUID();
      logger.info('get_revenue_by_channel iniciado', { correlationId, tool: 'get_revenue_by_channel' });

      return measureTool('get_revenue_by_channel', async () => {
        const [leads, productos] = await Promise.all([
          sheets.getLeads(),
          sheets.getProductos(),
        ]);

        const productoMap = new Map(productos.map(p => [p.producto, p.precio_venta]));
        const canales = [...new Set(leads.map(l => l.canal_origen))];

        const porCanal = canales.map(canal => {
          const enCanal = leads.filter(l => l.canal_origen === canal);
          const ganados = enCanal.filter(l => l.etapa === 'ganado');
          const activos = enCanal.filter(l => l.etapa !== 'ganado' && l.etapa !== 'perdido');
          const valorPotencial = activos.reduce((s, l) => s + (productoMap.get(l.producto_interes) ?? 0), 0);
          const valorGanado = ganados.reduce((s, l) => s + (productoMap.get(l.producto_interes) ?? 0), 0);

          return {
            canal,
            total_leads: enCanal.length,
            leads_activos: activos.length,
            leads_ganados: ganados.length,
            tasa_conversion_porcentaje: enCanal.length > 0
              ? Math.round((ganados.length / enCanal.length) * 100)
              : 0,
            valor_ganado_bob: valorGanado,
            valor_potencial_bob: valorPotencial,
          };
        }).sort((a, b) => b.total_leads - a.total_leads);

        const mejorCanal = [...porCanal].sort((a, b) =>
          b.tasa_conversion_porcentaje - a.tasa_conversion_porcentaje
        )[0];

        const result = {
          moneda: 'BOB',
          total_leads: leads.length,
          por_canal: porCanal,
          mejor_canal_conversion: mejorCanal?.canal ?? '-',
          recomendacion: mejorCanal
            ? `📊 ${mejorCanal.canal} tiene la mejor tasa de conversión (${mejorCanal.tasa_conversion_porcentaje}%). Enfoca más esfuerzo en ese canal.`
            : 'No hay suficientes datos para comparar canales.',
        };

        logger.info('get_revenue_by_channel completado', {
          correlationId, tool: 'get_revenue_by_channel',
          data: { canales: canales.length },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'get_slow_moving_products',
    `Identifica productos con poca rotación que inmovilizan capital.
    
    CUÁNDO USAR: El dueño pregunta "¿qué productos no se venden?",
    "¿qué tengo empolvado en el almacén?", "¿dónde tengo capital inmovilizado?".
    
    DEVUELVE: Productos con exceso de stock y capital inmovilizado en BOB.`,
    {
      threshold_ratio: z.number().min(1).max(10).default(3).describe(
        'Stock actual / punto de reorden. Si es mayor al umbral se considera lento. Default: 3'
      ),
    },
    async ({ threshold_ratio }) => {
      const correlationId = randomUUID();
      logger.info('get_slow_moving_products iniciado', { correlationId, tool: 'get_slow_moving_products' });

      return measureTool('get_slow_moving_products', async () => {
        const productos = await sheets.getProductos();

        const lentos = productos
          .filter(p => p.punto_reorden > 0 && (p.stock_actual / p.punto_reorden) >= threshold_ratio)
          .map(p => ({
            id: p.id,
            producto: p.producto,
            sku: p.sku,
            almacen: p.almacen ?? 'Principal',
            stock_actual: p.stock_actual,
            punto_reorden: p.punto_reorden,
            ratio_stock: Math.round(p.stock_actual / p.punto_reorden * 10) / 10,
            capital_inmovilizado_bob: p.stock_actual * p.costo_unitario,
            fecha_vencimiento: p.fecha_vencimiento ?? '-',
            sugerencia: p.fecha_vencimiento && new Date(p.fecha_vencimiento) < new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
              ? '⚠️ Vence pronto — considerar promoción urgente'
              : '💡 Considerar promoción o reducir próxima orden de compra',
          }))
          .sort((a, b) => b.capital_inmovilizado_bob - a.capital_inmovilizado_bob);

        const totalInmovilizado = lentos.reduce((s, p) => s + p.capital_inmovilizado_bob, 0);

        const result = {
          moneda: 'BOB',
          threshold_ratio,
          total_productos_lentos: lentos.length,
          capital_total_inmovilizado_bob: totalInmovilizado,
          productos: lentos,
          recomendacion: lentos.length > 0
            ? `💰 Tienes Bs. ${totalInmovilizado.toLocaleString('es-BO')} inmovilizados en ${lentos.length} producto(s) de baja rotación. Considera hacer promociones.`
            : '✅ No hay productos con baja rotación significativa.',
        };

        logger.info('get_slow_moving_products completado', {
          correlationId, tool: 'get_slow_moving_products',
          data: { total: lentos.length, totalInmovilizado },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'track_expiring_products',
    `Lista productos que vencen en los próximos 30, 60 y 90 días.
    
    CUÁNDO USAR: El dueño pregunta "¿qué productos están por vencer?",
    "¿tengo productos próximos a caducar?", "¿qué debo vender antes de que venza?".
    
    DEVUELVE: Productos agrupados por urgencia de vencimiento con acción recomendada.`,
    {},
    async () => {
      const correlationId = randomUUID();
      logger.info('track_expiring_products iniciado', { correlationId, tool: 'track_expiring_products' });

      return measureTool('track_expiring_products', async () => {
        const productos = await sheets.getProductos();
        const hoy = new Date();

        const conVencimiento = productos.filter(p => p.fecha_vencimiento);

        const en30dias = conVencimiento.filter(p => {
          const dias = Math.floor((new Date(p.fecha_vencimiento!).getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24));
          return dias >= 0 && dias <= 30;
        });

        const en60dias = conVencimiento.filter(p => {
          const dias = Math.floor((new Date(p.fecha_vencimiento!).getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24));
          return dias > 30 && dias <= 60;
        });

        const en90dias = conVencimiento.filter(p => {
          const dias = Math.floor((new Date(p.fecha_vencimiento!).getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24));
          return dias > 60 && dias <= 90;
        });

        const formatProducto = (p: typeof productos[0]) => {
          const dias = Math.floor((new Date(p.fecha_vencimiento!).getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24));
          return {
            producto: p.producto,
            sku: p.sku,
            lote: p.lote ?? '-',
            almacen: p.almacen ?? 'Principal',
            stock_actual: p.stock_actual,
            fecha_vencimiento: p.fecha_vencimiento,
            dias_para_vencer: dias,
            valor_en_riesgo_bob: p.stock_actual * p.costo_unitario,
          };
        };

        const result = {
          fecha: hoy.toISOString().split('T')[0],
          moneda: 'BOB',
          resumen: {
            vencen_en_30_dias: en30dias.length,
            vencen_en_60_dias: en60dias.length,
            vencen_en_90_dias: en90dias.length,
          },
          urgente_30_dias: {
            descripcion: '🔴 Acción inmediata — promover o liquidar',
            productos: en30dias.map(formatProducto),
          },
          atencion_60_dias: {
            descripcion: '🟡 Planificar promoción esta semana',
            productos: en60dias.map(formatProducto),
          },
          monitoreo_90_dias: {
            descripcion: '🟢 Monitorear — planificar con anticipación',
            productos: en90dias.map(formatProducto),
          },
          estado_general: en30dias.length > 0
            ? '🔴 HAY PRODUCTOS POR VENCER EN MENOS DE 30 DÍAS'
            : en60dias.length > 0
            ? '🟡 HAY PRODUCTOS POR VENCER EN MENOS DE 60 DÍAS'
            : '🟢 SIN VENCIMIENTOS URGENTES',
        };

        logger.info('track_expiring_products completado', {
          correlationId, tool: 'track_expiring_products',
          data: { en30dias: en30dias.length, en60dias: en60dias.length },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );
}