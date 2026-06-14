import { google } from 'googleapis';
import { CircuitBreaker } from '../infra/circuit-breaker.js';
import { withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import { cache } from '../infra/cache.js';

export interface EmailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  body?: string;
}

export class GmailAdapter {
  private breaker = new CircuitBreaker('Gmail');
  private gmail;

  constructor(auth?: any) {
    const authClient = auth ?? (() => {
      const a = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
      );
      a.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
      return a;
    })();
    this.gmail = google.gmail({ version: 'v1', auth: authClient });
  }

  async searchEmails(query: string, maxResults = 10): Promise<EmailMessage[]> {
    const cacheKey = `gmail:${query}:${maxResults}`;
    const cached = cache.get<EmailMessage[]>(cacheKey);
    if (cached) return cached;

    const result = await this.breaker.call(() =>
      withRetry(() =>
        this.gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults,
        })
      )
    );

    const messages = result.data.messages ?? [];
    if (messages.length === 0) return [];

    const emails = await Promise.all(
      messages.slice(0, maxResults).map(async msg => {
        const detail = await this.breaker.call(() =>
          withRetry(() =>
            this.gmail.users.messages.get({
              userId: 'me',
              id: msg.id!,
              format: 'metadata',
              metadataHeaders: ['From', 'To', 'Subject', 'Date'],
            })
          )
        );
        const headers = detail.data.payload?.headers ?? [];
        const getHeader = (name: string) =>
          headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
        return {
          id: msg.id!,
          from: getHeader('From'),
          to: getHeader('To'),
          subject: getHeader('Subject'),
          date: getHeader('Date'),
          snippet: detail.data.snippet ?? '',
        };
      })
    );

    cache.set(cacheKey, emails, 2 * 60 * 1000);
    return emails;
  }

  async sendEmail(to: string, subject: string, body: string): Promise<string> {
    const email = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].join('\n');
    const encoded = Buffer.from(email).toString('base64url');
    const result = await this.breaker.call(() =>
      withRetry(() =>
        this.gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw: encoded },
        })
      )
    );
    logger.info('Email enviado', { data: { to, subject, messageId: result.data.id } });
    return result.data.id ?? '';
  }

  async getSupplierEmails(maxResults = 10): Promise<EmailMessage[]> {
    return this.searchEmails('factura OR proveedor OR cotización OR orden', maxResults);
  }

  async getPaymentEmails(maxResults = 10): Promise<EmailMessage[]> {
    return this.searchEmails('pago OR transferencia OR depósito OR comprobante', maxResults);
  }
}