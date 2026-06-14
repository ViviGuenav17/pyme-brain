// Dominio: Google Workspace
// Tools para Gmail, Drive, Calendar, Tasks y Docs
// Integración completa del ecosistema Google para PyMEs bolivianas

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GmailAdapter } from '../adapters/gmail.adapter.js';
import { DriveAdapter } from '../adapters/drive.adapter.js';
import { CalendarAdapter } from '../adapters/calendar.adapter.js';
import { TasksAdapter } from '../adapters/tasks.adapter.js';
import { DocsAdapter } from '../adapters/docs.adapter.js';
import { measureTool } from '../utils/metrics.js';
import { logger } from '../utils/logger.js';
import { randomUUID } from 'crypto';

export function registerGoogleTools(
  server: McpServer,
  gmail: GmailAdapter,
  drive: DriveAdapter,
  calendar: CalendarAdapter,
  tasks: TasksAdapter,
  docs: DocsAdapter,
) {

  // ═══ GMAIL TOOLS ═══

  server.tool(
    'search_emails',
    `Busca emails en Gmail por palabras clave.
    
    CUÁNDO USAR: El dueño pregunta "¿llegó algún email del proveedor?",
    "¿me mandaron la factura?", "busca emails de Química Latina",
    "¿hay algún correo de pago?".
    
    DEVUELVE: Lista de emails con remitente, asunto y resumen.`,
    {
      query: z.string().describe('Búsqueda en formato Gmail. Ejemplo: "from:proveedor" o "factura"'),
      max_results: z.number().max(10).default(5).describe('Máximo de resultados. Default: 5'),
    },
    async ({ query, max_results }) => {
      const correlationId = randomUUID();
      logger.info('search_emails iniciado', { correlationId, tool: 'search_emails' });

      return measureTool('search_emails', async () => {
        const emails = await gmail.searchEmails(query, max_results);

        const result = {
          query,
          total_encontrados: emails.length,
          emails: emails.map(e => ({
            id: e.id,
            de: e.from,
            asunto: e.subject,
            fecha: e.date,
            resumen: e.snippet,
          })),
          mensaje: emails.length === 0
            ? `No se encontraron emails con la búsqueda: "${query}"`
            : `Se encontraron ${emails.length} email(s) para: "${query}"`,
        };

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'get_supplier_emails',
    `Busca emails de proveedores — facturas recibidas y cotizaciones.
    
    CUÁNDO USAR: El dueño pregunta "¿llegaron facturas de proveedores?",
    "¿qué me mandaron los proveedores?", "¿hay cotizaciones pendientes de revisar?".
    
    DEVUELVE: Emails recientes de proveedores con facturas y cotizaciones.`,
    {
      max_results: z.number().max(10).default(5).describe('Máximo de resultados. Default: 5'),
    },
    async ({ max_results }) => {
      const correlationId = randomUUID();
      logger.info('get_supplier_emails iniciado', { correlationId, tool: 'get_supplier_emails' });

      return measureTool('get_supplier_emails', async () => {
        const emails = await gmail.getSupplierEmails(max_results);

        const result = {
          total: emails.length,
          emails: emails.map(e => ({
            de: e.from,
            asunto: e.subject,
            fecha: e.date,
            resumen: e.snippet,
          })),
          mensaje: emails.length === 0
            ? 'No hay emails recientes de proveedores'
            : `${emails.length} email(s) de proveedores encontrados`,
        };

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'send_email',
    `Envía un email desde la cuenta de la empresa.
    
    CUÁNDO USAR: El dueño dice "manda un email al proveedor",
    "envía la orden de compra por correo", "escríbele a Química Latina".
    
    DEVUELVE: Confirmación del envío con ID del mensaje.`,
    {
      to: z.string().email().describe('Email del destinatario'),
      subject: z.string().describe('Asunto del email'),
      body: z.string().describe('Cuerpo del email'),
      dry_run: z.boolean().default(true).describe('Si true muestra preview sin enviar. Default: true'),
    },
    async ({ to, subject, body, dry_run }) => {
      const correlationId = randomUUID();
      logger.info('send_email iniciado', { correlationId, tool: 'send_email', data: { to, subject } });

      return measureTool('send_email', async () => {
        if (dry_run) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: 'DRY_RUN',
                para: to,
                asunto: subject,
                cuerpo: body,
                instruccion: '👆 Revisa el email. Ejecuta con dry_run=false para enviar.',
              }, null, 2),
            }],
          };
        }

        const messageId = await gmail.sendEmail(to, subject, body);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'ENVIADO',
              message_id: messageId,
              para: to,
              asunto: subject,
              mensaje: `✅ Email enviado correctamente a ${to}`,
            }, null, 2),
          }],
        };
      });
    }
  );

  // ═══ DRIVE TOOLS ═══

  server.tool(
    'list_drive_files',
    `Lista archivos recientes en Google Drive.
    
    CUÁNDO USAR: El dueño pregunta "¿qué documentos tengo?",
    "busca el contrato de Quispe", "¿dónde está la cotización de la semana pasada?".
    
    DEVUELVE: Lista de archivos con nombre, tipo y link directo.`,
    {
      query: z.string().optional().describe('Búsqueda por nombre. Ejemplo: "cotización" o "contrato"'),
      max_results: z.number().max(20).default(10).describe('Máximo de resultados. Default: 10'),
    },
    async ({ query, max_results }) => {
      const correlationId = randomUUID();
      logger.info('list_drive_files iniciado', { correlationId, tool: 'list_drive_files' });

      return measureTool('list_drive_files', async () => {
        const files = query
          ? await drive.searchFiles(query)
          : await drive.listFiles(undefined, max_results);

        const result = {
          total: files.length,
          archivos: files.map(f => ({
            nombre: f.name,
            tipo: f.mimeType,
            modificado: f.modifiedTime,
            link: f.webViewLink,
          })),
          mensaje: files.length === 0
            ? 'No se encontraron archivos'
            : `${files.length} archivo(s) encontrados`,
        };

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'save_document_to_drive',
    `Guarda un documento en Google Drive.
    
    CUÁNDO USAR: El dueño dice "guarda esta cotización en Drive",
    "archiva la orden de compra", "guarda este documento".
    
    DEVUELVE: Link directo al documento guardado en Drive.`,
    {
      name: z.string().describe('Nombre del archivo'),
      content: z.string().describe('Contenido del documento'),
    },
    async ({ name, content }) => {
      const correlationId = randomUUID();
      logger.info('save_document_to_drive iniciado', { correlationId, tool: 'save_document_to_drive' });

      return measureTool('save_document_to_drive', async () => {
        const file = await drive.createTextFile(name, content);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'OK',
              archivo: {
                nombre: file.name,
                id: file.id,
                link: file.webViewLink,
              },
              mensaje: `✅ Documento "${name}" guardado en Drive`,
            }, null, 2),
          }],
        };
      });
    }
  );

  // ═══ CALENDAR TOOLS ═══

  server.tool(
    'get_upcoming_events',
    `Lista los próximos eventos del calendario.
    
    CUÁNDO USAR: El dueño pregunta "¿qué tengo en agenda?",
    "¿qué recordatorios tengo esta semana?", "¿qué eventos hay próximos?".
    
    DEVUELVE: Lista de eventos con fecha, hora y descripción.`,
    {
      days: z.number().min(1).max(30).default(7).describe('Días hacia adelante. Default: 7'),
    },
    async ({ days }) => {
      const correlationId = randomUUID();
      logger.info('get_upcoming_events iniciado', { correlationId, tool: 'get_upcoming_events' });

      return measureTool('get_upcoming_events', async () => {
        const events = await calendar.getUpcomingEvents(days);

        const result = {
          dias: days,
          total_eventos: events.length,
          eventos: events.map(e => ({
            titulo: e.title,
            descripcion: e.description,
            inicio: e.start,
            fin: e.end,
            ubicacion: e.location,
            link: e.link,
          })),
          mensaje: events.length === 0
            ? `No hay eventos en los próximos ${days} días`
            : `${events.length} evento(s) en los próximos ${days} días`,
        };

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'create_reminder',
    `Crea un recordatorio en Google Calendar.
    
    CUÁNDO USAR: El dueño dice "recuérdame cobrar a Flores el lunes",
    "agenda un seguimiento con Vargas para el jueves",
    "ponme un recordatorio para llamar al proveedor".
    
    DEVUELVE: Confirmación del recordatorio creado con link al calendario.`,
    {
      title: z.string().describe('Título del recordatorio'),
      description: z.string().describe('Descripción o notas del recordatorio'),
      date: z.string().describe('Fecha en formato YYYY-MM-DD. Ejemplo: 2026-06-20'),
      time: z.string().default('09:00').describe('Hora en formato HH:MM. Default: 09:00'),
    },
    async ({ title, description, date, time }) => {
      const correlationId = randomUUID();
      logger.info('create_reminder iniciado', { correlationId, tool: 'create_reminder' });

      return measureTool('create_reminder', async () => {
        const startDateTime = `${date}T${time}:00`;
        const endDateTime = `${date}T${time.split(':')[0]}:30:00`;

        const event = await calendar.createEvent(title, description, startDateTime, endDateTime);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'OK',
              recordatorio: {
                titulo: event.title,
                fecha: date,
                hora: time,
                link: event.link,
              },
              mensaje: `✅ Recordatorio "${title}" creado para el ${date} a las ${time}`,
            }, null, 2),
          }],
        };
      });
    }
  );

  server.tool(
    'schedule_cobro_reminder',
    `Agenda un recordatorio de cobro en el calendario.
    
    CUÁNDO USAR: El dueño dice "recuérdame cobrar a Flores el lunes",
    "agenda cobro de Mamani para mañana", "ponme recordatorio de cobro".
    
    DEVUELVE: Recordatorio creado en Google Calendar con datos del cobro.`,
    {
      cliente_nombre: z.string().describe('Nombre del cliente'),
      monto_bob: z.number().positive().describe('Monto a cobrar en BOB'),
      fecha: z.string().describe('Fecha del recordatorio en formato YYYY-MM-DD'),
    },
    async ({ cliente_nombre, monto_bob, fecha }) => {
      const correlationId = randomUUID();
      logger.info('schedule_cobro_reminder iniciado', { correlationId, tool: 'schedule_cobro_reminder' });

      return measureTool('schedule_cobro_reminder', async () => {
        const event = await calendar.createCobroReminder(cliente_nombre, monto_bob, fecha);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'OK',
              recordatorio: {
                titulo: event.title,
                fecha,
                cliente: cliente_nombre,
                monto_bob,
                link: event.link,
              },
              mensaje: `✅ Recordatorio de cobro a ${cliente_nombre} por Bs. ${monto_bob.toLocaleString('es-BO')} agendado para el ${fecha}`,
            }, null, 2),
          }],
        };
      });
    }
  );

  // ═══ TASKS TOOLS ═══

  server.tool(
    'get_pending_tasks',
    `Lista las tareas pendientes del equipo.
    
    CUÁNDO USAR: El dueño pregunta "¿qué tareas hay pendientes?",
    "¿qué tiene pendiente el equipo?", "¿qué falta por hacer?".
    
    DEVUELVE: Lista de tareas pendientes con fecha límite.`,
    {},
    async () => {
      const correlationId = randomUUID();
      logger.info('get_pending_tasks iniciado', { correlationId, tool: 'get_pending_tasks' });

      return measureTool('get_pending_tasks', async () => {
        const tasksList = await tasks.getTaskLists();
        const allTasks = await tasks.getTasks();

        const result = {
          total_tareas: allTasks.length,
          tareas: allTasks.map(t => ({
            id: t.id,
            titulo: t.title,
            notas: t.notes,
            fecha_limite: t.due,
            estado: t.status,
          })),
          mensaje: allTasks.length === 0
            ? '✅ No hay tareas pendientes'
            : `${allTasks.length} tarea(s) pendiente(s)`,
        };

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'create_task',
    `Crea una tarea y la asigna al equipo.
    
    CUÁNDO USAR: El dueño dice "asigna a Juan que llame a Flores",
    "crea una tarea para visitar a Mamani", "recuerda a María que envíe la cotización",
    "agrega tarea de revisar inventario".
    
    DEVUELVE: Tarea creada con fecha límite y asignado.`,
    {
      title: z.string().describe('Título de la tarea'),
      notes: z.string().optional().describe('Notas o descripción de la tarea'),
      due_date: z.string().optional().describe('Fecha límite en formato YYYY-MM-DD'),
      assigned_to: z.string().optional().describe('Nombre del responsable. Ejemplo: Juan, María'),
    },
    async ({ title, notes, due_date, assigned_to }) => {
      const correlationId = randomUUID();
      logger.info('create_task iniciado', { correlationId, tool: 'create_task' });

      return measureTool('create_task', async () => {
        const notasCompletas = [
          notes,
          assigned_to ? `Asignado a: ${assigned_to}` : null,
        ].filter(Boolean).join('\n');

        const task = await tasks.createTask(title, notasCompletas, due_date);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'OK',
              tarea: {
                id: task.id,
                titulo: task.title,
                notas: task.notes,
                fecha_limite: task.due,
                asignado_a: assigned_to ?? 'Sin asignar',
              },
              mensaje: `✅ Tarea "${title}" creada${assigned_to ? ` y asignada a ${assigned_to}` : ''}${due_date ? ` para el ${due_date}` : ''}`,
            }, null, 2),
          }],
        };
      });
    }
  );

  server.tool(
    'complete_task',
    `Marca una tarea como completada.
    
    CUÁNDO USAR: El dueño dice "Juan ya llamó a Flores", "marca como hecha la tarea de Mamani",
    "completé la visita al proveedor", "ya envié la cotización".
    
    DEVUELVE: Confirmación de tarea completada.`,
    {
      task_id: z.string().describe('ID de la tarea a completar'),
    },
    async ({ task_id }) => {
      const correlationId = randomUUID();
      logger.info('complete_task iniciado', { correlationId, tool: 'complete_task' });

      return measureTool('complete_task', async () => {
        await tasks.completeTask(task_id);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'OK',
              task_id,
              mensaje: `✅ Tarea ${task_id} marcada como completada`,
            }, null, 2),
          }],
        };
      });
    }
  );

  // ═══ DOCS TOOLS ═══

  server.tool(
    'create_formal_document',
    `Crea un documento formal en Google Docs.
    
    CUÁNDO USAR: El dueño dice "crea un contrato para Quispe",
    "genera un documento formal de cotización", "necesito un documento oficial".
    
    DEVUELVE: Link directo al documento creado en Google Docs.`,
    {
      title: z.string().describe('Título del documento'),
      content: z.string().describe('Contenido del documento'),
    },
    async ({ title, content }) => {
      const correlationId = randomUUID();
      logger.info('create_formal_document iniciado', { correlationId, tool: 'create_formal_document' });

      return measureTool('create_formal_document', async () => {
        const doc = await docs.createDoc(title, content);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'OK',
              documento: {
                titulo: doc.title,
                id: doc.id,
                url: doc.url,
              },
              mensaje: `✅ Documento "${title}" creado en Google Docs`,
            }, null, 2),
          }],
        };
      });
    }
  );
}