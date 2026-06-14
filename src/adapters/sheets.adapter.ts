import { google } from 'googleapis';
import { CircuitBreaker } from '../infra/circuit-breaker.js';
import { withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import { cache } from '../infra/cache.js';
import { empresaConfigLoader, SheetConfig, EmpresaConfig } from '../config/empresa.config.js';

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
  fecha_vencimiento?: string;
  lote?: string;
  almacen?: string;
  proveedor_id?: string;
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
  private sheetConfig: SheetConfig | null = null;
  private _sheetId: string;

  constructor(auth?: any, sheetId?: string) {
    // Si se pasan credenciales externas (multi-tenant) las usa
    // Si no, usa las del .env (modo demo/fallback)
    const authClient = auth ?? (() => {
      const a = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
      );
      a.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
      return a;
    })();

    this._sheetId = sheetId ?? process.env.SHEET_ID!;
    this.sheets = google.sheets({ version: 'v4', auth: authClient });
  }

  private get sheetId() {
    return this._sheetId;
  }

  async readTab(tabName: string): Promise<string[][]> {
    const cacheKey = `sheet:${this._sheetId}:${tabName}`;
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

  async initialize(): Promise<void> {
    this.sheetConfig = await empresaConfigLoader.load({
      readTab: (tab) => this.readTab(tab),
    });
  }

  getEmpresaConfig(): EmpresaConfig | null {
    return this.sheetConfig?.empresa ?? null;
  }

  private getValue(pestana: string, campo: string, row: string[]): string {
    if (!this.sheetConfig) return '';
    return empresaConfigLoader.getValue(this.sheetConfig, pestana, campo, row);
  }

  async getClientes(): Promise<Cliente[]> {
    const rows = await this.readTab('Clientes');
    return rows.slice(1).filter(r => r[0]).map(r => ({
      id: this.getValue('Clientes', 'cliente_id', r),
      nombre: this.getValue('Clientes', 'cliente_nombre', r),
      telefono: this.getValue('Clientes', 'cliente_telefono', r),
      email: this.getValue('Clientes', 'cliente_email', r),
      credito_limite: parseFloat(this.getValue('Clientes', 'cliente_credito_limite', r)) || 0,
      score_pago: parseFloat(this.getValue('Clientes', 'cliente_score_pago', r)) || 0,
      fecha_ultimo_contacto: this.getValue('Clientes', 'cliente_fecha_ultimo_contacto', r),
      nit: this.getValue('Clientes', 'cliente_nit', r),
      ci: this.getValue('Clientes', 'cliente_ci', r),
      tipo_cliente: this.getValue('Clientes', 'cliente_tipo', r),
      ciudad: this.getValue('Clientes', 'cliente_ciudad', r),
    }));
  }

  async getCobros(): Promise<Cobro[]> {
    const rows = await this.readTab('Cobros');
    return rows.slice(1).filter(r => r[0]).map(r => ({
      id: this.getValue('Cobros', 'cobro_id', r),
      cliente_id: this.getValue('Cobros', 'cobro_cliente_id', r),
      monto: parseFloat(this.getValue('Cobros', 'cobro_monto', r)) || 0,
      fecha_vencimiento: this.getValue('Cobros', 'cobro_fecha_vencimiento', r),
      estado: this.getValue('Cobros', 'cobro_estado', r),
      fecha_pago: this.getValue('Cobros', 'cobro_fecha_pago', r),
      dias_mora: parseInt(this.getValue('Cobros', 'cobro_dias_mora', r)) || 0,
      notas: this.getValue('Cobros', 'cobro_notas', r),
    }));
  }

  async getLeads(): Promise<Lead[]> {
    const rows = await this.readTab('Leads');
    return rows.slice(1).filter(r => r[0]).map(r => ({
      id: this.getValue('Leads', 'lead_id', r),
      nombre: this.getValue('Leads', 'lead_nombre', r),
      telefono: this.getValue('Leads', 'lead_telefono', r),
      canal_origen: this.getValue('Leads', 'lead_canal', r),
      producto_interes: this.getValue('Leads', 'lead_producto', r),
      etapa: this.getValue('Leads', 'lead_etapa', r),
      score: parseInt(this.getValue('Leads', 'lead_score', r)) || 0,
      fecha_ultimo_contacto: this.getValue('Leads', 'lead_fecha_contacto', r),
    }));
  }

  async getProductos(): Promise<Producto[]> {
    const rows = await this.readTab('Inventario');
    return rows.slice(1).filter(r => r[0]).map(r => ({
      id: this.getValue('Inventario', 'producto_id', r),
      producto: this.getValue('Inventario', 'producto_nombre', r),
      sku: this.getValue('Inventario', 'producto_sku', r),
      stock_actual: parseInt(this.getValue('Inventario', 'producto_stock', r)) || 0,
      punto_reorden: parseInt(this.getValue('Inventario', 'producto_reorden', r)) || 0,
      costo_unitario: parseFloat(this.getValue('Inventario', 'producto_costo', r)) || 0,
      precio_venta: parseFloat(this.getValue('Inventario', 'producto_precio', r)) || 0,
      fecha_vencimiento: this.getValue('Inventario', 'producto_vencimiento', r),
      lote: this.getValue('Inventario', 'producto_lote', r),
      almacen: this.getValue('Inventario', 'producto_almacen', r),
      proveedor_id: this.getValue('Inventario', 'producto_proveedor', r),
    }));
  }

  async appendLog(entry: LogEntry): Promise<void> {
    await this.breaker.call(() =>
      withRetry(() =>
        this.sheets.spreadsheets.values.append({
          spreadsheetId: this.sheetId,
          range: 'Log_Acciones',
          valueInputOption: 'RAW',
          requestBody: {
            values: [[
              entry.timestamp,
              entry.tool_name,
              entry.correlation_id,
              entry.cliente_id,
              entry.accion,
              entry.resultado,
              entry.dry_run.toString(),
            ]],
          },
        })
      )
    );
    cache.invalidatePattern(`sheet:${this._sheetId}:`);
    logger.info('Log registrado', {
      tool: entry.tool_name,
      correlationId: entry.correlation_id,
    });
  }
}