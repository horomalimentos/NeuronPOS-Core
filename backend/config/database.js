import pg from 'pg';
import './env.js';

const { Pool } = pg;

// Los NUMERIC llegan como string por defecto; los dejamos asi y convertimos
// donde haga falta (evita perder precision en montos).

function buildConfig() {
  const common = {
    max: parseInt(process.env.DB_POOL_MAX, 10) || 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT, 10) || 5000,
  };
  if (process.env.DATABASE_URL) {
    return { ...common, connectionString: process.env.DATABASE_URL };
  }
  return {
    ...common,
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'neuronpos_core',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  };
}

const pool = new Pool(buildConfig());

pool.on('error', (err) => {
  console.error('Error inesperado en una conexion inactiva del pool:', err.message);
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function inTransaction(setup, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setup(client);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* conexion rota */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Ejecuta fn(db) dentro de una transaccion con el contexto RLS del
 * restaurante. Todas las consultas a tablas por restaurante DEBEN pasar por
 * aqui: fuera de este contexto las politicas RLS no regresan filas.
 */
export function withTenant(restaurantId, fn) {
  if (!restaurantId || !UUID_RE.test(String(restaurantId))) {
    return Promise.reject(new Error('withTenant requiere un restaurant_id valido'));
  }
  return inTransaction(
    (c) => c.query("SELECT set_config('app.restaurant_id', $1, true)", [String(restaurantId)]),
    fn,
  );
}

/**
 * Contexto de plataforma (Panel NeuronPOS): puede ver todos los restaurantes.
 * Solo debe usarse en rutas protegidas por requirePlatformAdmin o en scripts.
 */
export function withPlatform(fn) {
  return inTransaction(
    (c) => c.query("SELECT set_config('app.is_platform', 'on', true)"),
    fn,
  );
}

/**
 * Contexto de un repartidor de la flota de la plataforma (fase 5): con RLS
 * solo ve su propia fila, sus ofertas, sus cortes y las solicitudes de
 * reparto que tiene asignadas. Las tablas de los restaurantes siguen
 * cerradas (no hay app.restaurant_id).
 */
export function withFleetDriver(driverId, fn) {
  if (!driverId || !UUID_RE.test(String(driverId))) {
    return Promise.reject(new Error('withFleetDriver requiere un id de repartidor valido'));
  }
  return inTransaction(
    (c) => c.query("SELECT set_config('app.fleet_driver_id', $1, true)", [String(driverId)]),
    fn,
  );
}

/**
 * Dentro de una transaccion ya abierta (Panel o repartidor de la flota),
 * corre fn con el contexto RLS de UN restaurante y luego lo quita. Lo usa la
 * sincronizacion de una solicitud de reparto con la orden del restaurante.
 */
export async function asTenant(db, restaurantId, fn) {
  if (!restaurantId || !UUID_RE.test(String(restaurantId))) throw new Error('asTenant requiere un restaurant_id valido');
  const prev = (await db.query("SELECT coalesce(current_setting('app.restaurant_id', true), '') AS v")).rows[0].v;
  await db.query("SELECT set_config('app.restaurant_id', $1, true)", [String(restaurantId)]);
  // Si fn falla la transaccion completa se revierte: no hace falta restaurar.
  const result = await fn(db);
  await db.query("SELECT set_config('app.restaurant_id', $1, true)", [prev]);
  return result;
}

/**
 * Advierte si el rol de la app se salta RLS (superuser o BYPASSRLS).
 * Con REQUIRE_RLS_ROLE=true el servidor se niega a arrancar en ese caso.
 */
export async function checkDbRole() {
  const { rows } = await pool.query(
    'SELECT current_user AS usr, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  const r = rows[0];
  const bypass = r && (r.rolsuper || r.rolbypassrls);
  return { user: r?.usr, bypassesRls: Boolean(bypass) };
}

export default pool;
