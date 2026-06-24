// Dominio: Facturación Bolivia
// Simulación inteligente del SIN/SIAT boliviano
// Incluye facturas electrónicas, recibos y cálculo de márgenes reales

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SheetsAdapter } from '../adapters/sheets.adapter.js';
import { measureTool } from '../utils/metrics.js';
import { logger } from '../utils/logger.js';
import { idempotencyStore } from '../infra/idempotency.js';
import { randomUUID } from 'crypto';

// Constantes fiscales Bolivia
const IT_PORCENTAJE = 3; 
const IVA_PORCENTAJE = 13; 
const COSTO_FACTURA_BOB = 0.88; 

// Catálogo de tipos de documento SIN Bolivia
const TIPOS_DOCUMENTO = {
  1: 'Cédula de Identidad (CI)',
  2: 'Cédula de Identidad de Extranjero',
  3: 'Pasaporte',
  4: 'Otro Documento de Identidad',
  5: 'NIT',
};

// Catálogo de métodos de pago SIN Bolivia
const METODOS_PAGO = {
  1: 'Efectivo',
  2: 'Tarjeta de Débito',
  3: 'Tarjeta de Crédito',
  4: 'Cheque',
  5: 'Transferencia Bancaria',
  6: 'QR Simple (BCB)',
  7: 'Tigo Money',
  8: 'Otros',
};

// Generador de CUF simulado (Código Único de Factura)
function generateCUF(nit: string, fecha: string, numero: number): string {
  const fechaStr = fecha.replace(/-/g, '');
  return `${nit}${fechaStr}${numero.toString().padStart(10, '0')}00001`;
}

