import { google } from 'googleapis';
import { CircuitBreaker } from '../infra/circuit-breaker.js';
import { withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import { cache } from '../infra/cache.js';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
  modifiedTime: string;
  size?: string;
  webViewLink?: string;
}

export class DriveAdapter {
  private breaker = new CircuitBreaker('GoogleDrive');
  private drive;

  constructor(auth?: any) {
    const authClient = auth ?? (() => {
      const a = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
      );
      a.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
      return a;
    })();
    this.drive = google.drive({ version: 'v3', auth: authClient });
  }

  async listFiles(query?: string, maxResults = 10): Promise<DriveFile[]> {
    const cacheKey = `drive:list:${query}:${maxResults}`;
    const cached = cache.get<DriveFile[]>(cacheKey);
    if (cached) return cached;

    const result = await this.breaker.call(() =>
      withRetry(() =>
        this.drive.files.list({
          q: query ?? "trashed=false",
          pageSize: maxResults,
          fields: 'files(id,name,mimeType,createdTime,modifiedTime,size,webViewLink)',
          orderBy: 'modifiedTime desc',
        })
      )
    );

    const files = (result.data.files ?? []).map(f => ({
      id: f.id!,
      name: f.name!,
      mimeType: f.mimeType!,
      createdTime: f.createdTime!,
      modifiedTime: f.modifiedTime!,
      size: f.size ?? undefined,
      webViewLink: f.webViewLink ?? undefined,
    }));

    cache.set(cacheKey, files, 2 * 60 * 1000);
    return files;
  }

  async createTextFile(name: string, content: string, folderId?: string): Promise<DriveFile> {
    const result = await this.breaker.call(() =>
      withRetry(() =>
        this.drive.files.create({
          requestBody: {
            name,
            mimeType: 'text/plain',
            parents: folderId ? [folderId] : undefined,
          },
          media: {
            mimeType: 'text/plain',
            body: content,
          },
          fields: 'id,name,mimeType,createdTime,modifiedTime,webViewLink',
        })
      )
    );

    logger.info('Archivo creado en Drive', { data: { name, id: result.data.id } });

    return {
      id: result.data.id!,
      name: result.data.name!,
      mimeType: result.data.mimeType!,
      createdTime: result.data.createdTime!,
      modifiedTime: result.data.modifiedTime!,
      webViewLink: result.data.webViewLink ?? undefined,
    };
  }

  async searchFiles(name: string): Promise<DriveFile[]> {
    return this.listFiles(`name contains '${name}' and trashed=false`);
  }

  async saveCotizacion(cotizacion_id: string, contenido: string): Promise<DriveFile> {
    return this.createTextFile(`Cotización ${cotizacion_id}.txt`, contenido);
  }

  async saveOrdenCompra(orden_id: string, contenido: string): Promise<DriveFile> {
    return this.createTextFile(`Orden de Compra ${orden_id}.txt`, contenido);
  }
}