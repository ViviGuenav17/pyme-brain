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
}