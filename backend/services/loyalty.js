// Programa de puntos del modulo 'lealtad'. Todo cambio de puntos pasa por
// applyPoints, que bloquea al cliente, mueve el saldo y deja el renglon en
// loyalty_transactions. Los puntos se ganan al pagarse una orden con cliente
// (earnForOrder) y se canjean en caja como un pago "Puntos", autorizado con
// el codigo de 6 digitos del cliente (TOTP de 5 minutos, como Horom).
import crypto from 'node:crypto';
import { withTenant } from '../config/database.js';
import { HttpError, badRequest } from '../utils/http.js';
import { toCents } from './posMath.js';

export const CODE_STEP_SECONDS = 300;
const MAX_FAILURES = 5;

export const DEFAULT_SETTINGS = {
  program_name: 'Puntos',
  earn_enabled: true,
  redeem_enabled: true,
  points_per_peso: 1,
  peso_per_point: 0.04,
  min_redeem_points: 25,
  max_points_per_order: null,
  require_code: true,
  earn_on_web: true,
};

const SETTINGS_COLS = `program_name, earn_enabled, redeem_enabled, points_per_peso, peso_per_point,
  min_redeem_points, max_points_per_order, require_code, earn_on_web`;

export async function loadLoyaltySettings(db, restaurantId) {
  const row = (await db.query(`SELECT ${SETTINGS_COLS} FROM loyalty_settings WHERE restaurant_id = $1`, [restaurantId])).rows[0];
  const s = { ...DEFAULT_SETTINGS, ...(row || {}) };
  s.points_per_peso = Number(s.points_per_peso);
  s.peso_per_point = Number(s.peso_per_point);
  return s;
}

/** Ajustes del programa si el restaurante tiene el modulo vigente; si no, null. */
export async function activeLoyalty(db, restaurantId) {
  const { rowCount } = await db.query(
    `SELECT 1 FROM restaurant_modules
      WHERE restaurant_id = $1 AND module_code = 'lealtad' AND enabled AND (ends_at IS NULL OR ends_at > now())`,
    [restaurantId],
  );
  return rowCount ? loadLoyaltySettings(db, restaurantId) : null;
}

/** Valor en pesos de unos puntos (redondeado a centavos). */
export const pointsValue = (settings, points) => Math.round(points * settings.peso_per_point * 100) / 100;

/** Suma (o resta) puntos al cliente y lo registra. Regresa el saldo nuevo. */
export async function applyPoints(db, restaurantId, {
  customerId, kind, points, amount = null, orderId = null, paymentId = null, reason = null, userId = null,
}) {
  const n = Math.trunc(Number(points));
  if (!n) return null;
  const c = (await db.query(
    'SELECT points_balance FROM customers WHERE id = $1 AND restaurant_id = $2 FOR UPDATE',
    [customerId, restaurantId],
  )).rows[0];
  if (!c) throw badRequest('Cliente no encontrado', 'CUSTOMER_NOT_FOUND');
  const balance = c.points_balance + n;
  if (balance < 0) throw badRequest(`El cliente solo tiene ${c.points_balance} puntos`, 'INSUFFICIENT_POINTS');
  await db.query(
    `UPDATE customers SET points_balance = $3,
            points_earned = points_earned + CASE WHEN $4 = 'earn' THEN $5 ELSE 0 END,
            points_redeemed = points_redeemed + CASE WHEN $4 = 'redeem' THEN -$5 WHEN $4 = 'reverse' THEN -$5 ELSE 0 END,
            updated_at = now()
      WHERE id = $1 AND restaurant_id = $2`,
    [customerId, restaurantId, balance, kind, n],
  );
  await db.query(
    `INSERT INTO loyalty_transactions (restaurant_id, customer_id, kind, points, balance_after, amount, order_id, payment_id, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [restaurantId, customerId, kind, n, balance, amount, orderId, paymentId, reason, userId],
  );
  return balance;
}

/**
 * Puntos que gana una orden pagada con cliente: lo pagado sin envio, sin
 * propina y sin la parte pagada con puntos. Una sola vez por orden.
 */
export async function earnForOrder(db, restaurantId, orderId, userId = null) {
  const s = await activeLoyalty(db, restaurantId);
  if (!s || !s.earn_enabled || !(s.points_per_peso > 0)) return 0;
  const o = (await db.query(
    'SELECT id, folio, customer_id, source, total, delivery_fee FROM orders WHERE id = $1 AND restaurant_id = $2',
    [orderId, restaurantId],
  )).rows[0];
  if (!o?.customer_id || (o.source === 'web' && !s.earn_on_web)) return 0;
  const done = await db.query("SELECT 1 FROM loyalty_transactions WHERE order_id = $1 AND kind = 'earn'", [orderId]);
  if (done.rowCount) return 0;
  const byPoints = (await db.query(
    `SELECT coalesce(sum(p.amount), 0) AS v FROM order_payments p
       JOIN payment_methods m ON m.id = p.payment_method_id AND m.restaurant_id = p.restaurant_id
      WHERE p.restaurant_id = $1 AND p.order_id = $2 AND m.kind = 'puntos'`,
    [restaurantId, orderId],
  )).rows[0].v;
  const base = Math.max(0, toCents(o.total) - toCents(o.delivery_fee) - toCents(byPoints)) / 100;
  const points = Math.floor(base * s.points_per_peso + 1e-9);
  if (points <= 0) return 0;
  await applyPoints(db, restaurantId, {
    customerId: o.customer_id, kind: 'earn', points, amount: base, orderId, reason: `Orden #${o.folio}`, userId,
  });
  return points;
}

