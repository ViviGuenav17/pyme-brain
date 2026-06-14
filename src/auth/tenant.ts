import { google } from 'googleapis';
import { getEmpresaById } from './db.js';
import { SheetsAdapter } from '../adapters/sheets.adapter.js';
import { GmailAdapter } from '../adapters/gmail.adapter.js';
import { DriveAdapter } from '../adapters/drive.adapter.js';
import { CalendarAdapter } from '../adapters/calendar.adapter.js';
import { TasksAdapter } from '../adapters/tasks.adapter.js';
import { DocsAdapter } from '../adapters/docs.adapter.js';
import { logger } from '../utils/logger.js';

export interface TenantAdapters {
  sheets: SheetsAdapter;
  gmail: GmailAdapter;
  drive: DriveAdapter;
  calendar: CalendarAdapter;
  tasks: TasksAdapter;
  docs: DocsAdapter;
  empresa_id: string;
  empresa_nombre: string;
}

// Cache de adapters por empresa_id — evita recrear en cada request
const tenantCache = new Map<string, TenantAdapters>();

export async function getAdaptersForEmpresa(empresa_id: string): Promise<TenantAdapters> {
  // Devolver del cache si ya existe
  if (tenantCache.has(empresa_id)) {
    return tenantCache.get(empresa_id)!;
  }

  // Cargar empresa desde PostgreSQL
  const empresa = await getEmpresaById(empresa_id);
  if (!empresa) {
    throw new Error(`Empresa no encontrada: ${empresa_id}`);
  }

  if (!empresa.google_refresh_token) {
    throw new Error(`Empresa ${empresa_id} no tiene Google conectado`);
  }

  // Crear cliente OAuth con las credenciales de ESTA empresa
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  auth.setCredentials({
    refresh_token: empresa.google_refresh_token,
  });

  // Crear adapters con las credenciales de esta empresa
  const sheets = new SheetsAdapter(auth, empresa.sheet_id ?? process.env.SHEET_ID!);
  const gmail = new GmailAdapter(auth);
  const drive = new DriveAdapter(auth);
  const calendar = new CalendarAdapter(auth);
  const tasks = new TasksAdapter(auth);
  const docs = new DocsAdapter(auth);

  // Inicializar sheets con la config de la empresa
  await sheets.initialize();

  const adapters: TenantAdapters = {
    sheets, gmail, drive, calendar, tasks, docs,
    empresa_id,
    empresa_nombre: empresa.nombre,
  };

  // Guardar en cache
  tenantCache.set(empresa_id, adapters);

  logger.info('Adapters cargados para empresa', {
    data: { empresa_id, nombre: empresa.nombre }
  });

  return adapters;
}

// Invalida el cache de una empresa (útil si renueva credenciales)
export function invalidateTenantCache(empresa_id: string): void {
  tenantCache.delete(empresa_id);
}