// Adapter dedicado al Sheet separado de WhatsApp (Mensajes_WhatsApp,
// Contactos_WhatsApp, Plantillas_WhatsApp). Separado de SheetsAdapter
// (que maneja Clientes/Cobros/Leads/Inventario) siguiendo la decisión de
// ingeniería #1 — separación de capas, un adapter por responsabilidad.
//
// Usa el mismo patrón de auth opcional con fallback a .env que el resto
// de adapters del proyecto (SheetsAdapter, GmailAdapter, etc.)

import { google } from 'googleapis';
import { CircuitBreaker } from '../infra/circuit-breaker.js';
import { withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import { cache } from '../infra/cache.js';

export interface MensajeWhatsappDemo {
  id: string;
  cliente_id: string;
  telefono: string;
  sucursal: string;
  direccion: 'inbound' | 'outbound';
  tipo: string;
  mensaje: string;
  fecha: string;
}

export interface ContactoWhatsappDemo {
  contacto_id: string;
  telefono: string;
  nombre: string;
  tipo: 'cliente' | 'lead';
  cliente_o_lead_id: string;
  sucursal: string;
  vendedor_asignado: string;
  etiqueta: string;
  fecha_primer_contacto: string;
  ultima_actividad: string;
}

export interface PlantillaWhatsappDemo {
  plantilla_id: string;
  nombre: string;
  categoria: string;
  idioma: string;
  estado: 'APROBADA' | 'EN_REVISION' | 'RECHAZADA';
  texto: string;
  variables: string[];
  fecha_aprobacion: string;
}

export class WhatsappSheetAdapter {
  private breaker = new CircuitBreaker('WhatsappSheet');
  private sheets;
  private readonly sheetId: string;

  constructor(auth?: any, sheetId?: string) {
    const authClient = auth ?? (() => {
      const a = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
      );
      a.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
      return a;
    })();

    this.sheetId = sheetId ?? process.env.WHATSAPP_SHEET_ID ?? '';
    this.sheets = google.sheets({ version: 'v4', auth: authClient });

    if (!this.sheetId) {
      logger.warn('WhatsappSheetAdapter sin WHATSAPP_SHEET_ID configurado — tools de demo devolverán vacío');
    }
  }

  isConfigured(): boolean {
    return Boolean(this.sheetId);
  }

  private async readTab(tabName: string): Promise<string[][]> {
    if (!this.sheetId) return [];

    const cacheKey = `whatsapp-sheet:${this.sheetId}:${tabName}`;
    const cached = cache.get<string[][]>(cacheKey);
    if (cached) return cached;

    try {
      const result = await this.breaker.call(() =>
        withRetry(() =>
          this.sheets.spreadsheets.values.get({
            spreadsheetId: this.sheetId,
            range: tabName,
          })
        )
      );

      const rows = (result.data.values ?? []) as string[][];
      cache.set(cacheKey, rows, 120_000); // 2 min — datos de demo cambian poco
      return rows;
    } catch (err) {
      // Graceful degradation (decisión #5) — si la pestaña no existe o
      // falla la lectura, no romper las tools que dependen de esto.
      logger.warn(`No se pudo leer pestaña '${tabName}' del Sheet de WhatsApp`, { error: String(err) });
      return [];
    }
  }

  async getMensajes(): Promise<MensajeWhatsappDemo[]> {
    const rows = await this.readTab('Mensajes_WhatsApp');
    return rows.slice(1).filter(r => r[0]).map(r => ({
      id: r[0] ?? '',
      cliente_id: r[1] ?? '',
      telefono: r[2] ?? '',
      sucursal: r[3] ?? '',
      direccion: (r[4] as 'inbound' | 'outbound') ?? 'inbound',
      tipo: r[5] ?? 'text',
      mensaje: r[6] ?? '',
      fecha: r[7] ?? new Date().toISOString(),
    }));
  }

  async getContactos(): Promise<ContactoWhatsappDemo[]> {
    const rows = await this.readTab('Contactos_WhatsApp');
    return rows.slice(1).filter(r => r[0]).map(r => ({
      contacto_id: r[0] ?? '',
      telefono: r[1] ?? '',
      nombre: r[2] ?? '',
      tipo: (r[3] as 'cliente' | 'lead') ?? 'cliente',
      cliente_o_lead_id: r[4] ?? '',
      sucursal: r[5] ?? '',
      vendedor_asignado: r[6] ?? '',
      etiqueta: r[7] ?? '',
      fecha_primer_contacto: r[8] ?? '',
      ultima_actividad: r[9] ?? '',
    }));
  }

  async getPlantillas(): Promise<PlantillaWhatsappDemo[]> {
    const rows = await this.readTab('Plantillas_WhatsApp');
    return rows.slice(1).filter(r => r[0]).map(r => ({
      plantilla_id: r[0] ?? '',
      nombre: r[1] ?? '',
      categoria: r[2] ?? '',
      idioma: r[3] ?? 'es',
      estado: (r[4] as 'APROBADA' | 'EN_REVISION' | 'RECHAZADA') ?? 'EN_REVISION',
      texto: r[5] ?? '',
      variables: (r[6] ?? '').split(',').map(v => v.trim()).filter(Boolean),
      fecha_aprobacion: r[7] ?? '',
    }));
  }
}