// ---------------------------------------------------------------------------
// Codigo para canjear en caja
// ---------------------------------------------------------------------------

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / CODE_STEP_SECONDS);

/** HOTP (RFC 4226) de 6 digitos. */
export function hotp(secret, step) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', secret).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

/** Codigo vigente del cliente (crea su secreto la primera vez). */
export async function customerCode(db, restaurantId, customerId, now = Date.now()) {
  let secret = (await db.query(
    'SELECT pos_code_secret FROM customers WHERE id = $1 AND restaurant_id = $2', [customerId, restaurantId],
  )).rows[0]?.pos_code_secret;
  if (!secret) {
    secret = crypto.randomBytes(20);
    await db.query('UPDATE customers SET pos_code_secret = $3 WHERE id = $1 AND restaurant_id = $2 AND pos_code_secret IS NULL',
      [customerId, restaurantId, secret]);
    secret = (await db.query('SELECT pos_code_secret FROM customers WHERE id = $1 AND restaurant_id = $2', [customerId, restaurantId])).rows[0].pos_code_secret;
  }
  const step = currentStep(now);
  const expires = (step + 1) * CODE_STEP_SECONDS * 1000;
  return { code: hotp(secret, step), expires_at: new Date(expires).toISOString(), seconds_left: Math.max(1, Math.round((expires - now) / 1000)) };
}

/**
 * Valida el codigo que dicta el cliente: el de esta ventana o el de la
 * anterior, nunca uno ya usado. Al quinto error se bloquea hasta que el
 * cliente lo renueve en su cuenta. Lanza HttpError si no es valido.
 */
export async function verifyCustomerCode(db, restaurantId, customerId, code, now = Date.now()) {
  const c = (await db.query(
    `SELECT pos_code_secret, pos_code_last_step, pos_code_failures, pos_code_locked
       FROM customers WHERE id = $1 AND restaurant_id = $2 FOR UPDATE`,
    [customerId, restaurantId],
  )).rows[0];
  if (!c) throw badRequest('Cliente no encontrado', 'CUSTOMER_NOT_FOUND');
  if (!c.pos_code_secret) {
    throw badRequest('El cliente aún no tiene código: debe abrir su cuenta en el sitio para verlo', 'NO_CUSTOMER_CODE');
  }
  if (c.pos_code_locked) {
    throw new HttpError(423, 'Código bloqueado por intentos fallidos: el cliente debe renovarlo en su cuenta', 'CODE_LOCKED');
  }
  const given = String(code || '').replace(/\D/g, '');
  const step = currentStep(now);
  const last = c.pos_code_last_step === null ? -1 : Number(c.pos_code_last_step);
  const match = given.length === 6 && [step, step - 1].find((s) => s > last
    && crypto.timingSafeEqual(Buffer.from(hotp(c.pos_code_secret, s)), Buffer.from(given)));
  if (match === undefined || match === false) {
    // El conteo de errores se guarda aparte (recordCodeFailure), porque esta
    // transaccion se revierte con el error.
    const err = new HttpError(400, 'Código incorrecto o vencido', 'INVALID_CUSTOMER_CODE');
    err.customerId = customerId;
    throw err;
  }
  await db.query('UPDATE customers SET pos_code_last_step = $3, pos_code_failures = 0 WHERE id = $1 AND restaurant_id = $2',
    [customerId, restaurantId, match]);
}

/** Suma un intento fallido (en su propia transaccion); al quinto se bloquea. */
export async function recordCodeFailure(restaurantId, customerId) {
  await withTenant(restaurantId, (db) => db.query(
    `UPDATE customers SET pos_code_failures = pos_code_failures + 1,
            pos_code_locked = pos_code_failures + 1 >= $3
      WHERE id = $1 AND restaurant_id = $2`,
    [customerId, restaurantId, MAX_FAILURES],
  ));
}

/** Corre fn y, si fallo por codigo incorrecto, registra el intento. */
export async function countingCodeFailures(restaurantId, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err?.code === 'INVALID_CUSTOMER_CODE' && err.customerId) await recordCodeFailure(restaurantId, err.customerId);
    throw err;
  }
}