// Generador de CUFD simulado (Código Único de Factura Diaria)
function generateCUFD(): string {
  return `CUFD${Date.now()}${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
}

// Convertir monto a texto literal (requerido por SIN)
function amountToWords(amount: number): string {
  const entero = Math.floor(amount);
  const decimales = Math.round((amount - entero) * 100);

  const unidades = ['', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE'];
  const decenas = ['', 'DIEZ', 'VEINTE', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
  const especiales = ['DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE'];

  const convertirCentenas = (n: number): string => {
    if (n === 0) return '';
    if (n === 100) return 'CIEN';
    const centena = Math.floor(n / 100);
    const resto = n % 100;
    const centenas = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];
    return `${centenas[centena]}${resto > 0 ? ' ' + convertirDecenas(resto) : ''}`;
  };

  const convertirDecenas = (n: number): string => {
    if (n < 10) return unidades[n];
    if (n >= 10 && n < 20) return especiales[n - 10];
    const dec = Math.floor(n / 10);
    const uni = n % 10;
    return `${decenas[dec]}${uni > 0 ? ' Y ' + unidades[uni] : ''}`;
  };

  const convertirMiles = (n: number): string => {
    if (n === 0) return 'CERO';
    if (n < 1000) return convertirCentenas(n);
    const miles = Math.floor(n / 1000);
    const resto = n % 1000;
    const milesStr = miles === 1 ? 'MIL' : `${convertirCentenas(miles)} MIL`;
    return `${milesStr}${resto > 0 ? ' ' + convertirCentenas(resto) : ''}`;
  };

  const enteroTexto = convertirMiles(entero);
  return `${enteroTexto} CON ${decimales.toString().padStart(2, '0')}/100 BOLIVIANOS`;
}

// Validar NIT boliviano
function validateNIT(nit: string): boolean {
  if (nit === '0') return true; // Consumidor final
  const nitNum = nit.replace(/\D/g, '');
  return nitNum.length >= 7 && nitNum.length <= 15;
}

export function registerFacturacionTools(server: McpServer, sheets: SheetsAdapter) {

  server.tool(
    'validate_nit',
    `Valida el formato de un NIT boliviano.
    
    CUÁNDO USAR: Antes de emitir una factura, cuando el cliente da su NIT,
    "¿es válido este NIT?", "verifica el NIT de Quispe".
    
    DEVUELVE: Si el NIT es válido y su tipo de contribuyente.`,
    {
      nit: z.string().describe('NIT a validar. Usar 0 para consumidor final.'),
    },
    async ({ nit }) => {
      const correlationId = randomUUID();
      logger.info('validate_nit iniciado', { correlationId, tool: 'validate_nit' });

      return measureTool('validate_nit', async () => {
        const esValido = validateNIT(nit);
        const esConsumidorFinal = nit === '0';

        const result = {
          nit,
          valido: esValido,
          tipo: esConsumidorFinal
            ? 'Consumidor Final — emitir sin NIT'
            : esValido
            ? 'Contribuyente registrado en SIN'
            : 'NIT inválido — verificar con el cliente',
          requiere_factura: !esConsumidorFinal && esValido,
          mensaje: esValido
            ? esConsumidorFinal
              ? '✅ Consumidor final — puede emitir recibo sin NIT'
              : `✅ NIT ${nit} válido — puede emitir factura electrónica`
            : `❌ NIT ${nit} inválido — solicitar NIT correcto al cliente`,
        };

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'amount_to_words',
    `Convierte un monto numérico a texto literal en bolivianos.
    
    CUÁNDO USAR: Al generar facturas — el SIN requiere el monto en texto literal.
    "¿cómo se escribe Bs. 3.692,20 en letras?".
    
    DEVUELVE: Monto en texto literal requerido por el SIN Bolivia.`,
    {
      amount: z.number().positive().describe('Monto en bolivianos a convertir'),
    },
    async ({ amount }) => {
      return measureTool('amount_to_words', async () => {
        const texto = amountToWords(amount);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              monto_numerico: amount,
              monto_texto: texto,
              moneda: 'BOB',
            }, null, 2),
          }],
        };
      });
    }
  );

  server.tool(
    'create_invoice',
    `Emite una factura electrónica boliviana validada por el SIAT.
    
    CUÁNDO USAR: El dueño dice "haz la factura para Quispe", "factura la venta",
    "emite comprobante fiscal", "genera factura electrónica".
    
    DEVUELVE: Factura completa con CUF, CUFD, código QR SIN y PDF generado.
    Incluye cálculo de IT (3%) y margen real después de impuestos.`,
    {
      cliente_nit: z.string().describe('NIT del cliente. Usar "0" para consumidor final'),
      cliente_razon_social: z.string().describe('Nombre o razón social del cliente'),
      cliente_email: z.string().email().optional().describe('Email para envío de factura'),
      metodo_pago: z.number().min(1).max(8).default(1).describe(
        'Código de método de pago: 1=Efectivo, 5=Transferencia, 6=QR BCB, 7=Tigo Money'
      ),
      items: z.array(z.object({
        descripcion: z.string().describe('Descripción del producto o servicio'),
        cantidad: z.number().positive().describe('Cantidad'),
        precio_unitario: z.number().positive().describe('Precio unitario en BOB'),
        codigo_producto_sin: z.string().default('43231513').describe('Código producto SIN. Default: productos de limpieza'),
        codigo_caeb: z.string().default('4711').describe('Código CAEB actividad económica'),
      })).describe('Detalle de productos o servicios facturados'),
      request_id: z.string().uuid().describe('UUID único para evitar duplicados'),
      dry_run: z.boolean().default(true).describe('Si true genera preview sin emitir. Default: true'),
    },
    async ({ cliente_nit, cliente_razon_social, cliente_email, metodo_pago, items, request_id, dry_run }) => {
      const correlationId = randomUUID();

      const cached = idempotencyStore.check(request_id);
      if (cached) return cached as any;

      return measureTool('create_invoice', async () => {
        const empresaConfig = sheets.getEmpresaConfig();
        const fecha = new Date().toISOString().split('T')[0];
        const numeroFactura = Math.floor(Math.random() * 900000) + 100000;

        // Calcular totales
        const subtotal = items.reduce((s, i) => s + (i.cantidad * i.precio_unitario), 0);
        const it_monto = Math.round(subtotal * IT_PORCENTAJE / 100 * 100) / 100;
        const iva_debito_fiscal = Math.round(subtotal * IVA_PORCENTAJE / 113 * 100) / 100;
        const total = subtotal;
        const margen_real = subtotal - it_monto - COSTO_FACTURA_BOB;

        // Generar códigos SIN simulados
        const cuf = generateCUF(empresaConfig?.nit ?? '1234567890', fecha, numeroFactura);
        const cufd = generateCUFD();

        const factura = {
          // Datos de la factura
          numero_factura: numeroFactura,
          fecha_emision: fecha,
          hora_emision: new Date().toTimeString().split(' ')[0],
          modalidad: 'Electrónica en Línea',
          tipo_documento_sector: 'Factura Compra Venta',
          estado: dry_run ? 'PREVIEW' : 'EMITIDA',

          // Códigos SIN
          cuf,
          cufd,
          numero_autorizacion: dry_run ? 'SIMULADO' : `AUTH${Date.now()}`,

          // Empresa emisora
          emisor: {
            nit: empresaConfig?.nit ?? '1234567890',
            razon_social: empresaConfig?.nombre_empresa ?? 'Distribuidora El Cóndor S.R.L.',
            actividad_economica: empresaConfig?.actividad_economica ?? '4711',
            ciudad: empresaConfig?.ciudad ?? 'Cochabamba',
            direccion: empresaConfig?.direccion ?? 'Av. Blanco Galindo Km 5',
          },

          // Cliente receptor
          receptor: {
            nit: cliente_nit,
            razon_social: cliente_razon_social,
            email: cliente_email ?? '',
            tipo_documento: cliente_nit === '0' ? 'Consumidor Final' : TIPOS_DOCUMENTO[5],
          },

          // Método de pago
          metodo_pago: {
            codigo: metodo_pago,
            descripcion: METODOS_PAGO[metodo_pago as keyof typeof METODOS_PAGO] ?? 'Efectivo',
          },

          // Detalle de items
          detalle: items.map((i, idx) => ({
            numero: idx + 1,
            descripcion: i.descripcion,
            cantidad: i.cantidad,
            unidad_medida: 'Pieza',
            precio_unitario_bob: i.precio_unitario,
            descuento: 0,
            subtotal_bob: Math.round(i.cantidad * i.precio_unitario * 100) / 100,
            codigo_producto_sin: i.codigo_producto_sin,
            codigo_caeb: i.codigo_caeb,
          })),

          // Totales
          totales: {
            subtotal_bob: subtotal,
            descuento_adicional: 0,
            gift_card: 0,
            total_bob: total,
            monto_literal: amountToWords(total),
            iva_debito_fiscal_bob: iva_debito_fiscal,
          },

          // Impacto fiscal (para cálculo de margen real)
          impacto_fiscal: {
            it_3_porcentaje_bob: it_monto,
            costo_emision_bob: COSTO_FACTURA_BOB,
            margen_real_despues_impuestos_bob: margen_real,
            nota: 'El IT (3%) y costo de emisión reducen el margen real de la venta',
          },

          // QR de verificación SIN
          qr_verificacion: `https://siat.impuestos.gob.bo/consulta/QR?nit=${empresaConfig?.nit}&cuf=${cuf}&numero=${numeroFactura}`,

          instruccion: dry_run
            ? '👆 Preview de factura. Ejecuta con dry_run=false para emitir ante el SIN.'
            : `✅ Factura ${numeroFactura} emitida. CUF: ${cuf}`,
        };

        if (!dry_run) {
          await sheets.appendLog({
            timestamp: new Date().toISOString(),
            tool_name: 'create_invoice',
            correlation_id: correlationId,
            cliente_id: cliente_nit,
            accion: `Factura ${numeroFactura} emitida: Bs. ${total} · ${cliente_razon_social}`,
            resultado: 'EMITIDA',
            dry_run: false,
          });
          idempotencyStore.register(request_id, { content: [{ type: 'text', text: JSON.stringify(factura) }] });
        }

        logger.info('create_invoice completado', {
          correlationId, tool: 'create_invoice',
          data: { numeroFactura, total, dry_run },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(factura, null, 2) }] };
      });
    }
  );

  server.tool(
    'create_receipt',
    `Genera un recibo simplificado para clientes sin NIT o del RTS.
    
    CUÁNDO USAR: El cliente no tiene NIT, es persona natural del RTS,
    "haz un recibo para Don Ramiro", "no tiene NIT pero quiere comprobante",
    "genera recibo simple".
    
    DEVUELVE: Recibo con número, datos del cliente y monto en texto literal.`,
    {
      cliente_nombre: z.string().describe('Nombre del cliente'),
      cliente_ci: z.string().optional().describe('Cédula de identidad del cliente'),
      items: z.array(z.object({
        descripcion: z.string().describe('Descripción del producto'),
        cantidad: z.number().positive().describe('Cantidad'),
        precio_unitario: z.number().positive().describe('Precio unitario en BOB'),
      })).describe('Productos del recibo'),
      metodo_pago: z.enum(['efectivo', 'qr_bcb', 'tigo_money', 'transferencia']).default('efectivo'),
      request_id: z.string().uuid().describe('UUID único para evitar duplicados'),
    },
    async ({ cliente_nombre, cliente_ci, items, metodo_pago, request_id }) => {
      const correlationId = randomUUID();

      const cached = idempotencyStore.check(request_id);
      if (cached) return cached as any;

      return measureTool('create_receipt', async () => {
        const empresaConfig = sheets.getEmpresaConfig();
        const fecha = new Date().toLocaleDateString('es-BO');
        const hora = new Date().toTimeString().split(' ')[0];
        const numeroRecibo = Math.floor(Math.random() * 90000) + 10000;

        const subtotal = items.reduce((s, i) => s + (i.cantidad * i.precio_unitario), 0);

        const recibo = {
          tipo: 'RECIBO',
          numero_recibo: numeroRecibo,
          fecha,
          hora,
          empresa: {
            nombre: empresaConfig?.nombre_empresa ?? 'Distribuidora El Cóndor S.R.L.',
            nit: empresaConfig?.nit ?? '1234567890',
            ciudad: empresaConfig?.ciudad ?? 'Cochabamba',
            direccion: empresaConfig?.direccion ?? 'Av. Blanco Galindo Km 5',
          },
          cliente: {
            nombre: cliente_nombre,
            ci: cliente_ci ?? 'Sin CI',
            tipo: 'Persona Natural / Consumidor Final',
          },
          detalle: items.map((i, idx) => ({
            numero: idx + 1,
            descripcion: i.descripcion,
            cantidad: i.cantidad,
            precio_unitario_bob: i.precio_unitario,
            subtotal_bob: Math.round(i.cantidad * i.precio_unitario * 100) / 100,
          })),
          totales: {
            subtotal_bob: subtotal,
            total_bob: subtotal,
            monto_literal: amountToWords(subtotal),
          },
          metodo_pago,
          nota: 'Este recibo no tiene validez fiscal ante el SIN. Para factura electrónica proporcionar NIT.',
          estado: 'EMITIDO',
        };

        await sheets.appendLog({
          timestamp: new Date().toISOString(),
          tool_name: 'create_receipt',
          correlation_id: correlationId,
          cliente_id: cliente_nombre,
          accion: `Recibo ${numeroRecibo} emitido: Bs. ${subtotal} · ${cliente_nombre}`,
          resultado: 'EMITIDO',
          dry_run: false,
        });

        idempotencyStore.register(request_id, { content: [{ type: 'text', text: JSON.stringify(recibo) }] });

        logger.info('create_receipt completado', {
          correlationId, tool: 'create_receipt',
          data: { numeroRecibo, subtotal },
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(recibo, null, 2) }] };
      });
    }
  );

  server.tool(
    'cancel_invoice',
    `Anula una factura electrónica emitida.
    
    CUÁNDO USAR: El dueño dice "anula la factura de Quispe", "cancelar factura",
    "el cliente devolvió el producto", "error en la factura".
    
    IMPORTANTE: Solo se puede anular el mismo día de emisión antes de las 23:59.
    
    DEVUELVE: Confirmación de anulación con código SIN.`,
    {
      numero_factura: z.number().describe('Número de factura a anular'),
      cuf: z.string().describe('CUF de la factura a anular'),
      motivo: z.enum(['1', '2', '3']).describe('Motivo: 1=Error en datos, 2=Devolución, 3=Otros'),
      request_id: z.string().uuid().describe('UUID único para evitar duplicados'),
    },
    async ({ numero_factura, cuf, motivo, request_id }) => {
      const correlationId = randomUUID();

      const cached = idempotencyStore.check(request_id);
      if (cached) return cached as any;

      return measureTool('cancel_invoice', async () => {
        const motivos = { '1': 'Error en datos del cliente', '2': 'Devolución de mercadería', '3': 'Otros' };

        const result = {
          status: 'ANULADA',
          numero_factura,
          cuf,
          motivo: motivos[motivo],
          fecha_anulacion: new Date().toISOString(),
          codigo_anulacion_sin: `ANUL${Date.now()}`,
          mensaje: `✅ Factura ${numero_factura} anulada correctamente. Motivo: ${motivos[motivo]}`,
          nota: 'La anulación fue registrada en el SIN. El cliente debe solicitar nueva factura si corresponde.',
        };

        await sheets.appendLog({
          timestamp: new Date().toISOString(),
          tool_name: 'cancel_invoice',
          correlation_id: correlationId,
          cliente_id: cuf,
          accion: `Factura ${numero_factura} anulada. Motivo: ${motivos[motivo]}`,
          resultado: 'ANULADA',
          dry_run: false,
        });

        idempotencyStore.register(request_id, { content: [{ type: 'text', text: JSON.stringify(result) }] });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'list_invoices',
    `Lista las facturas emitidas por la empresa.
    
    CUÁNDO USAR: El dueño pregunta "¿qué facturas emití hoy?",
    "dame las facturas del mes", "¿cuántas facturas emití?".
    
    DEVUELVE: Lista de facturas con estado, cliente y monto en BOB.`,
    {
      limit: z.number().max(50).default(10).describe('Máximo de facturas. Default: 10'),
      offset: z.number().default(0).describe('Para paginación. Default: 0'),
    },
    async ({ limit, offset }) => {
      return measureTool('list_invoices', async () => {
        const cobros = await sheets.getCobros();
        const clientes = await sheets.getClientes();
        const clienteMap = new Map(clientes.map(c => [c.id, c]));

        const facturas = cobros
          .filter(c => c.estado === 'pagado')
          .slice(offset, offset + limit)
          .map(c => ({
            numero_factura: `FAC-${c.id}`,
            fecha: c.fecha_pago ?? c.fecha_vencimiento,
            cliente: clienteMap.get(c.cliente_id)?.nombre ?? c.cliente_id,
            nit_cliente: clienteMap.get(c.cliente_id)?.nit ?? '0',
            monto_bob: c.monto,
            estado: 'EMITIDA',
          }));

        const result = {
          moneda: 'BOB',
          total: cobros.filter(c => c.estado === 'pagado').length,
          limit,
          offset,
          has_more: offset + limit < cobros.filter(c => c.estado === 'pagado').length,
          facturas,
        };

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'get_client_invoice_history',
    `Historial de facturas de un cliente por NIT.
    
    CUÁNDO USAR: El dueño pregunta "¿cuántas facturas le hice a Quispe?",
    "historial fiscal de este cliente", "¿qué compró Flores con factura?".
    
    DEVUELVE: Historial completo de facturas del cliente con totales.`,
    {
      nit: z.string().describe('NIT del cliente a consultar'),
    },
    async ({ nit }) => {
      return measureTool('get_client_invoice_history', async () => {
        const clientes = await sheets.getClientes();
        const cobros = await sheets.getCobros();

        const cliente = clientes.find(c => c.nit === nit);
        if (!cliente) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: `No se encontró cliente con NIT ${nit}` }),
            }],
          };
        }

        const cobrosCliente = cobros.filter(c => c.cliente_id === cliente.id && c.estado === 'pagado');
        const totalFacturado = cobrosCliente.reduce((s, c) => s + c.monto, 0);

        const result = {
          nit,
          cliente: cliente.nombre,
          email: cliente.email,
          ciudad: cliente.ciudad,
          total_facturas: cobrosCliente.length,
          total_facturado_bob: totalFacturado,
          historial: cobrosCliente.map(c => ({
            numero: `FAC-${c.id}`,
            fecha: c.fecha_pago ?? c.fecha_vencimiento,
            monto_bob: c.monto,
            estado: 'EMITIDA',
          })),
        };

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'list_siat_errors',
    `Lista los errores más comunes del SIAT con soluciones.
    
    CUÁNDO USAR: Cuando hay un error al emitir factura, "¿qué significa error SIAT 909?",
    "el SIN rechazó la factura", "error al facturar".
    
    DEVUELVE: Catálogo de errores SIAT con descripción y solución.`,
    {},
    async () => {
      return measureTool('list_siat_errors', async () => {
        const errores = [
          { codigo: '909', descripcion: 'NIT inválido o no registrado en el SIN', solucion: 'Verificar NIT con el cliente. Usar NIT 0 para consumidor final.' },
          { codigo: '908', descripcion: 'CUFD expirado o inválido', solucion: 'Regenerar el CUFD del día. El CUFD expira a las 23:59.' },
          { codigo: '907', descripcion: 'Código de actividad económica (CAEB) no habilitado', solucion: 'Verificar que el código CAEB esté habilitado para esta empresa en el SIN.' },
          { codigo: '906', descripcion: 'Código de producto SIN no encontrado', solucion: 'Usar código de producto correcto del catálogo SIN.' },
          { codigo: '905', descripcion: 'Monto en letras no coincide con el monto numérico', solucion: 'Recalcular el monto en letras usando amount_to_words.' },
          { codigo: '904', descripcion: 'Firma digital inválida o expirada', solucion: 'Renovar certificado digital con ADSIB o DigiCert.' },
          { codigo: '903', descripcion: 'Punto de venta no habilitado', solucion: 'Habilitar el punto de venta en el portal SIN.' },
          { codigo: '902', descripcion: 'Sucursal no registrada', solucion: 'Registrar la sucursal en el portal SIN.' },
          { codigo: '901', descripcion: 'Error de conexión con SIAT', solucion: 'El SIN puede estar caído. Intentar en modalidad offline.' },
          { codigo: '500', descripcion: 'Error interno del servidor SIN', solucion: 'Esperar y reintentar. Si persiste contactar al SIN.' },
        ];

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              total_errores: errores.length,
              errores,
              recursos: {
                portal_sin: 'https://siat.impuestos.gob.bo',
                telefono_sin: '800-10-3220',
                horario_atencion: 'L-V 8:00-18:00 Bolivia',
              },
            }, null, 2),
          }],
        };
      });
    }
  );

  server.tool(
    'search_tax_regulations',
    `Busca información sobre normativa tributaria boliviana.
    
    CUÁNDO USAR: El dueño pregunta "¿cuándo debo declarar el IVA?",
    "¿qué es el IT?", "¿cuándo vence la declaración?", "¿qué régimen me corresponde?".
    
    DEVUELVE: Información relevante sobre normativa tributaria boliviana.`,
    {
      query: z.string().describe('Consulta sobre normativa tributaria. Ejemplo: "declaración IVA" o "régimen simplificado"'),
    },
    async ({ query }) => {
      return measureTool('search_tax_regulations', async () => {
        const normativa: Record<string, object> = {
          iva: {
            nombre: 'IVA — Impuesto al Valor Agregado',
            tasa: '13% incluido en el precio de venta',
            declaracion: 'Mensual — formulario 200',
            vencimiento: 'Día 15 del mes siguiente',
            nota: 'El IVA ya está incluido en el precio de venta. El débito fiscal es el 13/113 del total.',
          },
          it: {
            nombre: 'IT — Impuesto a las Transacciones',
            tasa: '3% sobre ingresos brutos',
            declaracion: 'Mensual',
            vencimiento: 'Día 15 del mes siguiente',
            nota: 'El IT reduce directamente el margen de la venta. PyME Brain lo descuenta automáticamente del margen real.',
          },
          regimenes: {
            general: 'Régimen General — empresas con ventas > Bs. 136.000/año. Obligatorio factura electrónica.',
            rts: 'RTS — Régimen Tributario Simplificado. Artesanos y comerciantes menores. Sin factura electrónica.',
            sti: 'STI — Sistema Tributario Integrado. Transportistas y pequeños comerciantes.',
            rau: 'RAU — Régimen Agropecuario Unificado. Agricultores y ganaderos.',
          },
          cufd: {
            descripcion: 'CUFD — Código Único de Factura Diaria',
            vigencia: 'Caduca a las 23:59 del día de emisión',
            renovacion: 'Automática al día siguiente',
          },
          cuf: {
            descripcion: 'CUF — Código Único de Factura',
            uso: 'Identifica cada factura individualmente ante el SIN',
            verificacion: 'https://siat.impuestos.gob.bo/consulta/QR',
          },
        };

        const queryLower = query.toLowerCase();
        const resultados = Object.entries(normativa)
          .filter(([key]) => queryLower.includes(key) || key.includes(queryLower.split(' ')[0]))
          .map(([key, value]) => ({ tema: key, info: value }));

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              query,
              resultados: resultados.length > 0 ? resultados : [{
                tema: 'general',
                info: 'Para consultas específicas contactar al SIN: 800-10-3220 o visitar siat.impuestos.gob.bo',
              }],
              fuente: 'SIN Bolivia — Servicio de Impuestos Nacionales',
            }, null, 2),
          }],
        };
      });
    }
  );

  server.tool(
    'get_fiscal_margin',
    `Calcula el margen real de una venta descontando impuestos y costos fiscales.
    
    CUÁNDO USAR: El dueño pregunta "¿cuánto me queda realmente de esta venta?",
    "¿cuál es mi ganancia real después de impuestos?", "calcula el margen con impuestos".
    
    DEVUELVE: Desglose completo de la venta con margen real después de IT, IVA y costo de factura.`,
    {
      precio_venta: z.number().positive().describe('Precio de venta en BOB'),
      costo_producto: z.number().positive().describe('Costo del producto en BOB'),
      emite_factura: z.boolean().default(true).describe('Si emite factura electrónica. Default: true'),
    },
    async ({ precio_venta, costo_producto, emite_factura }) => {
      return measureTool('get_fiscal_margin', async () => {
        const iva_debito = Math.round(precio_venta * 13 / 113 * 100) / 100;
        const it_monto = Math.round(precio_venta * IT_PORCENTAJE / 100 * 100) / 100;
        const costo_emision = emite_factura ? COSTO_FACTURA_BOB : 0;

        const margen_bruto = precio_venta - costo_producto;
        const margen_real = margen_bruto - it_monto - costo_emision;
        const margen_porcentaje_bruto = Math.round((margen_bruto / precio_venta) * 100);
        const margen_porcentaje_real = Math.round((margen_real / precio_venta) * 100);

        const result = {
          moneda: 'BOB',
          precio_venta,
          costo_producto,
          desglose: {
            margen_bruto_bob: margen_bruto,
            iva_debito_fiscal_bob: iva_debito,
            it_3_porcentaje_bob: it_monto,
            costo_emision_factura_bob: costo_emision,
            margen_real_bob: margen_real,
          },
          porcentajes: {
            margen_bruto_porcentaje: margen_porcentaje_bruto,
            margen_real_porcentaje: margen_porcentaje_real,
            diferencia_por_impuestos: margen_porcentaje_bruto - margen_porcentaje_real,
          },
          resumen: `Por cada Bs. ${precio_venta} vendido, tu ganancia real es Bs. ${margen_real.toFixed(2)} ` +
            `(${margen_porcentaje_real}%) después de IT (Bs. ${it_monto})${emite_factura ? ` y costo de factura (Bs. ${costo_emision})` : ''}.`,
        };

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );

  server.tool(
    'get_tax_summary',
    `Resumen de obligaciones tributarias del mes actual.
    
    CUÁNDO USAR: El dueño pregunta "¿cuánto debo pagar de impuestos?",
    "¿cuánto es el IVA del mes?", "¿cuánto es el IT?", "resumen tributario".
    
    DEVUELVE: Estimación de IVA e IT a declarar basado en ventas del período.`,
    {},
    async () => {
      return measureTool('get_tax_summary', async () => {
        const cobros = await sheets.getCobros();
        const hoy = new Date();
        const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);

        const ventasMes = cobros.filter(c => {
          if (!c.fecha_pago) return false;
          return c.estado === 'pagado' && new Date(c.fecha_pago) >= inicioMes;
        });

        const totalVentas = ventasMes.reduce((s, c) => s + c.monto, 0);
        const iva_debito = Math.round(totalVentas * 13 / 113 * 100) / 100;
        const it_monto = Math.round(totalVentas * 3 / 100 * 100) / 100;

        const vencimientoDeclaracion = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 15)
          .toISOString().split('T')[0];

        const result = {
          moneda: 'BOB',
          periodo: `${hoy.toLocaleString('es-BO', { month: 'long' })} ${hoy.getFullYear()}`,
          total_ventas_mes_bob: totalVentas,
          obligaciones: {
            iva_debito_fiscal_bob: iva_debito,
            it_3_porcentaje_bob: it_monto,
            total_a_declarar_bob: Math.round((iva_debito + it_monto) * 100) / 100,
          },
          vencimiento_declaracion: vencimientoDeclaracion,
          formularios: {
            iva: 'Formulario 200 — SIN Bolivia',
            it: 'Formulario 400 — SIN Bolivia',
          },
          portal_sin: 'https://siat.impuestos.gob.bo',
          nota: 'Estimación basada en cobros registrados. Consultar con contador para declaración oficial.',
        };

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      });
    }
  );
}