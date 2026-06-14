// Configuración dinámica de empresa
// Lee las pestañas Empresa y Config del Google Sheet
// Permite que cada empresa tenga su propia estructura de datos
// sin modificar el código

import { logger } from '../utils/logger.js';

export interface EmpresaConfig {
  nombre_empresa: string;
  nit: string;
  ciudad: string;
  pais: string;
  moneda: string;
  timezone: string;
  actividad_economica: string;
  telefono_empresa: string;
  email_empresa: string;
  direccion: string;
  regimen_tributario: string;
}

export interface ColumnMapping {
  campo_sistema: string;
  columna_sheet: string;
  pestana: string;
  obligatorio: boolean;
}

export interface SheetConfig {
  empresa: EmpresaConfig;
  mappings: ColumnMapping[];
  // Índice de columnas por pestaña
  // Ejemplo: columnIndex['Clientes']['nombre'] = 1
  columnIndex: Record<string, Record<string, number>>;
}

export class EmpresaConfigLoader {
  private config: SheetConfig | null = null;

  // Carga la configuración desde el Sheet
  async load(sheets: {
    readTab: (tab: string) => Promise<string[][]>
  }): Promise<SheetConfig> {

    logger.info('Cargando configuración de empresa desde Sheet...');

    // 1. Leer pestaña Empresa
    const empresaRows = await sheets.readTab('Empresa');
    const empresaData: Record<string, string> = {};
    empresaRows.slice(1).forEach(row => {
      if (row[0] && row[1]) {
        empresaData[row[0]] = row[1];
      }
    });

    const empresa: EmpresaConfig = {
      nombre_empresa: empresaData['nombre_empresa'] ?? 'Mi Empresa',
      nit: empresaData['nit'] ?? '',
      ciudad: empresaData['ciudad'] ?? '',
      pais: empresaData['pais'] ?? 'Bolivia',
      moneda: empresaData['moneda'] ?? 'BOB',
      timezone: empresaData['timezone'] ?? 'America/La_Paz',
      actividad_economica: empresaData['actividad_economica'] ?? '',
      telefono_empresa: empresaData['telefono_empresa'] ?? '',
      email_empresa: empresaData['email_empresa'] ?? '',
      direccion: empresaData['direccion'] ?? '',
      regimen_tributario: empresaData['regimen_tributario'] ?? 'General',
    };

    // 2. Leer pestaña Config
    const configRows = await sheets.readTab('Config');
    const mappings: ColumnMapping[] = configRows.slice(1)
      .filter(row => row[0] && row[1] && row[2])
      .map(row => ({
        campo_sistema: row[0],
        columna_sheet: row[1],
        pestana: row[2],
        obligatorio: row[3] === 'si',
      }));

    // 3. Construir índice de columnas por pestaña
    // Para cada pestaña lee los headers reales y mapea campo → índice
    const pestanas = [...new Set(mappings.map(m => m.pestana))];
    const columnIndex: Record<string, Record<string, number>> = {};

    for (const pestana of pestanas) {
      const rows = await sheets.readTab(pestana);
      const headers = rows[0] ?? [];
      columnIndex[pestana] = {};

      mappings
        .filter(m => m.pestana === pestana)
        .forEach(m => {
          const idx = headers.indexOf(m.columna_sheet);
          if (idx === -1 && m.obligatorio) {
            logger.warn(`Columna obligatoria no encontrada`, {
              data: { pestana, columna: m.columna_sheet, campo: m.campo_sistema }
            });
          }
          columnIndex[pestana][m.campo_sistema] = idx;
        });
    }

    this.config = { empresa, mappings, columnIndex };

    logger.info('Configuración de empresa cargada', {
      data: {
        empresa: empresa.nombre_empresa,
        ciudad: empresa.ciudad,
        moneda: empresa.moneda,
        mappings: mappings.length,
      }
    });

    return this.config;
  }

  // Helper para obtener el valor de una fila según el campo del sistema
  getValue(
    config: SheetConfig,
    pestana: string,
    campo_sistema: string,
    row: string[]
  ): string {
    const idx = config.columnIndex[pestana]?.[campo_sistema];
    if (idx === undefined || idx === -1) return '';
    return row[idx] ?? '';
  }

  getConfig(): SheetConfig | null {
    return this.config;
  }
}

export const empresaConfigLoader = new EmpresaConfigLoader();