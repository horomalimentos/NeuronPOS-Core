// NeuronPOS Delivery (fase 4): chat de tres partes por pedido.
//
// - Cliente: con el token del seguimiento.
// - Restaurante: con su sesion (RLS de su restaurante).
// - Repartidor: solo el que lleva el pedido.
// Se puede escribir mientras el pedido esta en curso (nuevo .. en_camino); se
// lee hasta 1 dia despues. Nunca se muestran telefonos ni datos de otros.
import { withPlatform, withTenant } from '../config/database.js';
import { HttpError, badRequest, notFound } from '../utils/http.js';

export const CHAT_OPEN = ['nuevo', 'aceptado', 'listo', 'en_camino'];
const MAX_BODY = 500;

export function readMessageBody(body) {
  const text = typeof body?.body === 'string' ? body.body.trim() : '';
  if (!text) throw badRequest('Escribe un mensaje', 'MISSING_FIELD');
  if (text.length > MAX_BODY) throw badRequest(`El mensaje es muy largo (maximo ${MAX_BODY})`, 'INVALID_FIELD');
  return text;
}

const view = (m) => ({ id: m.id, sender: m.sender, sender_name: m.sender_name, body: m.body, created_at: m.created_at });

async function list(db, orderId) {
  return (await db.query(
    `SELECT id, sender, sender_name, body, created_at FROM marketplace_messages
      WHERE marketplace_order_id = $1 ORDER BY created_at, id LIMIT 300`,
    [orderId],
  )).rows.map(view);
}

function checkReadable(m) {
  if (m.status === 'pago_pendiente') throw notFound('Pedido no encontrado', 'ORDER_NOT_FOUND');
  const closedAt = m.delivered_at || m.cancelled_at;
  if (!CHAT_OPEN.includes(m.status) && closedAt && Date.now() - new Date(closedAt).getTime() > 86400000) {
    throw new HttpError(410, 'El chat de este pedido ya se cerro', 'CHAT_CLOSED');
  }
}

function checkWritable(m) {
  if (!CHAT_OPEN.includes(m.status)) throw new HttpError(409, 'El pedido ya termino; el chat es solo de lectura', 'CHAT_CLOSED');
}

const meta = (m) => ({ open: CHAT_OPEN.includes(m.status), status: m.status, driver_assigned: Boolean(m.driver_id) });

// --- Cliente --------------------------------------------------------------

async function orderByToken(db, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 64) throw notFound('Pedido no encontrado', 'ORDER_NOT_FOUND');
  const m = (await db.query('SELECT * FROM marketplace_orders WHERE public_token = $1', [token])).rows[0];
  if (!m) throw notFound('Pedido no encontrado', 'ORDER_NOT_FOUND');
  return m;
}

export async function customerChat(token) {
  return withPlatform(async (db) => {
    const m = await orderByToken(db, token);
    checkReadable(m);
    return { ...meta(m), messages: await list(db, m.id) };
  });
}

export async function customerSend(token, text) {
  return withPlatform(async (db) => {
    const m = await orderByToken(db, token);
    checkReadable(m);
    checkWritable(m);
    await db.query(
      `INSERT INTO marketplace_messages (marketplace_order_id, restaurant_id, sender, sender_name, body)
       VALUES ($1, $2, 'cliente', $3, $4)`,
      [m.id, m.restaurant_id, m.customer_name || 'Cliente', text],
    );
    return { ...meta(m), messages: await list(db, m.id) };
  });
}

// --- Restaurante (RLS) ----------------------------------------------------

async function tenantOrder(db, rid, id) {
  const m = (await db.query('SELECT * FROM marketplace_orders WHERE id = $1 AND restaurant_id = $2', [id, rid])).rows[0];
  if (!m) throw notFound('Pedido no encontrado', 'ORDER_NOT_FOUND');
  return m;
}

export async function restaurantChat(rid, id) {
  return withTenant(rid, async (db) => {
    const m = await tenantOrder(db, rid, id);
    checkReadable(m);
    return { ...meta(m), messages: await list(db, m.id) };
  });
}

export async function restaurantSend(rid, id, user, text) {
  return withTenant(rid, async (db) => {
    const m = await tenantOrder(db, rid, id);
    checkReadable(m);
    checkWritable(m);
    const name = (await db.query('SELECT name FROM restaurants WHERE id = $1', [rid])).rows[0]?.name || 'Restaurante';
    await db.query(
      `INSERT INTO marketplace_messages (marketplace_order_id, restaurant_id, sender, sender_name, user_id, body)
       VALUES ($1, $2, 'restaurante', $3, $4, $5)`,
      [m.id, rid, name, user.id, text],
    );
    return { ...meta(m), messages: await list(db, m.id) };
  });
}

// --- Repartidor -----------------------------------------------------------

async function driverOrder(db, driverId, id) {
  const m = (await db.query('SELECT * FROM marketplace_orders WHERE id = $1', [id])).rows[0];
  if (!m || m.driver_id !== driverId) throw notFound('Pedido no encontrado', 'ORDER_NOT_FOUND');
  return m;
}

export async function driverChat(driverId, id) {
  return withPlatform(async (db) => {
    const m = await driverOrder(db, driverId, id);
    checkReadable(m);
    return { ...meta(m), messages: await list(db, m.id) };
  });
}

export async function driverSend(driverId, id, text) {
  return withPlatform(async (db) => {
    const m = await driverOrder(db, driverId, id);
    checkReadable(m);
    checkWritable(m);
    const name = (await db.query('SELECT name FROM fleet_drivers WHERE id = $1', [driverId])).rows[0]?.name || 'Repartidor';
    await db.query(
      `INSERT INTO marketplace_messages (marketplace_order_id, restaurant_id, sender, sender_name, driver_id, body)
       VALUES ($1, $2, 'repartidor', $3, $4, $5)`,
      [m.id, m.restaurant_id, name.split(' ')[0], driverId, text],
    );
    return { ...meta(m), messages: await list(db, m.id) };
  });
}
