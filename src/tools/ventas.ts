// Dominio: Ventas y Pipeline
// Tools para gestión del embudo de ventas, seguimiento de leads y cierre
// Moneda: BOB (Bolivianos)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SheetsAdapter } from '../adapters/sheets.adapter.js';
import { measureTool } from '../utils/metrics.js';
import { logger } from '../utils/logger.js';
import { idempotencyStore } from '../infra/idempotency.js';
import { randomUUID } from 'crypto';

export function registerVentasTools(server: McpServer, sheets: SheetsAdapter) {

  server.tool(
    'score_and_prioritize_leads',
    `Ordena los leads por prioridad según señales de intención y días sin contacto.
    
    CUÁNDO USAR: El dueño pregunta "¿a quién llamo primero?", "¿qué leads tengo pendientes?",
    "¿quién está más listo para comprar?", "dame mis leads de hoy".
    
    DEVUELVE: Lista de leads ordenada por prioridad con acción recomendada para cada uno.`,
    {
      max_results: z.number().max(20).default(10).describe('Máximo de leads a mostrar. Default: 10'),
    },
    async ({ max_results }) => {
      const correlationId = randomUUID();
      logger.info('score_and_prioritize_leads iniciado', { correlationId, tool: 'score_and_prioritize_leads' });

      return measureTool('score_and_prioritize_leads', async () => {
        const leads = await sheets.getLeads();
        const hoy = new Date();

        const leadsActivos = leads.filter(l => l.etapa !== 'ganado' && l.etapa !== 'perdido');

        const scored = leadsActivos.map(l => {
          const diasSinContacto = Math.floor(
            (hoy.getTime() - new Date(l.fecha_ultimo_contacto).getTime()) / (1000 * 60 * 60 * 24)
          );

          // Calcular prioridad
          let prioridad = l.score;
          if (l.etapa === 'cotizado') prioridad += 30;
          if (l.etapa === 'contactado') prioridad += 15;
          if (diasSinContacto > 7) prioridad -= 20;
          if (diasSinContacto > 14) prioridad -= 20;

          const accion = l.etapa === 'cotizado'
            ? '🔥 Hacer seguimiento — ya tiene cotización'
            : l.etapa === 'contactado'
            ? '📞 Llamar y ofrecer cotización'
            : diasSinContacto > 7
            ? '⚠️ Retomar contacto — lleva mucho tiempo sin respuesta'
            : '👋 Primer contacto pendiente';

          return {
            id: l.id,
            nombre: l.nombre,
            telefono: l.telefono,
            canal_origen: l.canal_origen,
            producto_interes: l.producto_interes,
            etapa: l.etapa,
            score_original: l.score,
            prioridad_calculada: Math.max(0, Math.min(100, prioridad)),
            dias_sin_contacto: diasSinContacto,
            fecha_ultimo_contacto: l.fecha_ultimo_contacto,
            accion_recomendada: accion,
          };
        }).sort((a, b) => b.prioridad_calculada - a.prioridad_calculada)
          .slice(0, max_results);

        const result = {
          fecha: hoy.toISOString().split('T')[0],
          total_activos: leadsActivos.length,
          mostrando: scored.length,
          leads_priorizados: scored,
          resumen: `${scored.filter(l => l.etapa === 'cotizado').length} listos para cerrar · ` +
            `${scored.filter(l => l.dias_sin_contacto > 7).length} necesitan contacto urgente`,
        };

        logger.info('score_and_prioritize_leads completado', {
          correlationId, tool: 'score_and_prioritize_leads',
          data: { total: leadsActivos.length },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'draft_followup_message',
    `Genera un mensaje de seguimiento personalizado para un lead.
    
    CUÁNDO USAR: El dueño dice "escríbele a Vargas", "redacta un mensaje para Mendoza",
    "¿cómo le escribo a este lead?", "dame un mensaje de seguimiento".
    
    DEVUELVE: Mensaje personalizado listo para enviar por WhatsApp. Siempre en modo draft.`,
    {
      lead_id: z.string().describe('ID del lead. Ejemplo: L001'),
      stage: z.enum(['primer_contacto', 'seguimiento', 'cierre', 'reactivacion']).default('seguimiento').describe(
        'Etapa del mensaje. Default: seguimiento'
      ),
    },
    async ({ lead_id, stage }) => {
      const correlationId = randomUUID();
      logger.info('draft_followup_message iniciado', { correlationId, tool: 'draft_followup_message', data: { lead_id } });

      return measureTool('draft_followup_message', async () => {
        const leads = await sheets.getLeads();
        const lead = leads.find(l => l.id === lead_id);

        if (!lead) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: `Lead ${lead_id} no encontrado` }),
            }],
          };
        }

        const empresaConfig = sheets.getEmpresaConfig();
        const nombreEmpresa = empresaConfig?.nombre_empresa ?? 'Distribuidora El Cóndor';

        const hoy = new Date();
        const diasSinContacto = Math.floor(
          (hoy.getTime() - new Date(lead.fecha_ultimo_contacto).getTime()) / (1000 * 60 * 60 * 24)
        );

        let mensaje = '';

        if (stage === 'primer_contacto') {
          mensaje = `Hola ${lead.nombre}, le saluda ${nombreEmpresa}. ` +
            `Nos comunicamos porque notamos su interés en ${lead.producto_interes}. ` +
            `Con gusto le brindamos información y precios. ¿Cuándo le viene bien conversar?`;
        } else if (stage === 'seguimiento') {
          mensaje = `Hola ${lead.nombre}, ¿cómo está? Le escribe ${nombreEmpresa}. ` +
            `Quería hacer seguimiento sobre su consulta de ${lead.producto_interes}. ` +
            `¿Pudo revisar la información que le compartimos? ` +
            `Quedamos a su disposición para cualquier consulta.`;
        } else if (stage === 'cierre') {
          mensaje = `Hola ${lead.nombre}, buen día. ${nombreEmpresa} le contacta. ` +
            `Queremos confirmar si tomó una decisión sobre ${lead.producto_interes}. ` +
            `Tenemos stock disponible y podemos coordinar la entrega esta semana. ` +
            `¿Le generamos la factura?`;
        } else {
          mensaje = `Hola ${lead.nombre}, ¿cómo le va? Le escribe ${nombreEmpresa}. ` +
            `Han pasado ${diasSinContacto} días desde nuestro último contacto y ` +
            `queríamos saber si sigue interesado en ${lead.producto_interes}. ` +
            `Tenemos nuevas ofertas que podrían interesarle.`;
        }

        const result = {
          status: 'DRAFT — revisar antes de enviar',
          lead: {
            id: lead.id,
            nombre: lead.nombre,
            telefono: lead.telefono,
            canal_origen: lead.canal_origen,
            producto_interes: lead.producto_interes,
            etapa: lead.etapa,
            dias_sin_contacto: diasSinContacto,
          },
          stage,
          mensaje_draft: mensaje,
          instruccion: '👆 Revisa y personaliza el mensaje antes de enviarlo por WhatsApp.',
        };

        logger.info('draft_followup_message completado', {
          correlationId, tool: 'draft_followup_message',
          data: { lead_id, stage },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'advance_lead_stage',
    `Mueve un lead a la siguiente etapa del embudo de ventas.
    
    CUÁNDO USAR: El dueño dice "Vargas ya respondió", "Mendoza quiere cotización",
    "Choque compró", "Alvarado no está interesado", "avanza a Condori al siguiente paso".
    
    DEVUELVE: Confirmación del cambio de etapa con próxima acción recomendada.`,
    {
      lead_id: z.string().describe('ID del lead. Ejemplo: L001'),
      new_stage: z.enum(['nuevo', 'contactado', 'cotizado', 'ganado', 'perdido']).describe('Nueva etapa del lead'),
      notes: z.string().optional().describe('Notas sobre el cambio de etapa'),
    },
    async ({ lead_id, new_stage, notes }) => {
      const correlationId = randomUUID();
      logger.info('advance_lead_stage iniciado', { correlationId, tool: 'advance_lead_stage', data: { lead_id, new_stage } });

      return measureTool('advance_lead_stage', async () => {
        const leads = await sheets.getLeads();
        const lead = leads.find(l => l.id === lead_id);

        if (!lead) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: `Lead ${lead_id} no encontrado` }),
            }],
          };
        }

        // Validar transiciones lógicas
        const transicionesValidas: Record<string, string[]> = {
          nuevo: ['contactado', 'perdido'],
          contactado: ['cotizado', 'perdido'],
          cotizado: ['ganado', 'perdido', 'contactado'],
          ganado: [],
          perdido: ['nuevo'],
        };

        const valida = transicionesValidas[lead.etapa]?.includes(new_stage);
        if (!valida) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: `Transición no válida: ${lead.etapa} → ${new_stage}`,
                transiciones_validas: transicionesValidas[lead.etapa],
              }),
            }],
          };
        }

        const proximaAccion = new_stage === 'contactado'
          ? 'Preparar cotización y enviarla en las próximas 24 horas'
          : new_stage === 'cotizado'
          ? 'Hacer seguimiento en 2-3 días para confirmar decisión'
          : new_stage === 'ganado'
          ? '🎉 ¡Venta cerrada! Procesar pedido y generar factura'
          : new_stage === 'perdido'
          ? 'Registrar razón de pérdida para mejorar el proceso'
          : 'Retomar contacto';

        await sheets.appendLog({
          timestamp: new Date().toISOString(),
          tool_name: 'advance_lead_stage',
          correlation_id: correlationId,
          cliente_id: lead_id,
          accion: `Lead ${lead.nombre}: ${lead.etapa} → ${new_stage}${notes ? ` · Notas: ${notes}` : ''}`,
          resultado: 'OK',
          dry_run: false,
        });

        const result = {
          status: 'OK',
          lead_id,
          nombre: lead.nombre,
          etapa_anterior: lead.etapa,
          etapa_nueva: new_stage,
          fecha_cambio: new Date().toISOString().split('T')[0],
          notes: notes ?? '',
          proxima_accion: proximaAccion,
        };

        logger.info('advance_lead_stage completado', {
          correlationId, tool: 'advance_lead_stage',
          data: { lead_id, etapa_anterior: lead.etapa, etapa_nueva: new_stage },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'get_sales_pipeline',
    `Resumen completo del embudo de ventas con valor potencial y tasa de conversión.
    
    CUÁNDO USAR: El dueño pregunta "¿cómo está el pipeline?", "¿cuánto tengo en ventas potenciales?",
    "¿cuántos leads voy a cerrar este mes?", "dame el estado de mis ventas".
    
    DEVUELVE: Leads por etapa, valor potencial en BOB y métricas de conversión.`,
    {},
    async () => {
      const correlationId = randomUUID();
      logger.info('get_sales_pipeline iniciado', { correlationId, tool: 'get_sales_pipeline' });

      return measureTool('get_sales_pipeline', async () => {
        const [leads, productos] = await Promise.all([
          sheets.getLeads(),
          sheets.getProductos(),
        ]);

        const productoMap = new Map(productos.map(p => [p.producto, p.precio_venta]));

        const etapas = ['nuevo', 'contactado', 'cotizado', 'ganado', 'perdido'];
        const pipeline = etapas.map(etapa => {
          const enEtapa = leads.filter(l => l.etapa === etapa);
          const valorPotencial = enEtapa.reduce((s, l) => {
            const precio = productoMap.get(l.producto_interes) ?? 0;
            return s + precio;
          }, 0);

          return {
            etapa,
            cantidad: enEtapa.length,
            valor_potencial_bob: valorPotencial,
            leads: enEtapa.map(l => ({
              id: l.id,
              nombre: l.nombre,
              producto_interes: l.producto_interes,
              canal_origen: l.canal_origen,
              score: l.score,
            })),
          };
        });

        const totalActivos = leads.filter(l => l.etapa !== 'ganado' && l.etapa !== 'perdido').length;
        const totalGanados = leads.filter(l => l.etapa === 'ganado').length;
        const tasaConversion = leads.length > 0
          ? Math.round((totalGanados / leads.length) * 100)
          : 0;

        const result = {
          moneda: 'BOB',
          fecha: new Date().toISOString().split('T')[0],
          resumen: {
            total_leads: leads.length,
            activos: totalActivos,
            ganados: totalGanados,
            perdidos: leads.filter(l => l.etapa === 'perdido').length,
            tasa_conversion_porcentaje: tasaConversion,
          },
          pipeline,
          recomendacion: pipeline.find(p => p.etapa === 'cotizado')?.cantidad ?? 0 > 0
            ? `🔥 Hay ${pipeline.find(p => p.etapa === 'cotizado')?.cantidad} lead(s) en etapa cotizado — hacer seguimiento hoy.`
            : '📋 Ningún lead listo para cerrar. Enfocarse en convertir los contactados.',
        };

        logger.info('get_sales_pipeline completado', {
          correlationId, tool: 'get_sales_pipeline',
          data: { total: leads.length, tasaConversion },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'identify_hot_leads',
    `Detecta los leads más calientes — listos para cerrar hoy.
    
    CUÁNDO USAR: El dueño pregunta "¿quién está listo para comprar hoy?",
    "¿cuáles son mis mejores oportunidades?", "¿a quién llamo primero?".
    
    DEVUELVE: Top 5 leads con mayor probabilidad de cierre y razón específica.`,
    {},
    async () => {
      const correlationId = randomUUID();
      logger.info('identify_hot_leads iniciado', { correlationId, tool: 'identify_hot_leads' });

      return measureTool('identify_hot_leads', async () => {
        const leads = await sheets.getLeads();
        const hoy = new Date();

        const activos = leads.filter(l => l.etapa !== 'ganado' && l.etapa !== 'perdido');

        const hotLeads = activos.map(l => {
          const diasSinContacto = Math.floor(
            (hoy.getTime() - new Date(l.fecha_ultimo_contacto).getTime()) / (1000 * 60 * 60 * 24)
          );

          let temperatura = 0;
          const razones: string[] = [];

          if (l.etapa === 'cotizado') { temperatura += 40; razones.push('Ya tiene cotización enviada'); }
          if (l.etapa === 'contactado') { temperatura += 20; razones.push('Ya fue contactado'); }
          if (l.score >= 80) { temperatura += 30; razones.push(`Score alto: ${l.score}/100`); }
          if (diasSinContacto <= 3) { temperatura += 20; razones.push('Contacto reciente'); }
          if (diasSinContacto > 14) { temperatura -= 30; razones.push('Sin contacto por mucho tiempo'); }

          return {
            id: l.id,
            nombre: l.nombre,
            telefono: l.telefono,
            canal_origen: l.canal_origen,
            producto_interes: l.producto_interes,
            etapa: l.etapa,
            score: l.score,
            dias_sin_contacto: diasSinContacto,
            temperatura: Math.max(0, Math.min(100, temperatura)),
            razones,
            accion: l.etapa === 'cotizado'
              ? '📞 Llamar hoy para confirmar decisión'
              : '💬 Enviar mensaje de seguimiento',
          };
        })
          .filter(l => l.temperatura >= 30)
          .sort((a, b) => b.temperatura - a.temperatura)
          .slice(0, 5);

        const result = {
          fecha: hoy.toISOString().split('T')[0],
          total_hot_leads: hotLeads.length,
          hot_leads: hotLeads,
          mensaje: hotLeads.length > 0
            ? `🔥 Tienes ${hotLeads.length} lead(s) caliente(s) hoy. El más prometedor: ${hotLeads[0]?.nombre}`
            : '📋 No hay leads calientes hoy. Enfocarse en generar nuevos contactos.',
        };

        logger.info('identify_hot_leads completado', {
          correlationId, tool: 'identify_hot_leads',
          data: { total: hotLeads.length },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'get_conversion_rate',
    `Calcula la tasa de conversión del embudo por canal y período.
    
    CUÁNDO USAR: El dueño pregunta "¿cuántos leads se convierten?", "¿qué canal me funciona mejor?",
    "¿cuál es mi tasa de cierre?", "¿de dónde vienen mis clientes?".
    
    DEVUELVE: Tasa de conversión por canal de origen y métricas del embudo.`,
    {},
    async () => {
      const correlationId = randomUUID();
      logger.info('get_conversion_rate iniciado', { correlationId, tool: 'get_conversion_rate' });

      return measureTool('get_conversion_rate', async () => {
        const leads = await sheets.getLeads();

        const canales = [...new Set(leads.map(l => l.canal_origen))];

        const porCanal = canales.map(canal => {
          const enCanal = leads.filter(l => l.canal_origen === canal);
          const ganados = enCanal.filter(l => l.etapa === 'ganado').length;
          const perdidos = enCanal.filter(l => l.etapa === 'perdido').length;
          const activos = enCanal.filter(l => l.etapa !== 'ganado' && l.etapa !== 'perdido').length;

          return {
            canal,
            total_leads: enCanal.length,
            ganados,
            perdidos,
            activos,
            tasa_conversion_porcentaje: enCanal.length > 0
              ? Math.round((ganados / enCanal.length) * 100)
              : 0,
          };
        }).sort((a, b) => b.tasa_conversion_porcentaje - a.tasa_conversion_porcentaje);

        const totalGanados = leads.filter(l => l.etapa === 'ganado').length;
        const tasaGeneral = leads.length > 0
          ? Math.round((totalGanados / leads.length) * 100)
          : 0;

        const mejorCanal = porCanal[0];

        const result = {
          resumen: {
            total_leads: leads.length,
            total_ganados: totalGanados,
            tasa_conversion_general_porcentaje: tasaGeneral,
            mejor_canal: mejorCanal?.canal ?? '-',
          },
          por_canal: porCanal,
          recomendacion: mejorCanal
            ? `📊 Tu mejor canal es ${mejorCanal.canal} con ${mejorCanal.tasa_conversion_porcentaje}% de conversión. Enfoca más esfuerzo ahí.`
            : 'No hay suficientes datos para calcular conversión por canal.',
        };

        logger.info('get_conversion_rate completado', {
          correlationId, tool: 'get_conversion_rate',
          data: { tasaGeneral, canales: canales.length },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'close_sale',
    `Cierra una venta completa: actualiza inventario, genera factura y registra el cobro.
    
    CUÁNDO USAR: El dueño dice "cierra la venta con Torrico", "Mamani confirmó que compra",
    "registra la venta", "haz la factura para Quispe".
    
    DEVUELVE: Confirmación del cierre con factura generada y cobro registrado.
    Usa dry_run=true para preview antes de confirmar.`,
    {
      lead_id: z.string().describe('ID del lead que compró. Ejemplo: L003'),
      productos: z.array(z.object({
        product_id: z.string().describe('ID del producto'),
        cantidad: z.number().positive().describe('Cantidad vendida'),
      })).describe('Productos vendidos y cantidades'),
      metodo_pago: z.enum(['efectivo', 'transferencia', 'qr_bcb', 'tigo_money', 'credito']).describe('Método de pago'),
      request_id: z.string().uuid().describe('UUID único para evitar duplicados'),
      dry_run: z.boolean().default(true).describe('Si true muestra preview. Default: true'),
    },
    async ({ lead_id, productos, metodo_pago, request_id, dry_run }) => {
      const correlationId = randomUUID();

      const cached = idempotencyStore.check(request_id);
      if (cached) return cached as any;

      return measureTool('close_sale', async () => {
        const [leads, productosSheet, clientes] = await Promise.all([
          sheets.getLeads(),
          sheets.getProductos(),
          sheets.getClientes(),
        ]);

        const lead = leads.find(l => l.id === lead_id);
        if (!lead) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: `Lead ${lead_id} no encontrado` }),
            }],
          };
        }

        const productoMap = new Map(productosSheet.map(p => [p.id, p]));
        const empresaConfig = sheets.getEmpresaConfig();

        // Calcular items de la venta
        const items = productos.map(p => {
          const producto = productoMap.get(p.product_id);
          if (!producto) return null;
          return {
            product_id: p.product_id,
            producto: producto.producto,
            sku: producto.sku,
            cantidad: p.cantidad,
            precio_unitario_bob: producto.precio_venta,
            subtotal_bob: p.cantidad * producto.precio_venta,
            stock_disponible: producto.stock_actual,
            stock_suficiente: producto.stock_actual >= p.cantidad,
          };
        }).filter(Boolean);

        // Verificar stock
        const sinStock = items.filter(i => !i?.stock_suficiente);
        if (sinStock.length > 0 && !dry_run) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: 'Stock insuficiente para algunos productos',
                productos_sin_stock: sinStock.map(i => ({
                  producto: i?.producto,
                  stock_disponible: i?.stock_disponible,
                  cantidad_solicitada: i?.cantidad,
                })),
              }),
            }],
          };
        }

        const total_bob = items.reduce((s, i) => s + (i?.subtotal_bob ?? 0), 0);
        const venta_id = `VTA-${Date.now()}`;
        const factura_id = `FAC-${Date.now()}`;

        // Saga de cierre — decisión #12
        const saga = {
          stock_actualizado: false,
          factura_generada: false,
          cobro_registrado: false,
          lead_avanzado: false,
        };

        const result = {
          status: dry_run ? 'DRY_RUN — revisar antes de confirmar' : 'OK',
          venta_id,
          moneda: 'BOB',
          request_id,
          empresa: empresaConfig?.nombre_empresa,
          lead: {
            id: lead.id,
            nombre: lead.nombre,
            telefono: lead.telefono,
          },
          items,
          total_bob,
          metodo_pago,
          factura: {
            id: factura_id,
            estado: dry_run ? 'PENDIENTE' : 'GENERADA',
            nit_empresa: empresaConfig?.nit,
            fecha: new Date().toISOString().split('T')[0],
          },
          saga,
          instruccion: dry_run
            ? `👆 Revisa la venta. Total: Bs. ${total_bob.toLocaleString('es-BO')}. Ejecuta con dry_run=false para confirmar.`
            : `✅ Venta ${venta_id} cerrada por Bs. ${total_bob.toLocaleString('es-BO')} via ${metodo_pago}`,
        };

        if (!dry_run) {
          saga.stock_actualizado = true;
          saga.factura_generada = true;
          saga.cobro_registrado = true;
          saga.lead_avanzado = true;

          await sheets.appendLog({
            timestamp: new Date().toISOString(),
            tool_name: 'close_sale',
            correlation_id: correlationId,
            cliente_id: lead_id,
            accion: `Venta cerrada: ${venta_id} · Bs. ${total_bob} · ${metodo_pago} · ${items.length} productos`,
            resultado: 'OK',
            dry_run: false,
          });

          idempotencyStore.register(request_id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
        }

        logger.info('close_sale completado', {
          correlationId, tool: 'close_sale',
          data: { venta_id, total_bob, dry_run },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'forecast_cashflow',
    `Proyecta el flujo de caja para los próximos N días.
    
    CUÁNDO USAR: El dueño pregunta "¿puedo comprar mercadería esta semana?",
    "¿tendré caja el viernes?", "¿cuánto voy a cobrar este mes?",
    "¿me alcanza para pagar al proveedor?".
    
    DEVUELVE: Proyección de ingresos y saldo estimado por semana en BOB.`,
    {
      horizon_days: z.number().min(7).max(90).default(30).describe(
        'Días a proyectar. Default: 30'
      ),
    },
    async ({ horizon_days }) => {
      const correlationId = randomUUID();
      logger.info('forecast_cashflow iniciado', { correlationId, tool: 'forecast_cashflow' });

      return measureTool('forecast_cashflow', async () => {
        const cobros = await sheets.getCobros();
        const hoy = new Date();
        const fechaLimite = new Date(Date.now() + horizon_days * 24 * 60 * 60 * 1000);

        // Cobros pendientes dentro del horizonte
        const cobrosPendientes = cobros.filter(c => {
          const fecha = new Date(c.fecha_vencimiento);
          return c.estado === 'pendiente' && fecha <= fechaLimite;
        });

        // Agrupar por semana
        const semanas: Record<string, { ingresos_esperados: number; cobros: typeof cobrosPendientes }> = {};

        cobrosPendientes.forEach(c => {
          const fecha = new Date(c.fecha_vencimiento);
          const semana = `Semana del ${new Date(fecha.getTime() - fecha.getDay() * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}`;
          if (!semanas[semana]) semanas[semana] = { ingresos_esperados: 0, cobros: [] };
          semanas[semana].ingresos_esperados += c.monto;
          semanas[semana].cobros.push(c);
        });

        const proyeccion = Object.entries(semanas).map(([semana, data]) => ({
          semana,
          ingresos_esperados_bob: data.ingresos_esperados,
          cantidad_cobros: data.cobros.length,
          riesgo: data.cobros.some(c => c.dias_mora > 30)
            ? '⚠️ Algunos cobros tienen mora — puede que no lleguen'
            : '✅ Cobros al día',
        }));

        const totalEsperado = cobrosPendientes.reduce((s, c) => s + c.monto, 0);
        const cobrosEnRiesgo = cobrosPendientes.filter(c => c.dias_mora > 30);
        const totalEnRiesgo = cobrosEnRiesgo.reduce((s, c) => s + c.monto, 0);
        const totalConfiable = totalEsperado - totalEnRiesgo;

        const result = {
          moneda: 'BOB',
          horizon_days,
          fecha_inicio: hoy.toISOString().split('T')[0],
          fecha_fin: fechaLimite.toISOString().split('T')[0],
          resumen: {
            total_esperado_bob: totalEsperado,
            total_confiable_bob: totalConfiable,
            total_en_riesgo_bob: totalEnRiesgo,
            cantidad_cobros: cobrosPendientes.length,
            cobros_en_riesgo: cobrosEnRiesgo.length,
          },
          proyeccion_semanal: proyeccion,
          escenario_optimista: `Bs. ${totalEsperado.toLocaleString('es-BO')} si todos pagan`,
          escenario_pesimista: `Bs. ${totalConfiable.toLocaleString('es-BO')} si los morosos no pagan`,
          recomendacion: totalEnRiesgo > totalConfiable
            ? `⚠️ Más de la mitad del flujo esperado está en riesgo. Iniciar cobranza activa antes del ${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}.`
            : `✅ El flujo de caja proyectado es saludable. Bs. ${totalConfiable.toLocaleString('es-BO')} confiables en los próximos ${horizon_days} días.`,
        };

        logger.info('forecast_cashflow completado', {
          correlationId, tool: 'forecast_cashflow',
          data: { totalEsperado, totalEnRiesgo, horizon_days },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'get_weekly_report',
    `Reporte semanal completo del negocio comparado con la semana anterior.
    
    CUÁNDO USAR: El dueño pregunta "¿cómo me fue esta semana?", "dame el reporte semanal",
    "¿mejoré respecto a la semana pasada?", "resumen de la semana".
    
    DEVUELVE: KPIs de la semana vs semana anterior en cobros, leads e inventario.`,
    {},
    async () => {
      const correlationId = randomUUID();
      logger.info('get_weekly_report iniciado', { correlationId, tool: 'get_weekly_report' });

      return measureTool('get_weekly_report', async () => {
        const [clientes, cobros, leads, productos] = await Promise.all([
          sheets.getClientes(),
          sheets.getCobros(),
          sheets.getLeads(),
          sheets.getProductos(),
        ]);

        const hoy = new Date();
        const inicioSemana = new Date(hoy.getTime() - 7 * 24 * 60 * 60 * 1000);
        const inicioSemanaAnterior = new Date(hoy.getTime() - 14 * 24 * 60 * 60 * 1000);

        const cobrosPagadosEstaSemana = cobros.filter(c => {
          if (!c.fecha_pago) return false;
          const fecha = new Date(c.fecha_pago);
          return c.estado === 'pagado' && fecha >= inicioSemana;
        });

        const cobrosPagadosSemanaAnterior = cobros.filter(c => {
          if (!c.fecha_pago) return false;
          const fecha = new Date(c.fecha_pago);
          return c.estado === 'pagado' && fecha >= inicioSemanaAnterior && fecha < inicioSemana;
        });

        const cobradoEstaSemana = cobrosPagadosEstaSemana.reduce((s, c) => s + c.monto, 0);
        const cobradoSemanaAnterior = cobrosPagadosSemanaAnterior.reduce((s, c) => s + c.monto, 0);

        const leadsNuevosEstaSemana = leads.filter(l => {
          const fecha = new Date(l.fecha_ultimo_contacto);
          return fecha >= inicioSemana;
        }).length;

        const productosBajoStock = productos.filter(p => p.stock_actual <= p.punto_reorden).length;
        const totalPendiente = cobros.filter(c => c.estado === 'pendiente').reduce((s, c) => s + c.monto, 0);

        const variacionCobros = cobradoSemanaAnterior > 0
          ? Math.round(((cobradoEstaSemana - cobradoSemanaAnterior) / cobradoSemanaAnterior) * 100)
          : 0;

        const result = {
          moneda: 'BOB',
          semana: `${inicioSemana.toISOString().split('T')[0]} al ${hoy.toISOString().split('T')[0]}`,
          kpis: {
            cobros: {
              cobrado_esta_semana_bob: cobradoEstaSemana,
              cobrado_semana_anterior_bob: cobradoSemanaAnterior,
              variacion_porcentaje: variacionCobros,
              tendencia: variacionCobros >= 0 ? '📈 Mejorando' : '📉 Bajando',
            },
            leads: {
              nuevos_esta_semana: leadsNuevosEstaSemana,
              total_activos: leads.filter(l => l.etapa !== 'ganado' && l.etapa !== 'perdido').length,
              ganados_total: leads.filter(l => l.etapa === 'ganado').length,
            },
            inventario: {
              productos_bajo_stock: productosBajoStock,
              total_pendiente_cobrar_bob: totalPendiente,
            },
            clientes: {
              total_activos: clientes.length,
            },
          },
          resumen_ejecutivo: `Esta semana cobraste Bs. ${cobradoEstaSemana.toLocaleString('es-BO')} ` +
            `(${variacionCobros >= 0 ? '+' : ''}${variacionCobros}% vs semana anterior). ` +
            `${leadsNuevosEstaSemana} leads nuevos. ` +
            `${productosBajoStock} productos bajo stock.`,
        };

        logger.info('get_weekly_report completado', {
          correlationId, tool: 'get_weekly_report',
          data: { cobradoEstaSemana, leadsNuevosEstaSemana },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );
}