// Avisos en vivo (Server-Sent Events): cuando cambia una orden, las pantallas
// de caja, cocina y pedidos en linea de esa sucursal se actualizan al instante
// (siguen consultando cada pocos segundos por si se cae la conexion).
//
// Usa LISTEN/NOTIFY de Postgres como canal: funciona con varios procesos y el
// aviso sale solo cuando el cambio ya esta guardado.
import { EventEmitter } from 'node:events';
import pg from 'pg';
import pool, { buildConfig } from '../config/database.js';
import { env } from '../config/env.js';

const CHANNEL = 'neuronpos_live';
const bus = new EventEmitter();
bus.setMaxListeners(0);
let client = null;
let starting = null;

async function ensureListener() {
  if (client) return;
  if (starting) { await starting; return; }
  starting = (async () => {
    const c = new pg.Client(buildConfig());
    c.on('notification', (m) => {
      try {
        const d = JSON.parse(m.payload);
        bus.emit(d.r, d);
      } catch { /* aviso mal formado */ }
    });
    const drop = () => { if (client === c) client = null; };
    c.on('error', (err) => { if (!env.isTest) console.error('[live]', err.message); drop(); });
    c.on('end', drop);
    await c.connect();
    await c.query(`LISTEN ${CHANNEL}`);
    client = c;
  })();
  try { await starting; } finally { starting = null; }
}

/** Avisa a las pantallas de la sucursal (branchId null = todo el restaurante). */
export async function publishLive(restaurantId, branchId, type = 'orders') {
  try {
    await pool.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify({ r: restaurantId, b: branchId || null, t: type })]);
  } catch (err) {
    if (!env.isTest) console.error('[live]', err.message);
  }
}

/** Escucha los avisos de un restaurante. Regresa la funcion para dejar de escuchar. */
export async function subscribeLive(restaurantId, fn) {
  await ensureListener();
  bus.on(restaurantId, fn);
  return () => bus.off(restaurantId, fn);
}

/** Pruebas / apagado: cierra la conexion de escucha. */
export async function stopLive() {
  const c = client;
  client = null;
  if (c) await c.end().catch(() => {});
}

/**
 * Middleware: despues de un cambio correcto (POST/PUT/PATCH/DELETE) en caja o
 * en el portal, avisa a la sucursal de la orden.
 */
export function liveAfterChange(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const json = res.json.bind(res);
  let body = null;
  res.json = (data) => { body = data; return json(data); };
  res.on('finish', () => {
    if (!req.tenant || res.statusCode >= 400) return;
    const o = body?.order || body?.session || null;
    const branchId = o?.branch_id || o?.branch?.id || req.body?.branch_id || null;
    publishLive(req.tenant.id, typeof branchId === 'string' ? branchId : null, 'orders');
  });
  next();
}
