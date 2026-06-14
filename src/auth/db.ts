import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

export async function initDB(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS empresas (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      nombre                TEXT NOT NULL,
      email                 TEXT UNIQUE NOT NULL,
      google_refresh_token  TEXT,
      sheet_id              TEXT,
      alegra_token          TEXT,
      whatsapp_token        TEXT,
      nit                   TEXT,
      ciudad                TEXT,
      moneda                TEXT DEFAULT 'BOB',
      activa                BOOLEAN DEFAULT true,
      created_at            TIMESTAMPTZ DEFAULT now()
    );
  `);
}

export async function getEmpresaByEmail(email: string) {
  const res = await pool.query('SELECT * FROM empresas WHERE email = $1', [email]);
  return res.rows[0] ?? null;
}

export async function upsertEmpresa(data: {
  email: string;
  nombre: string;
  google_refresh_token: string;
  sheet_id?: string;
}) {
  const res = await pool.query(`
    INSERT INTO empresas (email, nombre, google_refresh_token, sheet_id)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (email) DO UPDATE SET
      google_refresh_token = EXCLUDED.google_refresh_token,
      sheet_id = EXCLUDED.sheet_id
    RETURNING *
  `, [data.email, data.nombre, data.google_refresh_token, data.sheet_id ?? null]);
  return res.rows[0];
}

export async function getEmpresaById(id: string) {
  const res = await pool.query('SELECT * FROM empresas WHERE id = $1', [id]);
  return res.rows[0] ?? null;
}

export { pool };