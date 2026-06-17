// Dominio: WhatsApp
// Tools para envío, recepción y gestión de mensajes vía WhatsApp Business API (Meta Cloud API)
// Multi-tenant: el adapter ya viene resuelto por empresa desde tenant.ts

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WhatsAppAdapter } from '../adapters/whatsapp.adapter.js';
import { SheetsAdapter } from '../adapters/sheets.adapter.js';
import { measureTool } from '../utils/metrics.js';
import { logger } from '../utils/logger.js';
import { idempotencyStore } from '../infra/idempotency.js';
import { randomUUID } from 'crypto';

export function registerWhatsappTools(server: McpServer, whatsapp: WhatsAppAdapter, sheets: SheetsAdapter) {

  // Helper interno — todas las tools de acción comparten esta verificación
  function notConfiguredResponse() {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'SKIP',
          error: 'WhatsApp no está configurado para esta empresa. Falta WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID.',
        }),
      }],
    };
  }

  server.tool(
    'send_whatsapp_message',
    `Envía un mensaje de texto libre por WhatsApp a un número.
    
    CUÁNDO USAR: El dueño dice "mándale un WhatsApp a Torrico diciendo...",
    "avísale a Mamani que...", "escríbele por WhatsApp a este número".
    
    CUÁNDO NO USAR: Si el cliente no escribió en las últimas 24 horas → usar
    send_whatsapp_template (Meta bloquea mensajes libres fuera de esa ventana).
    Para enviar a varios clientes a la vez → usar create_whatsapp_broadcast.
    
    DEVUELVE: Confirmación de envío con ID del mensaje. Usa request_id para evitar duplicados.`,
    {
      to: z.string().describe('Número de teléfono del destinatario. Ejemplo: 70012345 o +59170012345'),
      message: z.string().min(1).max(4096).describe('Texto del mensaje a enviar'),
      request_id: z.string().uuid().describe('UUID único para evitar duplicados'),
      dry_run: z.boolean().default(false).describe('Si true, simula el envío sin enviar realmente. Default: false'),
    },
    async ({ to, message, request_id, dry_run }) => {
      const correlationId = randomUUID();
      logger.info('send_whatsapp_message iniciado', { correlationId, tool: 'send_whatsapp_message', data: { to } });

      const cached = idempotencyStore.check(request_id);
      if (cached) return cached as any;

      if (!whatsapp.isConfigured()) return notConfiguredResponse();

      return measureTool('send_whatsapp_message', async () => {
        let result: any;

        if (dry_run) {
          result = {
            status: 'DRY_RUN',
            request_id,
            to,
            mensaje: message,
            instruccion: `[SIMULACIÓN] Se enviaría a ${to}: "${message}"`,
          };
        } else {
          try {
            const sendResult = await whatsapp.sendTextMessage(to, message);
            result = {
              status: 'OK',
              request_id,
              message_id: sendResult.message_id,
              to: sendResult.to,
              timestamp: sendResult.timestamp,
              mensaje: `✅ Mensaje enviado a ${to}`,
            };

            await sheets.appendLog({
              timestamp: new Date().toISOString(),
              tool_name: 'send_whatsapp_message',
              correlation_id: correlationId,
              cliente_id: to,
              accion: `Mensaje WhatsApp enviado: "${message.slice(0, 100)}${message.length > 100 ? '...' : ''}"`,
              resultado: 'OK',
              dry_run: false,
            });

            idempotencyStore.register(request_id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
          } catch (err) {
            result = { status: 'ERROR', error: String(err), request_id };
            logger.error('send_whatsapp_message falló', { correlationId, error: String(err) });
          }
        }

        logger.info('send_whatsapp_message completado', {
          correlationId, tool: 'send_whatsapp_message', data: { to, dry_run, status: result.status },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'send_whatsapp_template',
    `Envía un mensaje usando una plantilla pre-aprobada por Meta.
    
    CUÁNDO USAR: Necesitas iniciar conversación con un cliente que NO te escribió
    en las últimas 24 horas (recordatorio de cobro, confirmación de pedido,
    notificación proactiva). Meta exige plantillas para estos casos.
    
    CUÁNDO NO USAR: Si el cliente ya escribió recientemente → usar send_whatsapp_message,
    es más simple y no requiere plantilla aprobada.
    
    DEVUELVE: Confirmación de envío. La plantilla debe existir y estar aprobada en Meta Business Manager.`,
    {
      to: z.string().describe('Número de teléfono del destinatario'),
      template_name: z.string().describe('Nombre exacto de la plantilla aprobada en Meta. Ejemplo: recordatorio_cobro'),
      language_code: z.string().default('es').describe('Código de idioma de la plantilla. Default: es'),
      parameters: z.array(z.string()).default([]).describe(
        'Valores para las variables {{1}}, {{2}}, etc. de la plantilla, en orden'
      ),
      request_id: z.string().uuid().describe('UUID único para evitar duplicados'),
      dry_run: z.boolean().default(false).describe('Si true, simula sin enviar. Default: false'),
    },
    async ({ to, template_name, language_code, parameters, request_id, dry_run }) => {
      const correlationId = randomUUID();
      logger.info('send_whatsapp_template iniciado', {
        correlationId, tool: 'send_whatsapp_template', data: { to, template_name },
      });

      const cached = idempotencyStore.check(request_id);
      if (cached) return cached as any;

      if (!whatsapp.isConfigured()) return notConfiguredResponse();

      return measureTool('send_whatsapp_template', async () => {
        let result: any;

        if (dry_run) {
          result = {
            status: 'DRY_RUN',
            request_id,
            to,
            template_name,
            parameters,
            instruccion: `[SIMULACIÓN] Se enviaría plantilla "${template_name}" a ${to} con parámetros: ${parameters.join(', ')}`,
          };
        } else {
          try {
            const sendResult = await whatsapp.sendTemplateMessage(to, template_name, language_code, parameters);
            result = {
              status: 'OK',
              request_id,
              message_id: sendResult.message_id,
              to: sendResult.to,
              template_name,
              timestamp: sendResult.timestamp,
              mensaje: `✅ Plantilla "${template_name}" enviada a ${to}`,
            };

            await sheets.appendLog({
              timestamp: new Date().toISOString(),
              tool_name: 'send_whatsapp_template',
              correlation_id: correlationId,
              cliente_id: to,
              accion: `Plantilla "${template_name}" enviada con parámetros: ${parameters.join(', ')}`,
              resultado: 'OK',
              dry_run: false,
            });

            idempotencyStore.register(request_id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
          } catch (err) {
            result = {
              status: 'ERROR',
              error: String(err),
              request_id,
              nota: 'Verifica que la plantilla exista y esté aprobada en Meta Business Manager.',
            };
            logger.error('send_whatsapp_template falló', { correlationId, error: String(err) });
          }
        }

        logger.info('send_whatsapp_template completado', {
          correlationId, tool: 'send_whatsapp_template', data: { to, template_name, dry_run, status: result.status },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'send_whatsapp_media',
    `Envía una imagen, documento, audio o video por WhatsApp.
    
    CUÁNDO USAR: El dueño dice "envíale el catálogo a Flores", "mándale la foto del producto",
    "envía el PDF de la factura por WhatsApp", "comparte el comprobante QR".
    
    DEVUELVE: Confirmación de envío. La URL del media debe ser pública y accesible.`,
    {
      to: z.string().describe('Número de teléfono del destinatario'),
      media_url: z.string().url().describe('URL pública del archivo a enviar (imagen, PDF, audio, video)'),
      media_type: z.enum(['image', 'document', 'audio', 'video']).describe('Tipo de archivo'),
      caption: z.string().optional().describe('Texto que acompaña al archivo (no aplica a audio)'),
      request_id: z.string().uuid().describe('UUID único para evitar duplicados'),
      dry_run: z.boolean().default(false).describe('Si true, simula sin enviar. Default: false'),
    },
    async ({ to, media_url, media_type, caption, request_id, dry_run }) => {
      const correlationId = randomUUID();
      logger.info('send_whatsapp_media iniciado', {
        correlationId, tool: 'send_whatsapp_media', data: { to, media_type },
      });

      const cached = idempotencyStore.check(request_id);
      if (cached) return cached as any;

      if (!whatsapp.isConfigured()) return notConfiguredResponse();

      return measureTool('send_whatsapp_media', async () => {
        let result: any;

        if (dry_run) {
          result = {
            status: 'DRY_RUN',
            request_id,
            to,
            media_type,
            media_url,
            instruccion: `[SIMULACIÓN] Se enviaría ${media_type} a ${to}: ${media_url}`,
          };
        } else {
          try {
            const sendResult = await whatsapp.sendMediaMessage(to, media_url, media_type, caption);
            result = {
              status: 'OK',
              request_id,
              message_id: sendResult.message_id,
              to: sendResult.to,
              media_type,
              timestamp: sendResult.timestamp,
              mensaje: `✅ ${media_type} enviado a ${to}`,
            };

            await sheets.appendLog({
              timestamp: new Date().toISOString(),
              tool_name: 'send_whatsapp_media',
              correlation_id: correlationId,
              cliente_id: to,
              accion: `${media_type} enviado: ${media_url}${caption ? ` · "${caption}"` : ''}`,
              resultado: 'OK',
              dry_run: false,
            });

            idempotencyStore.register(request_id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
          } catch (err) {
            result = { status: 'ERROR', error: String(err), request_id };
            logger.error('send_whatsapp_media falló', { correlationId, error: String(err) });
          }
        }

        logger.info('send_whatsapp_media completado', {
          correlationId, tool: 'send_whatsapp_media', data: { to, media_type, dry_run, status: result.status },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'get_whatsapp_history',
    `Devuelve el historial de mensajes de WhatsApp con un cliente o lead específico.
    
    CUÁNDO USAR: El dueño pregunta "¿qué me escribió Torrico?", "muéstrame la conversación con Mamani",
    "¿qué hablamos con este cliente por WhatsApp?".
    
    CUÁNDO NO USAR: Si quiere ver todos los contactos con mensajes pendientes →
    usar get_unread_whatsapp.
    
    DEVUELVE: Mensajes ordenados cronológicamente. Solo incluye mensajes recibidos
    mientras el webhook estuvo activo — Meta no permite consultar historial anterior.`,
    {
      phone: z.string().describe('Número de teléfono del cliente o lead. Ejemplo: 70012345'),
      limit: z.number().min(1).max(100).default(20).describe('Máximo de mensajes a devolver. Default: 20'),
    },
    async ({ phone, limit }) => {
      const correlationId = randomUUID();
      logger.info('get_whatsapp_history iniciado', { correlationId, tool: 'get_whatsapp_history', data: { phone } });

      return measureTool('get_whatsapp_history', async () => {
        const mensajes = await whatsapp.getConversationHistory(phone, limit);

        const result = {
          telefono: phone,
          total_mensajes: mensajes.length,
          mensajes: mensajes.map(m => ({
            id: m.id,
            direccion: m.direction === 'inbound' ? '📥 Recibido' : '📤 Enviado',
            texto: m.body,
            tipo: m.type,
            fecha: m.timestamp,
          })),
          nota: mensajes.length === 0
            ? 'Sin mensajes registrados. Solo se capturan mensajes recibidos mientras el webhook de WhatsApp está activo.'
            : undefined,
        };

        logger.info('get_whatsapp_history completado', {
          correlationId, tool: 'get_whatsapp_history', data: { phone, total: mensajes.length },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'get_unread_whatsapp',
    `Lista los contactos con mensajes de WhatsApp recientes sin atender.
    
    CUÁNDO USAR: El dueño pregunta "¿quién me escribió que no he respondido?",
    "¿tengo mensajes pendientes?", "¿qué clientes me escribieron hoy?".
    
    CUÁNDO NO USAR: Si quiere el historial de UN cliente específico →
    usar get_whatsapp_history.
    
    DEVUELVE: Lista de contactos ordenada por mensaje más reciente, con conteo de no leídos.`,
    {},
    async () => {
      const correlationId = randomUUID();
      logger.info('get_unread_whatsapp iniciado', { correlationId, tool: 'get_unread_whatsapp' });

      return measureTool('get_unread_whatsapp', async () => {
        const contactos = await whatsapp.getRecentContacts();

        const result = {
          total_contactos: contactos.length,
          contactos: contactos.map(c => ({
            telefono: c.telefono,
            ultimo_mensaje: c.ultimo_mensaje,
            fecha: c.ultimo_mensaje_fecha,
            mensajes_sin_atender: c.no_leidos,
          })),
          resumen: contactos.length > 0
            ? `Tienes ${contactos.length} contacto(s) con mensajes recientes. El más reciente: ${contactos[0]?.telefono}`
            : '📋 No hay mensajes nuevos registrados.',
        };

        logger.info('get_unread_whatsapp completado', {
          correlationId, tool: 'get_unread_whatsapp', data: { total: contactos.length },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'create_whatsapp_broadcast',
    `Envía el mismo mensaje (o uno personalizado) a varios clientes a la vez.
    
    CUÁNDO USAR: El dueño dice "avisa a todos los morosos", "manda este mensaje a mis 10 mejores clientes",
    "notifica a todos los de Sacaba sobre la promoción".
    
    CUÁNDO NO USAR: Si es un solo destinatario → usar send_whatsapp_message.
    Para campañas de cobranza con mensajes ya personalizados por cliente →
    usar execute_collection_campaign (dominio Cobros) y luego este broadcast para enviarlos.
    
    DEVUELVE: Resultado de cada envío individual — falla parcial, nunca total
    (decisión de ingeniería #5: graceful degradation).`,
    {
      recipients: z.array(z.object({
        to: z.string().describe('Número de teléfono'),
        message: z.string().describe('Mensaje para este destinatario (puede ser igual o personalizado)'),
      })).min(1).max(50).describe('Lista de destinatarios con su mensaje. Máximo 50 por broadcast'),
      request_id: z.string().uuid().describe('UUID único para evitar duplicados'),
      dry_run: z.boolean().default(true).describe('Si true muestra preview sin enviar. Default: true'),
    },
    async ({ recipients, request_id, dry_run }) => {
      const correlationId = randomUUID();
      logger.info('create_whatsapp_broadcast iniciado', {
        correlationId, tool: 'create_whatsapp_broadcast', data: { total: recipients.length },
      });

      const cached = idempotencyStore.check(request_id);
      if (cached) return cached as any;

      if (!whatsapp.isConfigured()) return notConfiguredResponse();

      return measureTool('create_whatsapp_broadcast', async () => {
        if (dry_run) {
          const result = {
            status: 'DRY_RUN — revisar antes de enviar',
            request_id,
            total_destinatarios: recipients.length,
            preview: recipients.map(r => ({ to: r.to, mensaje: r.message })),
            instruccion: '👆 Revisa los mensajes. Ejecuta con dry_run=false para enviar a todos.',
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }

        // Graceful degradation — decisión #5: falla parcial, nunca total
        const resultados: Array<{ to: string; status: 'ENVIADO' | 'FALLIDO'; message_id?: string; error?: string }> = [];

        for (const r of recipients) {
          try {
            const sendResult = await whatsapp.sendTextMessage(r.to, r.message);
            resultados.push({ to: r.to, status: 'ENVIADO', message_id: sendResult.message_id });
          } catch (err) {
            logger.warn(`Broadcast falló para ${r.to}`, { correlationId, error: String(err) });
            resultados.push({ to: r.to, status: 'FALLIDO', error: String(err) });
          }
        }

        const enviados = resultados.filter(r => r.status === 'ENVIADO');
        const fallidos = resultados.filter(r => r.status === 'FALLIDO');

        await sheets.appendLog({
          timestamp: new Date().toISOString(),
          tool_name: 'create_whatsapp_broadcast',
          correlation_id: correlationId,
          cliente_id: 'BROADCAST',
          accion: `Broadcast enviado: ${enviados.length}/${recipients.length} exitosos`,
          resultado: fallidos.length > 0 ? `PARCIAL — ${fallidos.length} fallidos` : 'OK',
          dry_run: false,
        });

        const result = {
          status: fallidos.length === 0 ? 'OK' : 'PARCIAL',
          request_id,
          total_destinatarios: recipients.length,
          enviados: enviados.length,
          fallidos: fallidos.length,
          detalle: resultados,
          mensaje: fallidos.length === 0
            ? `✅ ${enviados.length} mensajes enviados correctamente`
            : `⚠️ ${enviados.length} enviados, ${fallidos.length} fallidos — revisar detalle`,
        };

        idempotencyStore.register(request_id, { content: [{ type: 'text', text: JSON.stringify(result) }] });

        logger.info('create_whatsapp_broadcast completado', {
          correlationId, tool: 'create_whatsapp_broadcast',
          data: { enviados: enviados.length, fallidos: fallidos.length },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'get_whatsapp_contacts',
    `Cruza los contactos de WhatsApp con la base de Clientes y Leads del Sheet.
    
    CUÁNDO USAR: El dueño pregunta "¿quién me escribió que no tengo registrado?",
    "¿qué clientes me están escribiendo?", "cruza mis mensajes con mi base de datos".
    
    DEVUELVE: Contactos de WhatsApp identificados (vinculados a Cliente o Lead existente)
    y no identificados (números que escribieron pero no están en el Sheet — leads nuevos).`,
    {},
    async () => {
      const correlationId = randomUUID();
      logger.info('get_whatsapp_contacts iniciado', { correlationId, tool: 'get_whatsapp_contacts' });

      return measureTool('get_whatsapp_contacts', async () => {
        const [contactosWhatsapp, clientes, leads] = await Promise.all([
          whatsapp.getRecentContacts(),
          sheets.getClientes(),
          sheets.getLeads(),
        ]);

        const normalizar = (tel: string) => tel.replace(/[^0-9]/g, '').replace(/^591/, '');

        const clientesPorTel = new Map(clientes.map(c => [normalizar(c.telefono), c]));
        const leadsPorTel = new Map(leads.map(l => [normalizar(l.telefono), l]));

        const identificados: any[] = [];
        const noIdentificados: any[] = [];

        for (const contacto of contactosWhatsapp) {
          const telNorm = normalizar(contacto.telefono);
          const cliente = clientesPorTel.get(telNorm);
          const lead = leadsPorTel.get(telNorm);

          if (cliente) {
            identificados.push({
              telefono: contacto.telefono,
              tipo: 'CLIENTE',
              id: cliente.id,
              nombre: cliente.nombre,
              ultimo_mensaje: contacto.ultimo_mensaje,
              fecha: contacto.ultimo_mensaje_fecha,
            });
          } else if (lead) {
            identificados.push({
              telefono: contacto.telefono,
              tipo: 'LEAD',
              id: lead.id,
              nombre: lead.nombre,
              etapa: lead.etapa,
              ultimo_mensaje: contacto.ultimo_mensaje,
              fecha: contacto.ultimo_mensaje_fecha,
            });
          } else {
            noIdentificados.push({
              telefono: contacto.telefono,
              ultimo_mensaje: contacto.ultimo_mensaje,
              fecha: contacto.ultimo_mensaje_fecha,
            });
          }
        }

        const result = {
          total_contactos: contactosWhatsapp.length,
          identificados: {
            total: identificados.length,
            contactos: identificados,
          },
          no_identificados: {
            total: noIdentificados.length,
            contactos: noIdentificados,
            nota: noIdentificados.length > 0
              ? '💡 Estos números escribieron pero no están en Clientes ni Leads — podrían ser leads nuevos para registrar.'
              : undefined,
          },
        };

        logger.info('get_whatsapp_contacts completado', {
          correlationId, tool: 'get_whatsapp_contacts',
          data: { identificados: identificados.length, noIdentificados: noIdentificados.length },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'send_whatsapp_price_list',
    `Envía la lista de precios o catálogo de productos por WhatsApp a un cliente.
    
    CUÁNDO USAR: El dueño dice "envíale los precios a Flores", "mándale el catálogo a este lead",
    "¿qué productos tengo para ofrecerle a Mamani?".
    
    CUÁNDO NO USAR: Si ya se acordó una cantidad y precio específico → usar generate_quote
    (dominio Inventario) para una cotización formal con descuentos.
    
    DEVUELVE: Mensaje con la lista de productos disponibles enviado por WhatsApp.`,
    {
      to: z.string().describe('Número de teléfono del destinatario'),
      category_filter: z.string().optional().describe('Filtrar por categoría o nombre parcial del producto'),
      request_id: z.string().uuid().describe('UUID único para evitar duplicados'),
      dry_run: z.boolean().default(false).describe('Si true, simula sin enviar. Default: false'),
    },
    async ({ to, category_filter, request_id, dry_run }) => {
      const correlationId = randomUUID();
      logger.info('send_whatsapp_price_list iniciado', {
        correlationId, tool: 'send_whatsapp_price_list', data: { to },
      });

      const cached = idempotencyStore.check(request_id);
      if (cached) return cached as any;

      return measureTool('send_whatsapp_price_list', async () => {
        const productos = await sheets.getProductos();

        const filtrados = category_filter
          ? productos.filter(p => p.producto.toLowerCase().includes(category_filter.toLowerCase()))
          : productos;

        const disponibles = filtrados.filter(p => p.stock_actual > 0);

        if (disponibles.length === 0) {
          const result = { status: 'SKIP', error: 'No hay productos disponibles con ese filtro' };
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }

        const listaTexto = disponibles
          .map(p => `• ${p.producto} (${p.sku}): Bs. ${p.precio_venta.toLocaleString('es-BO')}`)
          .join('\n');

        const empresaConfig = sheets.getEmpresaConfig();
        const nombreEmpresa = empresaConfig?.nombre_empresa ?? 'Distribuidora El Cóndor';

        const mensaje = `Lista de precios — ${nombreEmpresa}\n\n${listaTexto}\n\n` +
          `Precios en Bolivianos (BOB). Puede cancelar via QR BCB o Tigo Money. ¡Escríbanos para coordinar su pedido!`;

        let result: any;

        if (dry_run || !whatsapp.isConfigured()) {
          result = {
            status: whatsapp.isConfigured() ? 'DRY_RUN' : 'SKIP',
            request_id,
            to,
            total_productos: disponibles.length,
            mensaje_preview: mensaje,
            instruccion: !whatsapp.isConfigured()
              ? 'WhatsApp no configurado — mensaje generado pero no enviado.'
              : `[SIMULACIÓN] Se enviaría lista de ${disponibles.length} productos a ${to}`,
          };
        } else {
          try {
            const sendResult = await whatsapp.sendTextMessage(to, mensaje);
            result = {
              status: 'OK',
              request_id,
              message_id: sendResult.message_id,
              to,
              total_productos: disponibles.length,
              mensaje: `✅ Lista de precios enviada a ${to} (${disponibles.length} productos)`,
            };

            await sheets.appendLog({
              timestamp: new Date().toISOString(),
              tool_name: 'send_whatsapp_price_list',
              correlation_id: correlationId,
              cliente_id: to,
              accion: `Lista de precios enviada: ${disponibles.length} productos${category_filter ? ` (filtro: ${category_filter})` : ''}`,
              resultado: 'OK',
              dry_run: false,
            });

            idempotencyStore.register(request_id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
          } catch (err) {
            result = { status: 'ERROR', error: String(err), request_id };
            logger.error('send_whatsapp_price_list falló', { correlationId, error: String(err) });
          }
        }

        logger.info('send_whatsapp_price_list completado', {
          correlationId, tool: 'send_whatsapp_price_list', data: { to, total: disponibles.length, status: result.status },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );
}
