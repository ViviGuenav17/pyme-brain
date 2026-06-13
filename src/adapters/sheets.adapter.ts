// SheetsAdapter — conecta con Google Sheets usando OAuth 2.1
// Es la única capa que habla directamente con la API de Google
// Todas las tools leen y escriben datos a través de este adaptador

import { google } from 'googleapis';
import { CircuitBreaker } from '../infra/circuit-breaker.js';
import { withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import { cache } from '../infra/cache.js';

// Tipos de datos del negocio
export interface Cliente {
  id: string;
  nombre: string;
  telefono: string;
  email: string;
  credito_limite: number;
  score_pago: number;
  fecha_ultimo_contacto: string;
  nit?: string;
  ci?: string;
  tipo_cliente: string;
  ciudad: string;
}

export interface Cobro {
  id: string;
  cliente_id: string;
  monto: number;
  fecha_vencimiento: string;
  estado: string;
  fecha_pago?: string;
  dias_mora: number;
  notas?: string;
}

export interface Lead {
  id: string;
  nombre: string;
  telefono: string;
  canal_origen: string;
  producto_interes: string;
  etapa: string;
  score: number;
  fecha_ultimo_contacto: string;
}

export interface Producto {
  id: string;
  producto: string;
  sku: string;
  stock_actual: number;
  punto_reorden: number;
  costo_unitario: number;
  precio_venta: number;
}

export interface LogEntry {
  timestamp: string;
  tool_name: string;
  correlation_id: string;
  cliente_id: string;
  accion: string;
  resultado: string;
  dry_run: boolean;
}

export class SheetsAdapter {
  private breaker = new CircuitBreaker('GoogleSheets');
  private sheets;

  constructor() {
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
    );
    auth.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });
    this.sheets = google.sheets({ version: 'v4', auth });
  }

  private get sheetId() {
    return process.env.SHEET_ID!;
  }

  // Lee una pestaña completa del Sheet
  private async readTab(tabName: string): Promise<string[][]> {
    const cacheKey = `sheet:${tabName}`;
    const cached = cache.get<string[][]>(cacheKey);
    if (cached) return cached;

    const result = await this.breaker.call(() =>
      withRetry(() =>
        this.sheets.spreadsheets.values.get({
          spreadsheetId: this.sheetId,
          range: tabName,
        })
      )
    );

    const rows = (result.data.values ?? []) as string[][];
    cache.set(cacheKey, rows);
    return rows;
  }

  // Obtiene todos los clientes
  async getClientes(): Promise<Cliente[]> {
    const rows = await this.readTab('Clientes');
    return rows.slice(1).map(r => ({
      id: r[0], nombre: r[1], telefono: r[2], email: r[3],
      credito_limite: parseFloat(r[4]) || 0,
      score_pago: parseFloat(r[5]) || 0,
      fecha_ultimo_contacto: r[6], nit: r[7], ci: r[8],
      tipo_cliente: r[9], ciudad: r[10],
    }));
  }

  // Obtiene todos los cobros
  async getCobros(): Promise<Cobro[]> {
    const rows = await this.readTab('Cobros');
    return rows.slice(1).map(r => ({
      id: r[0], cliente_id: r[1],
      monto: parseFloat(r[2]) || 0,
      fecha_vencimiento: r[3], estado: r[4],
      fecha_pago: r[5],
      dias_mora: parseInt(r[6]) || 0,
      notas: r[7],
    }));
  }

  // Obtiene todos los leads
  async getLeads(): Promise<Lead[]> {
    const rows = await this.readTab('Leads');
    return rows.slice(1).map(r => ({
      id: r[0], nombre: r[1], telefono: r[2],
      canal_origen: r[3], producto_interes: r[4],
      etapa: r[5], score: parseInt(r[6]) || 0,
      fecha_ultimo_contacto: r[7],
    }));
  }

  // Obtiene todos los productos
  async getProductos(): Promise<Producto[]> {
    const rows = await this.readTab('Inventario');
    return rows.slice(1).map(r => ({
      id: r[0], producto: r[1], sku: r[2],
      stock_actual: parseInt(r[3]) || 0,
      punto_reorden: parseInt(r[4]) || 0,
      costo_unitario: parseFloat(r[5]) || 0,
      precio_venta: parseFloat(r[6]) || 0,
    }));
  }

  // Registra una acción en el Log_Acciones (append-only)
  async appendLog(entry: LogEntry): Promise<void> {
    await this.breaker.call(() =>
      withRetry(() =>
        this.sheets.spreadsheets.values.append({
          spreadsheetId: this.sheetId,
          range: 'Log_Acciones',
          valueInputOption: 'RAW',
          requestBody: {
            values: [[
              entry.timestamp, entry.tool_name, entry.correlation_id,
              entry.cliente_id, entry.accion, entry.resultado,
              entry.dry_run.toString(),
            ]],
          },
        })
      )
    );
    cache.invalidatePattern('sheet:');
    logger.info('Log registrado', { tool: entry.tool_name, correlationId: entry.correlation_id });
  }
}