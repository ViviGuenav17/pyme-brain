// Dominio: Inventario y Compras
// Tools para gestión de stock, márgenes, vencimientos y órdenes de compra
// Moneda: BOB (Bolivianos)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SheetsAdapter } from '../adapters/sheets.adapter.js';
import { measureTool } from '../utils/metrics.js';
import { logger } from '../utils/logger.js';
import { idempotencyStore } from '../infra/idempotency.js';
import { randomUUID } from 'crypto';

export function registerInventarioTools(server: McpServer, sheets: SheetsAdapter) {

  server.tool(
    'check_stock_alerts',
    `Revisa el stock actual y segmenta productos por nivel de urgencia incluyendo vencimientos.
    
    CUÁNDO USAR: El dueño pregunta "¿cómo está el inventario?", "¿qué me falta?",
    "¿qué productos están por acabarse?", "¿hay productos por vencer?".
    
    DEVUELVE: Productos en tres segmentos: crítico, alerta y ok. 
    Incluye alertas de vencimiento, lote, almacén y capital inmovilizado.`,
    {},
    async () => {
      const correlationId = randomUUID();
      logger.info('check_stock_alerts iniciado', { correlationId, tool: 'check_stock_alerts' });

      return measureTool('check_stock_alerts', async () => {
        const productos = await sheets.getProductos();
        const hoy = new Date();
        const en90dias = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
        const en30dias = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

        const formatProducto = (p: typeof productos[0]) => ({
          id: p.id,
          producto: p.producto,
          sku: p.sku,
          stock_actual: p.stock_actual,
          punto_reorden: p.punto_reorden,
          unidades_faltantes: Math.max(p.punto_reorden - p.stock_actual, 0),
          capital_inmovilizado_bob: p.stock_actual * p.costo_unitario,
          almacen: p.almacen ?? 'Principal',
          lote: p.lote ?? '-',
          proveedor_id: p.proveedor_id ?? '-',
          fecha_vencimiento: p.fecha_vencimiento ?? '-',
          alerta_vencimiento: p.fecha_vencimiento
            ? new Date(p.fecha_vencimiento) < en30dias
              ? '🔴 Vence en menos de 30 días'
              : new Date(p.fecha_vencimiento) < en90dias
              ? '🟡 Vence en menos de 90 días'
              : null
            : null,
        });

        const criticos = productos.filter(p => p.stock_actual <= p.punto_reorden * 0.5);
        const alerta = productos.filter(p =>
          p.stock_actual > p.punto_reorden * 0.5 && p.stock_actual <= p.punto_reorden
        );
        const ok = productos.filter(p => p.stock_actual > p.punto_reorden);

        // Productos por vencer en 90 días
        const porVencer = productos.filter(p =>
          p.fecha_vencimiento && new Date(p.fecha_vencimiento) < en90dias
        );

        const result = {
          moneda: 'BOB',
          fecha: hoy.toISOString().split('T')[0],
          resumen: {
            total_productos: productos.length,
            criticos: criticos.length,
            en_alerta: alerta.length,
            ok: ok.length,
            por_vencer_90dias: porVencer.length,
          },
          segmentos: {
            critico: {
              descripcion: 'Stock crítico — reposición urgente',
              productos: criticos.map(formatProducto),
            },
            alerta: {
              descripcion: 'Stock bajo — ordenar esta semana',
              productos: alerta.map(formatProducto),
            },
            ok: {
              descripcion: 'Stock suficiente',
              productos: ok.map(formatProducto),
            },
          },
          alertas_vencimiento: porVencer.map(p => ({
            producto: p.producto,
            sku: p.sku,
            fecha_vencimiento: p.fecha_vencimiento,
            stock_actual: p.stock_actual,
            lote: p.lote,
            almacen: p.almacen,
            dias_para_vencer: Math.floor(
              (new Date(p.fecha_vencimiento!).getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24)
            ),
          })),
          estado_general: criticos.length > 0
            ? '🔴 HAY PRODUCTOS EN ESTADO CRÍTICO'
            : alerta.length > 0
            ? '🟡 HAY PRODUCTOS BAJO PUNTO DE REORDEN'
            : '🟢 INVENTARIO EN BUEN ESTADO',
        };

        logger.info('check_stock_alerts completado', {
          correlationId, tool: 'check_stock_alerts',
          data: { criticos: criticos.length, alerta: alerta.length, porVencer: porVencer.length },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'get_margin_report',
    `Calcula el margen bruto por producto y responde qué conviene más vender.
    
    CUÁNDO USAR: El dueño pregunta "¿qué me deja más ganancia?", "¿cuál es mi margen?",
    "¿qué producto es más rentable?", "¿dónde estoy perdiendo plata?".
    
    DEVUELVE: Margen bruto por producto ordenado de mayor a menor rentabilidad,
    con valor de inventario y ganancia potencial total en BOB.`,
    {},
    async () => {
      const correlationId = randomUUID();
      logger.info('get_margin_report iniciado', { correlationId, tool: 'get_margin_report' });

      return measureTool('get_margin_report', async () => {
        const productos = await sheets.getProductos();

        const reporte = productos.map(p => {
          const margen_bob = p.precio_venta - p.costo_unitario;
          const margen_porcentaje = p.precio_venta > 0
            ? Math.round((margen_bob / p.precio_venta) * 100)
            : 0;

          return {
            id: p.id,
            producto: p.producto,
            sku: p.sku,
            almacen: p.almacen ?? 'Principal',
            proveedor_id: p.proveedor_id ?? '-',
            costo_unitario_bob: p.costo_unitario,
            precio_venta_bob: p.precio_venta,
            margen_unitario_bob: margen_bob,
            margen_porcentaje,
            stock_actual: p.stock_actual,
            valor_inventario_bob: p.stock_actual * p.costo_unitario,
            ganancia_potencial_bob: p.stock_actual * margen_bob,
          };
        }).sort((a, b) => b.margen_porcentaje - a.margen_porcentaje);

        const totalInventario = reporte.reduce((s, p) => s + p.valor_inventario_bob, 0);
        const totalGanancia = reporte.reduce((s, p) => s + p.ganancia_potencial_bob, 0);

        const result = {
          moneda: 'BOB',
          resumen: {
            total_productos: reporte.length,
            valor_total_inventario_bob: totalInventario,
            ganancia_potencial_total_bob: totalGanancia,
            margen_promedio_porcentaje: Math.round(
              reporte.reduce((s, p) => s + p.margen_porcentaje, 0) / reporte.length
            ),
          },
          productos_por_rentabilidad: reporte,
          recomendacion: `El producto más rentable es ${reporte[0]?.producto} con ${reporte[0]?.margen_porcentaje}% de margen. ` +
            `El menos rentable es ${reporte[reporte.length - 1]?.producto} con ${reporte[reporte.length - 1]?.margen_porcentaje}% de margen.`,
        };

        logger.info('get_margin_report completado', {
          correlationId, tool: 'get_margin_report',
          data: { total_productos: reporte.length, totalInventario },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'update_stock',
    `Ajusta el stock de un producto — entradas, salidas o mermas.
    
    CUÁNDO USAR: El dueño dice "llegó mercadería", "vendí 10 cajas de detergente",
    "registra la merma", "ajusta el inventario de jabón".
    
    DEVUELVE: Stock actualizado con alerta si queda bajo el punto de reorden.
    Usa request_id para evitar duplicados.`,
    {
      product_id: z.string().describe('ID del producto. Ejemplo: P001'),
      delta: z.number().describe('Cantidad a ajustar. Positivo=entrada, negativo=salida o merma'),
      reason: z.string().describe('Razón del ajuste: venta, compra, merma, ajuste_manual'),
      request_id: z.string().uuid().describe('UUID único para evitar duplicados'),
      dry_run: z.boolean().default(false).describe('Si true simula sin escribir. Default: false'),
    },
    async ({ product_id, delta, reason, request_id, dry_run }) => {
      const correlationId = randomUUID();

      const cached = idempotencyStore.check(request_id);
      if (cached) return cached as any;

      return measureTool('update_stock', async () => {
        const productos = await sheets.getProductos();
        const producto = productos.find(p => p.id === product_id);

        if (!producto) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: `Producto ${product_id} no encontrado` }),
            }],
          };
        }

        const stock_nuevo = producto.stock_actual + delta;
        const alerta_stock = stock_nuevo <= producto.punto_reorden;
        const stock_negativo = stock_nuevo < 0;

        if (stock_negativo) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: `Stock insuficiente. Stock actual: ${producto.stock_actual}, solicitado: ${Math.abs(delta)}`,
              }),
            }],
          };
        }

        const result = {
          status: dry_run ? 'DRY_RUN' : 'OK',
          moneda: 'BOB',
          request_id,
          producto: {
            id: producto.id,
            nombre: producto.producto,
            sku: producto.sku,
            almacen: producto.almacen ?? 'Principal',
            lote: producto.lote ?? '-',
            stock_anterior: producto.stock_actual,
            delta,
            stock_nuevo,
            punto_reorden: producto.punto_reorden,
          },
          alerta_stock: alerta_stock
            ? `⚠️ Stock nuevo (${stock_nuevo}) está bajo el punto de reorden (${producto.punto_reorden})`
            : null,
          reason,
          mensaje: dry_run
            ? `[SIMULACIÓN] Stock de ${producto.producto} cambiaría de ${producto.stock_actual} a ${stock_nuevo} unidades`
            : `✅ Stock de ${producto.producto} actualizado: ${producto.stock_actual} → ${stock_nuevo} unidades`,
        };

        if (!dry_run) {
          await sheets.appendLog({
            timestamp: new Date().toISOString(),
            tool_name: 'update_stock',
            correlation_id: correlationId,
            cliente_id: product_id,
            accion: `Stock ${delta > 0 ? 'entrada' : 'salida'}: ${Math.abs(delta)} unidades · ${producto.producto} · Razón: ${reason}`,
            resultado: `Stock nuevo: ${stock_nuevo} unidades`,
            dry_run: false,
          });
          idempotencyStore.register(request_id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
        }

        logger.info('update_stock completado', {
          correlationId, tool: 'update_stock',
          data: { product_id, delta, stock_nuevo, dry_run },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'generate_purchase_order',
    `Genera una orden de compra para reponer productos bajo el punto de reorden.
    
    CUÁNDO USAR: El dueño dice "pide mercadería", "genera orden de compra",
    "repón el inventario", "necesito pedir al proveedor esta semana".
    
    DEVUELVE: Orden de compra con cantidades óptimas y monto total en BOB.
    Con dry_run=true muestra preview antes de confirmar.`,
    {
      product_ids: z.array(z.string()).describe('IDs de productos a reponer. Ejemplo: ["P001","P002"]'),
      supplier_name: z.string().describe('Nombre del proveedor. Ejemplo: Química Latina Bolivia S.R.L.'),
      urgency: z.enum(['normal', 'urgente']).default('normal').describe('Nivel de urgencia. Default: normal'),
      request_id: z.string().uuid().describe('UUID único para evitar duplicados'),
      dry_run: z.boolean().default(true).describe('Si true muestra preview. Default: true'),
    },
    async ({ product_ids, supplier_name, urgency, request_id, dry_run }) => {
      const correlationId = randomUUID();

      const cached = idempotencyStore.check(request_id);
      if (cached) return cached as any;

      return measureTool('generate_purchase_order', async () => {
        const productos = await sheets.getProductos();
        const productosAReponer = productos.filter(p => product_ids.includes(p.id));

        if (productosAReponer.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'No se encontraron productos con los IDs proporcionados' }),
            }],
          };
        }

        const items = productosAReponer.map(p => {
          const cantidad_optima = Math.max(p.punto_reorden * 2 - p.stock_actual, p.punto_reorden);
          return {
            producto: p.producto,
            sku: p.sku,
            almacen_destino: p.almacen ?? 'Principal',
            proveedor_id: p.proveedor_id ?? '-',
            stock_actual: p.stock_actual,
            punto_reorden: p.punto_reorden,
            cantidad_a_pedir: cantidad_optima,
            costo_unitario_bob: p.costo_unitario,
            subtotal_bob: cantidad_optima * p.costo_unitario,
          };
        });

        const total_bob = items.reduce((s, i) => s + i.subtotal_bob, 0);
        const orden_id = `OC-${Date.now()}`;
        const fecha_entrega_estimada = new Date(
          Date.now() + (urgency === 'urgente' ? 2 : 7) * 24 * 60 * 60 * 1000
        ).toISOString().split('T')[0];

        const result = {
          status: dry_run ? 'DRY_RUN — revisar antes de confirmar' : 'GENERADA',
          orden_id,
          moneda: 'BOB',
          request_id,
          proveedor: supplier_name,
          urgency,
          fecha: new Date().toISOString().split('T')[0],
          fecha_entrega_estimada,
          items,
          total_bob,
          instruccion: dry_run
            ? '👆 Revisa la orden. Si estás de acuerdo ejecuta con dry_run=false para confirmar.'
            : `✅ Orden ${orden_id} generada por Bs. ${total_bob.toLocaleString('es-BO')} a ${supplier_name}. Entrega estimada: ${fecha_entrega_estimada}`,
        };

        if (!dry_run) {
          await sheets.appendLog({
            timestamp: new Date().toISOString(),
            tool_name: 'generate_purchase_order',
            correlation_id: correlationId,
            cliente_id: supplier_name,
            accion: `Orden ${orden_id}: ${items.length} productos · Bs. ${total_bob} · ${supplier_name} · ${urgency}`,
            resultado: 'OK',
            dry_run: false,
          });
          idempotencyStore.register(request_id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
        }

        logger.info('generate_purchase_order completado', {
          correlationId, tool: 'generate_purchase_order',
          data: { total_bob, urgency, items: items.length },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'generate_quote',
    `Genera una cotización para un cliente con precios y descuentos por volumen.
    
    CUÁNDO USAR: El dueño dice "cotiza para Torrico", "¿cuánto le cobro por 50 cajas?",
    "genera una cotización", "¿qué precio le doy si compra bastante?".
    
    DEVUELVE: Cotización detallada con descuento por volumen y mensaje listo para WhatsApp.`,
    {
      client_id: z.string().describe('ID del cliente. Ejemplo: C003'),
      items: z.array(z.object({
        product_id: z.string().describe('ID del producto'),
        cantidad: z.number().positive().describe('Cantidad solicitada'),
      })).describe('Lista de productos y cantidades a cotizar'),
      descuento_porcentaje: z.number().min(0).max(30).default(0).describe(
        'Descuento adicional en %. Default: 0'
      ),
    },
    async ({ client_id, items, descuento_porcentaje }) => {
      const correlationId = randomUUID();
      logger.info('generate_quote iniciado', { correlationId, tool: 'generate_quote', clientId: client_id });

      return measureTool('generate_quote', async () => {
        const [clientes, productos] = await Promise.all([
          sheets.getClientes(),
          sheets.getProductos(),
        ]);

        const cliente = clientes.find(c => c.id === client_id);
        if (!cliente) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: `Cliente ${client_id} no encontrado` }),
            }],
          };
        }

        const productoMap = new Map(productos.map(p => [p.id, p]));

        const lineas = items.map(item => {
          const producto = productoMap.get(item.product_id);
          if (!producto) return null;

          // Descuento automático por volumen
          let descuento_volumen = 0;
          if (item.cantidad >= 100) descuento_volumen = 10;
          else if (item.cantidad >= 50) descuento_volumen = 5;
          else if (item.cantidad >= 20) descuento_volumen = 3;

          const descuento_total = Math.min(descuento_volumen + descuento_porcentaje, 30);
          const precio_con_descuento = producto.precio_venta * (1 - descuento_total / 100);
          const subtotal = precio_con_descuento * item.cantidad;

          return {
            producto: producto.producto,
            sku: producto.sku,
            cantidad: item.cantidad,
            precio_unitario_bob: producto.precio_venta,
            descuento_volumen_porcentaje: descuento_volumen,
            descuento_adicional_porcentaje: descuento_porcentaje,
            descuento_total_porcentaje: descuento_total,
            precio_con_descuento_bob: Math.round(precio_con_descuento * 100) / 100,
            subtotal_bob: Math.round(subtotal * 100) / 100,
            stock_disponible: producto.stock_actual,
            disponible: producto.stock_actual >= item.cantidad,
            almacen: producto.almacen ?? 'Principal',
          };
        }).filter(Boolean);

        const subtotal_bob = lineas.reduce((s, l) => s + (l?.subtotal_bob ?? 0), 0);
        const cotizacion_id = `COT-${Date.now()}`;
        const valida_hasta = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        const result = {
          cotizacion_id,
          moneda: 'BOB',
          fecha: new Date().toISOString().split('T')[0],
          valida_hasta,
          cliente: {
            id: cliente.id,
            nombre: cliente.nombre,
            telefono: cliente.telefono,
            ciudad: cliente.ciudad,
            tipo_cliente: cliente.tipo_cliente,
          },
          lineas,
          subtotal_bob,
          mensaje_whatsapp:
            `Estimado/a ${cliente.nombre}, le enviamos cotización ${cotizacion_id} de Distribuidora El Cóndor:\n\n` +
            lineas.map(l => `• ${l?.cantidad}x ${l?.producto} (${l?.sku}): Bs. ${l?.subtotal_bob}${l?.descuento_total_porcentaje ? ` (${l?.descuento_total_porcentaje}% desc.)` : ''}`).join('\n') +
            `\n\nTOTAL: Bs. ${subtotal_bob.toLocaleString('es-BO')}\nVálida hasta: ${valida_hasta}\n\nPuede cancelar via QR BCB o Tigo Money. ¡Gracias!`,
        };

        logger.info('generate_quote completado', {
          correlationId, tool: 'generate_quote',
          data: { subtotal_bob, lineas: lineas.length },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );
}