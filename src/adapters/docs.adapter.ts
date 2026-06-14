// DocsAdapter — conecta con Google Docs usando OAuth 2.1
// Genera documentos formales — contratos, cotizaciones, órdenes de compra
// Usa los mismos tokens OAuth que SheetsAdapter

import { google } from 'googleapis';
import { CircuitBreaker } from '../infra/circuit-breaker.js';
import { withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';

export interface DocInfo {
  id: string;
  title: string;
  url: string;
}

export class DocsAdapter {
  private breaker = new CircuitBreaker('GoogleDocs');
  private docs;
  private drive;

  constructor() {
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
    );
    auth.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });
    this.docs = google.docs({ version: 'v1', auth });
    this.drive = google.drive({ version: 'v3', auth });
  }

  // Crea un documento nuevo con contenido
  async createDoc(title: string, content: string): Promise<DocInfo> {
    // 1. Crear documento vacío
    const doc = await this.breaker.call(() =>
      withRetry(() =>
        this.docs.documents.create({
          requestBody: { title },
        })
      )
    );

    const docId = doc.data.documentId!;

    // 2. Insertar contenido
    await this.breaker.call(() =>
      withRetry(() =>
        this.docs.documents.batchUpdate({
          documentId: docId,
          requestBody: {
            requests: [{
              insertText: {
                location: { index: 1 },
                text: content,
              },
            }],
          },
        })
      )
    );

    logger.info('Documento creado en Google Docs', { data: { title, docId } });

    return {
      id: docId,
      title,
      url: `https://docs.google.com/document/d/${docId}/edit`,
    };
  }

  // Genera documento de cotización formal
  async createCotizacionDoc(
    cotizacion_id: string,
    empresa: string,
    cliente: string,
    items: Array<{ producto: string; cantidad: number; precio: number; subtotal: number }>,
    total: number,
    validaHasta: string,
  ): Promise<DocInfo> {
    const fecha = new Date().toLocaleDateString('es-BO');
    const itemsTexto = items.map(i =>
      `${i.cantidad}x ${i.producto} @ Bs. ${i.precio} = Bs. ${i.subtotal}`
    ).join('\n');

    const content = `COTIZACIÓN ${cotizacion_id}
${empresa}
Fecha: ${fecha}
Válida hasta: ${validaHasta}

CLIENTE: ${cliente}

DETALLE:
${itemsTexto}

TOTAL: Bs. ${total.toLocaleString('es-BO')}

Forma de pago: QR BCB / Tigo Money / Efectivo
Entrega: A coordinar

Gracias por su preferencia.
${empresa}`;

    return this.createDoc(`Cotización ${cotizacion_id} — ${cliente}`, content);
  }

  // Genera documento de orden de compra formal
  async createOrdenCompraDoc(
    orden_id: string,
    empresa: string,
    proveedor: string,
    items: Array<{ producto: string; cantidad: number; costo: number; subtotal: number }>,
    total: number,
    fechaEntrega: string,
  ): Promise<DocInfo> {
    const fecha = new Date().toLocaleDateString('es-BO');
    const itemsTexto = items.map(i =>
      `${i.cantidad}x ${i.producto} @ Bs. ${i.costo} = Bs. ${i.subtotal}`
    ).join('\n');

    const content = `ORDEN DE COMPRA ${orden_id}
${empresa}
Fecha: ${fecha}
Entrega estimada: ${fechaEntrega}

PROVEEDOR: ${proveedor}

DETALLE:
${itemsTexto}

TOTAL: Bs. ${total.toLocaleString('es-BO')}

Por favor confirmar recepción de esta orden.
${empresa}`;

    return this.createDoc(`Orden de Compra ${orden_id} — ${proveedor}`, content);
  }
}