// CalendarAdapter — conecta con Google Calendar usando OAuth 2.1
// Agenda recordatorios de cobro, seguimientos de leads y entregas
// Usa los mismos tokens OAuth que SheetsAdapter

import { google } from 'googleapis';
import { CircuitBreaker } from '../infra/circuit-breaker.js';
import { withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import { cache } from '../infra/cache.js';

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  start: string;
  end: string;
  location?: string;
  link?: string;
}

export class CalendarAdapter {
  private breaker = new CircuitBreaker('GoogleCalendar');
  private calendar;

  constructor() {
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
    );
    auth.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });
    this.calendar = google.calendar({ version: 'v3', auth });
  }

  // Lista eventos próximos
  async getUpcomingEvents(days = 7, maxResults = 10): Promise<CalendarEvent[]> {
    const cacheKey = `calendar:upcoming:${days}:${maxResults}`;
    const cached = cache.get<CalendarEvent[]>(cacheKey);
    if (cached) return cached;

    const now = new Date();
    const end = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const result = await this.breaker.call(() =>
      withRetry(() =>
        this.calendar.events.list({
          calendarId: 'primary',
          timeMin: now.toISOString(),
          timeMax: end.toISOString(),
          maxResults,
          singleEvents: true,
          orderBy: 'startTime',
        })
      )
    );

    const events = (result.data.items ?? []).map(e => ({
      id: e.id!,
      title: e.summary ?? 'Sin título',
      description: e.description ?? undefined,
      start: e.start?.dateTime ?? e.start?.date ?? '',
      end: e.end?.dateTime ?? e.end?.date ?? '',
      location: e.location ?? undefined,
      link: e.htmlLink ?? undefined,
    }));

    cache.set(cacheKey, events, 5 * 60 * 1000);
    return events;
  }

  // Crea un evento en el calendario
  async createEvent(
    title: string,
    description: string,
    startDateTime: string,
    endDateTime: string,
    location?: string,
  ): Promise<CalendarEvent> {
    const result = await this.breaker.call(() =>
      withRetry(() =>
        this.calendar.events.insert({
          calendarId: 'primary',
          requestBody: {
            summary: title,
            description,
            start: { dateTime: startDateTime, timeZone: 'America/La_Paz' },
            end: { dateTime: endDateTime, timeZone: 'America/La_Paz' },
            location,
          },
        })
      )
    );

    logger.info('Evento creado en Calendar', { data: { title, start: startDateTime } });

    return {
      id: result.data.id!,
      title: result.data.summary ?? title,
      description,
      start: startDateTime,
      end: endDateTime,
      location,
      link: result.data.htmlLink ?? undefined,
    };
  }

  // Crea recordatorio de cobro
  async createCobroReminder(
    clienteNombre: string,
    monto: number,
    fecha: string,
  ): Promise<CalendarEvent> {
    const startDateTime = `${fecha}T09:00:00`;
    const endDateTime = `${fecha}T09:30:00`;

    return this.createEvent(
      `💰 Cobrar a ${clienteNombre} — Bs. ${monto.toLocaleString('es-BO')}`,
      `Recordatorio de cobro:\nCliente: ${clienteNombre}\nMonto: Bs. ${monto.toLocaleString('es-BO')}\nFecha límite: ${fecha}`,
      startDateTime,
      endDateTime,
    );
  }

  // Crea recordatorio de seguimiento de lead
  async createLeadFollowup(
    leadNombre: string,
    productoInteres: string,
    fecha: string,
  ): Promise<CalendarEvent> {
    const startDateTime = `${fecha}T10:00:00`;
    const endDateTime = `${fecha}T10:30:00`;

    return this.createEvent(
      `📞 Seguimiento lead: ${leadNombre}`,
      `Hacer seguimiento a ${leadNombre}\nProducto de interés: ${productoInteres}`,
      startDateTime,
      endDateTime,
    );
  }
}