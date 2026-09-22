/**
 * Initialise la base : schéma → vues → données de démo.
 *
 *   npm run db:init              # schéma + vues + seed
 *   npm run db:init -- --no-seed # schéma + vues uniquement
 *
 * ATTENTION : 01_schema.sql supprime et recrée toutes les tables.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { env } from '../src/config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.resolve(__dirname, '../../database');

const files = ['01_schema.sql', '02_views_security.sql'];
if (!process.argv.includes('--no-seed')) files.push('03_seed.sql');

if (env.isProd && !process.argv.includes('--force')) {
  console.error('Refusé en production (ajoutez --force si vous savez ce que vous faites).');
  process.exit(1);
}

const conn = await mysql.createConnection({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  multipleStatements: true,
  charset: 'utf8mb4',
});

try {
  for (const file of files) {
    const sql = fs.readFileSync(path.join(DB_DIR, file), 'utf8').replaceAll('USE workvoice;', `USE \`${env.db.database}\`;`)
      .replace('CREATE DATABASE IF NOT EXISTS workvoice', `CREATE DATABASE IF NOT EXISTS \`${env.db.database}\``);
    process.stdout.write(`→ ${file} … `);
    await conn.query(sql);
    console.info('ok');
  }
  console.info(`✔ Base « ${env.db.database} » initialisée.`);
} catch (err) {
  console.error('\n✖ Échec :', err.message);
  process.exitCode = 1;
} finally {
  await conn.end();
}