/** Nuevo secreto (y desbloqueo) a peticion del cliente. */
export async function resetCustomerCode(db, restaurantId, customerId) {
  await db.query(
    `UPDATE customers SET pos_code_secret = $3, pos_code_last_step = NULL, pos_code_failures = 0, pos_code_locked = false
      WHERE id = $1 AND restaurant_id = $2`,
    [customerId, restaurantId, crypto.randomBytes(20)],
  );
}

// ---------------------------------------------------------------------------
// Canje en caja (pago con puntos)
// ---------------------------------------------------------------------------

/** Metodo de pago "Puntos" del restaurante (se crea la primera vez). */
export async function pointsMethodId(db, restaurantId, name) {
  const found = (await db.query("SELECT id FROM payment_methods WHERE restaurant_id = $1 AND kind = 'puntos' LIMIT 1", [restaurantId])).rows[0];
  if (found) return found.id;
  const { rows } = await db.query(
    `INSERT INTO payment_methods (restaurant_id, name, kind, sort_order) VALUES ($1, $2, 'puntos', 80)
     ON CONFLICT (restaurant_id, name) DO UPDATE SET kind = payment_methods.kind RETURNING id, kind`,
    [restaurantId, name],
  );
  if (rows[0].kind !== 'puntos') {
    return (await db.query(
      "INSERT INTO payment_methods (restaurant_id, name, kind, sort_order) VALUES ($1, $2, 'puntos', 80) RETURNING id",
      [restaurantId, `${name} (lealtad)`],
    )).rows[0].id;
  }
  return rows[0].id;
}

/**
 * Prepara un pago con puntos: valida el programa, el cliente de la orden y los
 * limites, y regresa { methodId, amount, points, customerId }. El codigo y el
 * descuento de puntos se hacen en commitRedemption, ya con el pago insertado.
 */
export async function prepareRedemption(db, restaurantId, order, loyalty) {
  const s = await activeLoyalty(db, restaurantId);
  if (!s) throw new HttpError(402, 'El módulo de clientes y lealtad no está contratado', 'MODULE_NOT_ENABLED');
  if (!s.redeem_enabled) throw badRequest('El canje de puntos está desactivado', 'REDEEM_DISABLED');
  const customerId = String(loyalty?.customer_id || order.customer_id || '');
  if (!/^[0-9a-f-]{36}$/i.test(customerId)) throw badRequest('Indica el cliente que canjea', 'MISSING_FIELD');
  if (order.customer_id && order.customer_id !== customerId) {
    throw badRequest('La orden es de otro cliente', 'CUSTOMER_MISMATCH');
  }
  const points = Number(loyalty?.points);
  if (!Number.isInteger(points) || points <= 0) throw badRequest('Los puntos deben ser un número entero', 'INVALID_FIELD');
  if (points < s.min_redeem_points) throw badRequest(`El mínimo para canjear es ${s.min_redeem_points} puntos`, 'BELOW_MIN_POINTS');
  const c = (await db.query('SELECT points_balance, active FROM customers WHERE id = $1 AND restaurant_id = $2', [customerId, restaurantId])).rows[0];
  if (!c || !c.active) throw badRequest('Cliente no encontrado', 'CUSTOMER_NOT_FOUND');
  if (points > c.points_balance) throw badRequest(`El cliente solo tiene ${c.points_balance} puntos`, 'INSUFFICIENT_POINTS');
  if (s.max_points_per_order) {
    const used = Number((await db.query(
      "SELECT coalesce(-sum(points), 0) AS n FROM loyalty_transactions WHERE order_id = $1 AND kind IN ('redeem', 'reverse')",
      [order.id],
    )).rows[0].n);
    if (used + points > s.max_points_per_order) {
      throw badRequest(`Máximo ${s.max_points_per_order} puntos por orden`, 'ABOVE_MAX_POINTS');
    }
  }
  return {
    methodId: await pointsMethodId(db, restaurantId, s.program_name),
    amount: pointsValue(s, points),
    points,
    customerId,
    requireCode: s.require_code,
  };
}

/** Verifica el codigo, liga el cliente a la orden y descuenta los puntos. */
export async function commitRedemption(db, restaurantId, order, prep, { paymentId, code, userId }) {
  if (prep.requireCode) await verifyCustomerCode(db, restaurantId, prep.customerId, code);
  if (!order.customer_id) {
    await db.query(
      `UPDATE orders o SET customer_id = c.id, customer_name = coalesce(o.customer_name, c.name),
              customer_phone = coalesce(o.customer_phone, c.phone)
         FROM customers c WHERE o.id = $1 AND o.restaurant_id = $2 AND c.id = $3 AND c.restaurant_id = $2`,
      [order.id, restaurantId, prep.customerId],
    );
  }
  await applyPoints(db, restaurantId, {
    customerId: prep.customerId, kind: 'redeem', points: -prep.points, amount: prep.amount,
    orderId: order.id, paymentId, reason: `Canje en orden #${order.folio}`, userId,
  });
}
