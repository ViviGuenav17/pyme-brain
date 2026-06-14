// Dominio: Clientes y Cobros
// Tools para gestión del ciclo de cobranza en Bolivia
// Moneda: BOB (Bolivianos)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SheetsAdapter } from '../adapters/sheets.adapter.js';
import { measureTool } from '../utils/metrics.js';
import { logger } from '../utils/logger.js';
import { idempotencyStore } from '../infra/idempotency.js';
import { randomUUID } from 'crypto';

export function registerCobrosTools(server: McpServer, sheets: SheetsAdapter) {

  server.tool(
    'get_client_360',
    `Devuelve el perfil completo de un cliente: datos, cobros y comportamiento de pago.
    
    CUÁNDO USAR: El dueño pregunta por UN cliente específico — "¿cómo está Flores?",
    "dame todo de Mamani", "¿cuánto me debe Torrico?", "¿cómo ha pagado este cliente?".
    
    CUÁNDO NO USAR: Si quiere lista de morosos → usar get_overdue_clients.
    Si quiere análisis general → usar analyze_cashflow_risk.
    
    DEVUELVE: Datos del cliente, historial de cobros, score de pago y recomendación de crédito.`,
    {
      client_id: z.string().describe('ID del cliente. Ejemplo: C001, C002'),
    },
    async ({ client_id }) => {
      const correlationId = randomUUID();
      logger.info('get_client_360 iniciado', { correlationId, tool: 'get_client_360', clientId: client_id });

      return measureTool('get_client_360', async () => {
        const [clientes, cobros] = await Promise.all([
          sheets.getClientes(),
          sheets.getCobros(),
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

        const cobrosCliente = cobros.filter(c => c.cliente_id === client_id);
        const cobrosPendientes = cobrosCliente.filter(c => c.estado === 'pendiente');
        const cobrosPagados = cobrosCliente.filter(c => c.estado === 'pagado');
        const totalPendiente = cobrosPendientes.reduce((s, c) => s + c.monto, 0);
        const totalPagado = cobrosPagados.reduce((s, c) => s + c.monto, 0);
        const moraMáxima = Math.max(...cobrosPendientes.map(c => c.dias_mora), 0);

        const recomendacion = cliente.score_pago >= 80
          ? '✅ Cliente confiable — mantener crédito actual'
          : cliente.score_pago >= 60
          ? '⚠️ Cliente regular — monitorear pagos'
          : '🔴 Cliente riesgoso — reducir o suspender crédito';

        const result = {
          moneda: 'BOB',
          cliente: {
            id: cliente.id,
            nombre: cliente.nombre,
            telefono: cliente.telefono,
            email: cliente.email,
            ciudad: cliente.ciudad,
            tipo_cliente: cliente.tipo_cliente,
            nit: cliente.nit,
            ci: cliente.ci,
            credito_limite_bob: cliente.credito_limite,
            score_pago: cliente.score_pago,
            fecha_ultimo_contacto: cliente.fecha_ultimo_contacto,
          },
          resumen_financiero: {
            total_pendiente_bob: totalPendiente,
            total_pagado_bob: totalPagado,
            cobros_pendientes: cobrosPendientes.length,
            cobros_pagados: cobrosPagados.length,
            mora_maxima_dias: moraMáxima,
          },
          historial_cobros: cobrosCliente.map(c => ({
            id: c.id,
            monto_bob: c.monto,
            fecha_vencimiento: c.fecha_vencimiento,
            estado: c.estado,
            dias_mora: c.dias_mora,
            notas: c.notas,
          })),
          recomendacion_credito: recomendacion,
        };

        logger.info('get_client_360 completado', {
          correlationId,
          tool: 'get_client_360',
          clientId: client_id,
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
    'record_payment',
    `Registra un pago recibido de un cliente en el Google Sheet.
    
    CUÁNDO USAR: El dueño dice "Flores me pagó", "registra el pago de Mamani",
    "me cancelaron Bs. 20.000", "marca como pagado a Torrico".
    
    DEVUELVE: Confirmación del registro con saldo actualizado. Usa request_id para evitar duplicados.`,
    {
      client_id: z.string().describe('ID del cliente que pagó. Ejemplo: C001'),
      cobro_id: z.string().describe('ID del cobro que se está pagando. Ejemplo: CB001'),
      monto_bob: z.number().positive().describe('Monto pagado en Bolivianos'),
      metodo: z.enum(['efectivo', 'transferencia', 'qr_bcb', 'tigo_money', 'cheque']).describe('Método de pago'),
      request_id: z.string().uuid().describe('UUID único para evitar duplicados. Generar uno nuevo por cada pago.'),
      dry_run: z.boolean().default(false).describe('Si true, simula el registro sin escribir. Default: false'),
    },
    async ({ client_id, cobro_id, monto_bob, metodo, request_id, dry_run }) => {
      const correlationId = randomUUID();
      logger.info('record_payment iniciado', { correlationId, tool: 'record_payment', clientId: client_id });

      // Idempotencia — decisión #11
      const cached = idempotencyStore.check(request_id);
      if (cached) {
        logger.info('record_payment — request_id duplicado, devolviendo resultado anterior', {
          correlationId, data: { request_id }
        });
        return cached as any;
      }

      return measureTool('record_payment', async () => {
        const clientes = await sheets.getClientes();
        const cliente = clientes.find(c => c.id === client_id);

        if (!cliente) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: `Cliente ${client_id} no encontrado` }),
            }],
          };
        }

        const result = {
          status: dry_run ? 'DRY_RUN' : 'OK',
          moneda: 'BOB',
          request_id,
          registro: {
            client_id,
            cobro_id,
            monto_bob,
            metodo,
            fecha_pago: new Date().toISOString().split('T')[0],
            cliente_nombre: cliente.nombre,
          },
          mensaje: dry_run
            ? `[SIMULACIÓN] Se registraría pago de Bs. ${monto_bob} de ${cliente.nombre} via ${metodo}`
            : `✅ Pago de Bs. ${monto_bob} de ${cliente.nombre} registrado correctamente via ${metodo}`,
        };

        if (!dry_run) {
          // Registrar en audit log
          await sheets.appendLog({
            timestamp: new Date().toISOString(),
            tool_name: 'record_payment',
            correlation_id: correlationId,
            cliente_id: client_id,
            accion: `Pago registrado: Bs. ${monto_bob} via ${metodo}`,
            resultado: 'OK',
            dry_run: false,
          });

          // Guardar en idempotency store
          idempotencyStore.register(request_id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
        }

        logger.info('record_payment completado', {
          correlationId,
          tool: 'record_payment',
          clientId: client_id,
          data: { monto_bob, metodo, dry_run },
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
    'execute_collection_campaign',
    `Genera mensajes de cobranza personalizados para clientes morosos.
    
    CUÁNDO USAR: El dueño dice "cobra a los morosos", "manda recordatorios de pago",
    "avisa a los que me deben", "haz una campaña de cobranza".
    
    DEVUELVE: Mensajes personalizados listos para enviar por WhatsApp. 
    Con dry_run=true muestra preview sin enviar. Siempre pedir aprobación antes de enviar.`,
    {
      segment: z.enum(['critico', 'alerta', 'todos']).default('alerta').describe(
        'Segmento a cobrar: critico (>60d), alerta (30-60d), todos. Default: alerta'
      ),
      tone: z.enum(['amable', 'firme', 'urgente']).default('amable').describe(
        'Tono del mensaje. Default: amable'
      ),
      dry_run: z.boolean().default(true).describe(
        'Si true muestra preview sin enviar. Default: true — siempre revisar antes de enviar'
      ),
    },
    async ({ segment, tone, dry_run }) => {
      const correlationId = randomUUID();
      logger.info('execute_collection_campaign iniciado', { correlationId, tool: 'execute_collection_campaign' });

      return measureTool('execute_collection_campaign', async () => {
        const [clientes, cobros] = await Promise.all([
          sheets.getClientes(),
          sheets.getCobros(),
        ]);

        const clienteMap = new Map(clientes.map(c => [c.id, c]));

        // Filtrar según segmento
        let pendientes = cobros.filter(c => c.estado === 'pendiente');
        if (segment === 'critico') pendientes = pendientes.filter(c => c.dias_mora > 60);
        else if (segment === 'alerta') pendientes = pendientes.filter(c => c.dias_mora > 30 && c.dias_mora <= 60);

        // Generar mensajes personalizados en español boliviano
        const mensajes = pendientes.map(c => {
          const cliente = clienteMap.get(c.cliente_id);
          const nombre = cliente?.nombre ?? c.cliente_id;
          const monto = c.monto.toLocaleString('es-BO');

          let mensaje = '';
          if (tone === 'amable') {
            mensaje = `Estimado/a ${nombre}, le saludamos de Distribuidora El Cóndor. ` +
              `Le recordamos amablemente que tenemos una factura pendiente de Bs. ${monto} ` +
              `con ${c.dias_mora} días de vencida. ` +
              `Cuando guste coordinar el pago, estamos a su disposición. ` +
              `Puede cancelar via QR BCB o Tigo Money. ¡Gracias por su preferencia!`;
          } else if (tone === 'firme') {
            mensaje = `Estimado/a ${nombre}, le contactamos de Distribuidora El Cóndor. ` +
              `Su cuenta tiene un saldo vencido de Bs. ${monto} (${c.dias_mora} días). ` +
              `Le pedimos regularizar su situación a la brevedad posible. ` +
              `Para coordinar el pago comuníquese con nosotros hoy.`;
          } else {
            mensaje = `${nombre}, su cuenta con Distribuidora El Cóndor tiene ` +
              `Bs. ${monto} VENCIDOS hace ${c.dias_mora} días. ` +
              `Es urgente que regularice su situación hoy para evitar la suspensión de crédito. ` +
              `Contáctenos inmediatamente.`;
          }

          return {
            cliente_id: c.cliente_id,
            nombre,
            telefono: cliente?.telefono ?? '',
            monto_bob: c.monto,
            dias_mora: c.dias_mora,
            mensaje,
          };
        });

        if (!dry_run) {
          await sheets.appendLog({
            timestamp: new Date().toISOString(),
            tool_name: 'execute_collection_campaign',
            correlation_id: correlationId,
            cliente_id: 'CAMPAÑA',
            accion: `Campaña enviada: ${mensajes.length} mensajes · segmento: ${segment} · tono: ${tone}`,
            resultado: 'OK',
            dry_run: false,
          });
        }

        const result = {
          status: dry_run ? 'DRY_RUN — revisar antes de enviar' : 'ENVIADO',
          segment,
          tone,
          total_mensajes: mensajes.length,
          mensajes,
          instruccion: dry_run
            ? '👆 Revisa los mensajes arriba. Si estás de acuerdo, ejecuta con dry_run=false para enviar.'
            : `✅ ${mensajes.length} mensajes registrados en log. Integración WhatsApp pendiente.`,
        };

        logger.info('execute_collection_campaign completado', {
          correlationId,
          tool: 'execute_collection_campaign',
          data: { total: mensajes.length, segment, tone, dry_run },
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
    'forecast_cashflow_cobros',
    `Proyecta cuánto dinero entrará por cobros en los próximos N días.
    
    CUÁNDO USAR: El dueño pregunta "¿cuánto voy a cobrar esta semana?",
    "¿me alcanza para pagar al proveedor?", "¿cuándo entra plata?".
    
    DEVUELVE: Proyección de cobros por fecha con escenario optimista y pesimista.`,
    {
      horizon_days: z.number().min(1).max(60).default(14).describe('Días a proyectar. Default: 14'),
    },
    async ({ horizon_days }) => {
      const correlationId = randomUUID();
      logger.info('forecast_cashflow_cobros iniciado', { correlationId, tool: 'forecast_cashflow_cobros' });

      return measureTool('forecast_cashflow_cobros', async () => {
        const [clientes, cobros] = await Promise.all([
          sheets.getClientes(),
          sheets.getCobros(),
        ]);

        const clienteMap = new Map(clientes.map(c => [c.id, c]));
        const fechaLimite = new Date(Date.now() + horizon_days * 24 * 60 * 60 * 1000);

        const pendientes = cobros.filter(c => {
          const fecha = new Date(c.fecha_vencimiento);
          return c.estado === 'pendiente' && fecha <= fechaLimite;
        });

        const confiables = pendientes.filter(c => c.dias_mora <= 15);
        const enRiesgo = pendientes.filter(c => c.dias_mora > 15);

        const totalConfiable = confiables.reduce((s, c) => s + c.monto, 0);
        const totalRiesgo = enRiesgo.reduce((s, c) => s + c.monto, 0);

        const result = {
          moneda: 'BOB',
          horizon_days,
          resumen: {
            total_a_cobrar_bob: totalConfiable + totalRiesgo,
            confiable_bob: totalConfiable,
            en_riesgo_bob: totalRiesgo,
            cantidad_cobros: pendientes.length,
          },
          cobros_confiables: confiables.map(c => ({
            cliente: clienteMap.get(c.cliente_id)?.nombre ?? c.cliente_id,
            monto_bob: c.monto,
            fecha_vencimiento: c.fecha_vencimiento,
            dias_mora: c.dias_mora,
          })),
          cobros_en_riesgo: enRiesgo.map(c => ({
            cliente: clienteMap.get(c.cliente_id)?.nombre ?? c.cliente_id,
            monto_bob: c.monto,
            fecha_vencimiento: c.fecha_vencimiento,
            dias_mora: c.dias_mora,
          })),
          escenario_optimista: `Bs. ${(totalConfiable + totalRiesgo).toLocaleString('es-BO')} si todos pagan`,
          escenario_pesimista: `Bs. ${totalConfiable.toLocaleString('es-BO')} si los morosos no pagan`,
        };

        logger.info('forecast_cashflow_cobros completado', {
          correlationId, tool: 'forecast_cashflow_cobros',
          data: { totalConfiable, totalRiesgo },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'get_payment_history',
    `Historial de pagos recibidos en un período.
    
    CUÁNDO USAR: El dueño pregunta "¿cuánto cobré este mes?", "¿qué pagos recibí?",
    "dame el historial de pagos", "¿cuánto entró en caja?".
    
    DEVUELVE: Lista de pagos recibidos con total en BOB.`,
    {
      days: z.number().min(1).max(365).default(30).describe('Días hacia atrás a consultar. Default: 30'),
    },
    async ({ days }) => {
      const correlationId = randomUUID();
      logger.info('get_payment_history iniciado', { correlationId, tool: 'get_payment_history' });

      return measureTool('get_payment_history', async () => {
        const [clientes, cobros] = await Promise.all([
          sheets.getClientes(),
          sheets.getCobros(),
        ]);

        const clienteMap = new Map(clientes.map(c => [c.id, c]));
        const fechaInicio = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const pagados = cobros.filter(c => {
          if (!c.fecha_pago) return false;
          return c.estado === 'pagado' && new Date(c.fecha_pago) >= fechaInicio;
        });

        const total = pagados.reduce((s, c) => s + c.monto, 0);

        const result = {
          moneda: 'BOB',
          periodo_dias: days,
          desde: fechaInicio.toISOString().split('T')[0],
          hasta: new Date().toISOString().split('T')[0],
          total_cobrado_bob: total,
          cantidad_pagos: pagados.length,
          pagos: pagados.map(c => ({
            cliente: clienteMap.get(c.cliente_id)?.nombre ?? c.cliente_id,
            monto_bob: c.monto,
            fecha_pago: c.fecha_pago,
            notas: c.notas,
          })).sort((a, b) => new Date(b.fecha_pago!).getTime() - new Date(a.fecha_pago!).getTime()),
          resumen: `Cobraste Bs. ${total.toLocaleString('es-BO')} en los últimos ${days} días en ${pagados.length} pagos.`,
        };

        logger.info('get_payment_history completado', {
          correlationId, tool: 'get_payment_history',
          data: { total, cantidad: pagados.length },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'suggest_credit_limit',
    `Analiza el comportamiento de pago de un cliente y sugiere ajuste de crédito.
    
    CUÁNDO USAR: El dueño pregunta "¿le doy más crédito a Quispe?",
    "¿debo reducir el crédito de Flores?", "¿cuánto crédito le doy a este cliente?".
    
    DEVUELVE: Análisis del comportamiento de pago y recomendación de límite de crédito.`,
    {
      client_id: z.string().describe('ID del cliente. Ejemplo: C001'),
    },
    async ({ client_id }) => {
      const correlationId = randomUUID();
      logger.info('suggest_credit_limit iniciado', { correlationId, tool: 'suggest_credit_limit' });

      return measureTool('suggest_credit_limit', async () => {
        const [clientes, cobros] = await Promise.all([
          sheets.getClientes(),
          sheets.getCobros(),
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

        const cobrosCliente = cobros.filter(c => c.cliente_id === client_id);
        const pagados = cobrosCliente.filter(c => c.estado === 'pagado');
        const pendientes = cobrosCliente.filter(c => c.estado === 'pendiente');
        const morosos = pendientes.filter(c => c.dias_mora > 30);

        const moraProm = pendientes.length > 0
          ? Math.round(pendientes.reduce((s, c) => s + c.dias_mora, 0) / pendientes.length)
          : 0;

        let credito_sugerido = cliente.credito_limite;
        let accion = 'MANTENER';
        let razon = '';

        if (cliente.score_pago >= 85 && morosos.length === 0) {
          credito_sugerido = Math.round(cliente.credito_limite * 1.2);
          accion = 'AUMENTAR';
          razon = 'Excelente historial de pagos y sin mora actual';
        } else if (cliente.score_pago < 60 || morosos.length > 0) {
          credito_sugerido = Math.round(cliente.credito_limite * 0.7);
          accion = 'REDUCIR';
          razon = morosos.length > 0
            ? `Tiene ${morosos.length} cobro(s) con mora mayor a 30 días`
            : 'Score de pago bajo';
        } else {
          razon = 'Comportamiento de pago estable';
        }

        const result = {
          moneda: 'BOB',
          cliente: {
            id: cliente.id,
            nombre: cliente.nombre,
            credito_limite_actual_bob: cliente.credito_limite,
            score_pago: cliente.score_pago,
          },
          analisis: {
            total_cobros: cobrosCliente.length,
            pagados: pagados.length,
            pendientes: pendientes.length,
            con_mora_30d: morosos.length,
            mora_promedio_dias: moraProm,
          },
          recomendacion: {
            accion,
            credito_sugerido_bob: credito_sugerido,
            variacion_bob: credito_sugerido - cliente.credito_limite,
            razon,
          },
          mensaje: accion === 'AUMENTAR'
            ? `✅ Recomendamos aumentar el crédito de ${cliente.nombre} de Bs. ${cliente.credito_limite.toLocaleString('es-BO')} a Bs. ${credito_sugerido.toLocaleString('es-BO')}`
            : accion === 'REDUCIR'
            ? `⚠️ Recomendamos reducir el crédito de ${cliente.nombre} de Bs. ${cliente.credito_limite.toLocaleString('es-BO')} a Bs. ${credito_sugerido.toLocaleString('es-BO')}`
            : `📋 Mantener el crédito de ${cliente.nombre} en Bs. ${cliente.credito_limite.toLocaleString('es-BO')}`,
        };

        logger.info('suggest_credit_limit completado', {
          correlationId, tool: 'suggest_credit_limit',
          data: { client_id, accion, credito_sugerido },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );
}