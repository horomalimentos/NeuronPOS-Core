#!/usr/bin/env node
// Corre en orden los archivos db/migrations/NNN_*.sql que falten.
// Cada archivo se aplica en su propia transaccion y se registra en
// schema_migrations; si falla, se revierte y el proceso termina con error.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, '../../db/migrations');

export async function runMigrations(pool, { log = console.log } = {}) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const files = (await fs.readdir(MIGRATIONS_DIR))
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    log('Base de datos al dia: no hay migraciones pendientes.');
    return [];
  }

  for (const file of pending) {
    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      log(`Aplicada ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Fallo la migracion ${file}: ${err.message}`);
    } finally {
      client.release();
    }
  }
  return pending;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const { default: pool } = await import('../config/database.js');
  try {
    await runMigrations(pool);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
