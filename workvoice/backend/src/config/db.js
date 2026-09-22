import mysql from 'mysql2/promise';
import { env } from './env.js';

const baseOptions = {
  host: env.db.host,
  port: env.db.port,
  database: env.db.database,
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: true,
  // Colonnes DATE renvoyées telles quelles (« 2026-09-08 ») : pas de décalage de fuseau
  dateStrings: ['DATE'],
};

/** Pool principal de l'API. */
export const pool = mysql.createPool({
  ...baseOptions,
  user: env.db.user,
  password: env.db.password,
});

/**
 * Pool du module Direction. En production, il utilise un compte MySQL qui
 * n'a accès qu'aux vues anonymisées (voir database/02_views_security.sql).
 */
export const directionPool = env.dbDirection.user
  ? mysql.createPool({
      ...baseOptions,
      connectionLimit: 5,
      user: env.dbDirection.user,
      password: env.dbDirection.password,
    })
  : pool;

/** Exécute une requête paramétrée et renvoie les lignes. */
export async function query(sql, params = [], db = pool) {
  const [rows] = await db.query(sql, params);
  return rows;
}

/** Exécute une requête et renvoie la première ligne (ou null). */
export async function queryOne(sql, params = [], db = pool) {
  const rows = await query(sql, params, db);
  return rows[0] ?? null;
}

/** Exécute `fn(conn)` dans une transaction ; rollback automatique en cas d'erreur. */
export async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function closePools() {
  await pool.end();
  if (directionPool !== pool) await directionPool.end();
}
