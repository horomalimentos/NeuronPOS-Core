// Nayo (fase 1).
//
// marketplacePublicRouter (sin tenant, /api/marketplace):
//   - GET  /info         tarifas de envio y reglas publicas.
//   - POST /restaurants  registro gratis de un restaurante: cuenta nueva con
//                        el modulo 'marketplace', su sucursal y su ficha.
//   - POST /drivers      registro de repartidor con epicentro y radio; queda
//                        pendiente hasta que el Panel lo aprueba.
//   - GET  /restaurants?lat&lng       restaurantes cercanos (fase 2).
//   - GET  /restaurants/:branchId     ficha y menu para pedir.
//   - POST /quote, POST /orders       cotizar y pedir (efectivo o tarjeta:
//                                     con tarjeta regresa payment_url de Clip).
//   - GET  /orders/:token             seguimiento del cliente (concilia el pago).
//   - GET/POST /orders/:token/messages chat del pedido (fase 4).
// marketplaceRouter (con tenant, /api/marketplace): la ficha de cada sucursal
// y los pedidos que llegan por Delivery (aceptar, rechazar, listo).
import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { withPlatform, withTenant } from '../config/database.js';
import { env } from '../config/env.js';
import {
  authenticateNayo, authenticateUser, requireRole, signFleetToken, signNayoToken,
} from '../middleware/auth.js';
import { requireModule } from '../middleware/requireModule.js';
import { readPoint } from '../services/deliveryZones.js';
import {
  freeSlug, getMarketplaceSettings, listFeeTiers,
} from '../services/marketplace.js';
import {
  createMarketplaceOrder, nearbyRestaurants, quoteMarketplaceOrder, readMarketplaceOrder, restaurantFor, trackOrder,
} from '../services/marketplaceOrders.js';
import { cardPaymentsAvailable, refreshOrderPayment } from '../services/marketplaceMoney.js';
import {
  customerChat, customerSend, readMessageBody, restaurantChat, restaurantSend,
} from '../services/marketplaceChat.js';
import { acceptOnlineOrder } from '../services/online.js';
import { createRestaurant } from '../services/restaurants.js';
import { subscribeLive } from '../services/live.js';
import { verifyGoogleIdToken } from '../services/googleSignIn.js';
import {
  sendNayoOrderReceived, sendNayoReset, sendNayoVerifyCode, sendNayoWelcome,
} from '../services/nayoEmails.js';
import { RESET_TTL_MINUTES, hashToken, readResetToken } from '../services/passwordReset.js';
import { loadMenu } from './pos/menu.js';
import { restaurantSiteUrl } from '../services/urls.js';
import {
  EMAIL_RE, HttpError, UUID_RE, ah, badRequest, bool, money, notFound, requireUuid, str,
} from '../utils/http.js';

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.isTest,
  message: { error: 'Demasiados registros desde esta conexion. Intenta mas tarde.', code: 'RATE_LIMITED' },
});

function readAccount(body, field) {
  const a = {
    name: str(body.name, { field: `${field}.name`, required: true, max: 120 }),
    email: str(body.email, { field: `${field}.email`, required: true, max: 200 })?.toLowerCase(),
    password: typeof body.password === 'string' ? body.password : '',
  };
  if (!EMAIL_RE.test(a.email)) throw badRequest('Correo invalido', 'INVALID_EMAIL');
  if (a.password.length < 8) throw badRequest('La contrasena debe tener al menos 8 caracteres', 'WEAK_PASSWORD');
  return a;
}

function readPhone(v, field = 'phone') {
  const phone = str(v, { field, required: true, max: 40 });
  if (phone.replace(/\D/g, '').length < 10) throw badRequest('Escribe un telefono de 10 digitos', 'INVALID_PHONE');
  return phone;
}

const closedError = () => new HttpError(403, 'Nayo no esta recibiendo registros por ahora', 'MARKETPLACE_DISABLED');

// ---------------------------------------------------------------------------
// Publico
// ---------------------------------------------------------------------------

export const marketplacePublicRouter = Router();

marketplacePublicRouter.get('/info', ah(async (req, res) => {
  const data = await withPlatform(async (db) => {
    const s = await getMarketplaceSettings(db);
    return {
      enabled: s.enabled,
      driver_share_pct: Number(s.driver_share_pct),
      food_commission_pct: Number(s.food_commission_pct),
      max_distance_km: Number(s.max_distance_km),
      driver_max_radius_km: Number(s.driver_max_radius_km),
      card_payments: cardPaymentsAvailable(),
      fee_tiers: await listFeeTiers(db),
    };
  });
  res.json(data);
}));

// Canal en vivo para clientes (Server-Sent Events, sin cuenta): avisa cuando
// un repartidor se conecta o desconecta, o un restaurante publica, pausa o es
// aprobado (triggers de la migracion 052), para volver a pedir la lista. Solo
// manda el tipo de cambio, nada de datos. Tope de conexiones abiertas.
const MAX_LIVE = 2000;
let liveOpen = 0;
marketplacePublicRouter.get('/live', ah(async (req, res) => {
  if (liveOpen >= MAX_LIVE) throw new HttpError(503, 'Intenta de nuevo en un momento', 'LIVE_BUSY');
  liveOpen += 1;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  let stop = () => {};
  const beat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { liveOpen -= 1; clearInterval(beat); stop(); });
  stop = await subscribeLive('nayo', (d) => res.write(`event: ${d.t}\ndata: {}\n\n`));
  if (res.writableEnded || req.destroyed) stop();
}));

marketplacePublicRouter.post('/restaurants', signupLimiter, ah(async (req, res) => {
  const body = req.body || {};
  const name = str(body.name, { field: 'name', required: true, max: 120 });
  const phone = readPhone(body.phone);
  const address = str(body.address, { field: 'address', required: true, max: 300 });
  const location = readPoint(body.location);
  if (!location) throw badRequest('Marca en el mapa donde esta tu restaurante', 'MISSING_FIELD');
  const cuisine = str(body.cuisine, { field: 'cuisine', max: 60 }) || null;
  const admin = readAccount(body.admin || {}, 'admin');

  const created = await withPlatform(async (db) => {
    if (!(await getMarketplaceSettings(db)).enabled) throw closedError();
    const slug = await freeSlug(db, name);
    const r = await createRestaurant(db, {
      fields: {
        slug, name, status: 'active', activated_at: new Date().toISOString(),
        contact_name: admin.name, contact_email: admin.email, contact_phone: phone,
        notes: 'Registro propio en Nayo',
      },
      moduleCodes: ['marketplace'],
      branchName: 'Matriz',
      branch: { address, phone },
      admin,
    });
    await db.query(
      `INSERT INTO marketplace_listings (restaurant_id, branch_id, latitude, longitude, cuisine)
       VALUES ($1, $2, $3, $4, $5)`,
      [r.id, r.branchId, location.latitude, location.longitude, cuisine],
    );
    return { id: r.id, slug, name, custom_domain: null };
  });
  res.status(201).json({
    restaurant: { id: created.id, slug: created.slug, name: created.name },
    admin_url: `${restaurantSiteUrl(created)}/admin`,
  });
}));

marketplacePublicRouter.post('/drivers', signupLimiter, ah(async (req, res) => {
  const body = req.body || {};
  const account = readAccount(body, 'driver');
  const phone = readPhone(body.phone);
  const vehicle = str(body.vehicle, { field: 'vehicle', required: true, max: 60 });
  const plate = str(body.plate, { field: 'plate', max: 20 }) || null;
  const base = readPoint(body.base, 'base');
  if (!base) throw badRequest('Marca en el mapa tu epicentro (desde donde repartes)', 'MISSING_FIELD');
  const radius = Number(body.radius_km);

  const driver = await withPlatform(async (db) => {
    const s = await getMarketplaceSettings(db);
    if (!s.enabled) throw closedError();
    if (!Number.isFinite(radius) || radius < 1 || radius > Number(s.driver_max_radius_km)) {
      throw badRequest(`El radio debe ser de 1 a ${Number(s.driver_max_radius_km)} km`, 'INVALID_FIELD');
    }
    const exists = await db.query('SELECT 1 FROM fleet_drivers WHERE email = $1', [account.email]);
    if (exists.rowCount) throw new HttpError(409, 'Ya hay un repartidor con ese correo; inicia sesion', 'EMAIL_TAKEN');
    const hash = await bcrypt.hash(account.password, 12);
    return (await db.query(
      `INSERT INTO fleet_drivers (name, phone, email, password_hash, vehicle, plate, status, self_registered,
                                  base_latitude, base_longitude, radius_km)
       VALUES ($1, $2, $3, $4, $5, $6, 'pendiente', true, $7, $8, $9)
       RETURNING id, name, email, status`,
      [account.name, phone, account.email, hash, vehicle, plate, base.latitude, base.longitude, Math.round(radius * 10) / 10],
    )).rows[0];
  });
  res.status(201).json({ token: signFleetToken(driver), driver });
}));

// ---------------------------------------------------------------------------
// Cliente: restaurantes cercanos, menu, pedido y seguimiento
// ---------------------------------------------------------------------------

const orderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.isTest,
  message: { error: 'Demasiados pedidos desde esta conexion. Intenta mas tarde.', code: 'RATE_LIMITED' },
});

function queryPoint(q) {
  if (q.lat === undefined && q.lng === undefined) return null;
  return readPoint({ latitude: q.lat, longitude: q.lng }, 'lat/lng');
}

marketplacePublicRouter.get('/restaurants', ah(async (req, res) => {
  const point = queryPoint(req.query);
  if (!point) throw badRequest('Indica tu ubicacion (lat y lng)', 'LOCATION_REQUIRED');
  res.set('Cache-Control', 'no-store').json(await nearbyRestaurants(point));
}));

marketplacePublicRouter.get('/restaurants/:branchId', ah(async (req, res) => {
  requireUuid(req.params.branchId);
  const restaurant = await restaurantFor(req.params.branchId, queryPoint(req.query));
  const menu = await withTenant(restaurant.restaurant_id, (db) => loadMenu(db, restaurant.restaurant_id, { branchId: req.params.branchId }));
  const categoryIds = new Set(menu.categories.map((c) => c.id));
  const items = menu.items
    .filter((i) => categoryIds.has(i.category_id) && !(i.unavailable_branch_ids || []).includes(req.params.branchId))
    .map(({ unavailable_branch_ids: _u, active: _a, sort_order: _s, ...i }) => i);
  const usedGroups = new Set(items.flatMap((i) => i.modifier_group_ids));
  res.set('Cache-Control', 'no-store').json({
    restaurant,
    categories: menu.categories.filter((c) => items.some((i) => i.category_id === c.id)).map(({ id, name, description }) => ({ id, name, description })),
    items,
    modifier_groups: menu.modifier_groups.filter((g) => usedGroups.has(g.id)).map((g) => ({
      id: g.id, name: g.name, min_selections: g.min_selections, max_selections: g.max_selections,
      modifiers: g.modifiers.map(({ id, group_id, name, price_delta }) => ({ id, group_id, name, price_delta })),
    })),
  });
}));

marketplacePublicRouter.post('/quote', ah(async (req, res) => {
  const q = await quoteMarketplaceOrder(readMarketplaceOrder(req.body, { quote: true }));
  res.json({
    totals: q.totals,
    lines: q.lines.map((l) => ({ name: l.name, quantity: l.quantity, line_total: l.line_total })),
    restaurant: { name: q.restaurant.name, distance_km: q.restaurant.distance_km },
  });
}));

// Cuenta del cliente: para pedir hay que registrarse o entrar.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.isTest,
  message: { error: 'Demasiados intentos. Espera unos minutos.', code: 'RATE_LIMITED' },
});

const ACCOUNT_COLUMNS = 'id, name, phone, email, (email_verified_at IS NOT NULL) AS email_verified';

// Verificacion del correo: codigo de 6 digitos, vence en 15 minutos, 5 intentos.
const VERIFY_MINUTES = 15;
const VERIFY_ATTEMPTS = 5;

/** Genera y manda un codigo nuevo (no mas de uno por minuto). */
async function sendVerifyCode(db, customer) {
  const c = (await db.query(
    'SELECT verify_expires_at FROM nayo_customers WHERE id = $1 AND email_verified_at IS NULL FOR UPDATE', [customer.id],
  )).rows[0];
  if (!c) return false;
  const issuedAt = c.verify_expires_at ? new Date(c.verify_expires_at).getTime() - VERIFY_MINUTES * 60000 : 0;
  if (Date.now() - issuedAt < 60000) return false;
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await db.query(
    `UPDATE nayo_customers SET verify_code_hash = $2, verify_expires_at = now() + make_interval(mins => $3::int), verify_attempts = 0
      WHERE id = $1`,
    [customer.id, hashToken(`${customer.id}:${code}`), VERIFY_MINUTES],
  );
  void sendNayoVerifyCode(customer, code, VERIFY_MINUTES);
  return true;
}

marketplacePublicRouter.post('/account/register', signupLimiter, ah(async (req, res) => {
  const body = req.body || {};
  const account = readAccount(body, 'customer');
  const phone = readPhone(body.phone);
  const customer = await withPlatform(async (db) => {
    const exists = await db.query('SELECT 1 FROM nayo_customers WHERE email = $1', [account.email]);
    if (exists.rowCount) throw new HttpError(409, 'Ya hay una cuenta con ese correo; inicia sesion', 'EMAIL_TAKEN');
    const hash = await bcrypt.hash(account.password, 12);
    const row = (await db.query(
      `INSERT INTO nayo_customers (name, phone, email, password_hash, last_login_at)
       VALUES ($1, $2, $3, $4, now()) RETURNING ${ACCOUNT_COLUMNS}`,
      [account.name, phone, account.email, hash],
    )).rows[0];
    await sendVerifyCode(db, row);
    return row;
  });
  res.status(201).json({ token: signNayoToken(customer), customer });
}));

// Olvide mi contrasena: siempre responde igual (no revela si el correo existe).
// Pedir otra liga antes de 1 minuto no manda otro correo.
marketplacePublicRouter.post('/account/forgot', loginLimiter, ah(async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw badRequest('Correo invalido', 'INVALID_EMAIL');
  const found = await withPlatform(async (db) => {
    const c = (await db.query(
      'SELECT id, name, email, reset_expires_at FROM nayo_customers WHERE email = $1 AND active FOR UPDATE', [email],
    )).rows[0];
    if (!c) return null;
    const issuedAt = c.reset_expires_at ? new Date(c.reset_expires_at).getTime() - RESET_TTL_MINUTES * 60000 : 0;
    if (Date.now() - issuedAt < 60000) return null;
    const token = crypto.randomBytes(32).toString('base64url');
    await db.query(
      'UPDATE nayo_customers SET reset_token_hash = $2, reset_expires_at = now() + make_interval(mins => $3::int) WHERE id = $1',
      [c.id, hashToken(token), RESET_TTL_MINUTES],
    );
    return { customer: c, token };
  });
  if (found) void sendNayoReset(found.customer, found.token);
  res.json({ ok: true });
}));

marketplacePublicRouter.post('/account/reset', loginLimiter, ah(async (req, res) => {
  const body = req.body || {};
  const token = readResetToken(body.token);
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 8) throw badRequest('La contrasena debe tener al menos 8 caracteres', 'WEAK_PASSWORD');
  const hash = await bcrypt.hash(password, 12);
  const customer = await withPlatform(async (db) => (await db.query(
    `UPDATE nayo_customers SET password_hash = $2, password_changed_at = now(), reset_token_hash = NULL, reset_expires_at = NULL,
            email_verified_at = COALESCE(email_verified_at, now()), last_login_at = now(), updated_at = now()
      WHERE reset_token_hash = $1 AND reset_expires_at > now() AND active
      RETURNING ${ACCOUNT_COLUMNS}`,
    [hashToken(token), hash],
  )).rows[0]);
  if (!customer) throw badRequest('La liga para cambiar tu contraseña no es válida o ya venció. Pide otra.', 'INVALID_RESET_TOKEN');
  // Entra de una vez: el token nuevo es posterior al cambio de contrasena.
  res.json({ token: signNayoToken(customer), customer });
}));

marketplacePublicRouter.post('/account/login',
 loginLimiter, ah(async (req, res) => {
  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const row = await withPlatform(async (db) => (await db.query(
    `SELECT ${ACCOUNT_COLUMNS}, password_hash, active FROM nayo_customers WHERE email = $1`, [email],
  )).rows[0]);
  if (row && !row.password_hash) {
    throw new HttpError(401, 'Esta cuenta entra con Google. Usa "Continuar con Google" o pide una contraseña en ¿Olvidaste tu contraseña?', 'USE_GOOGLE');
  }
  if (!row || !(await bcrypt.compare(password, row.password_hash))) {
    throw new HttpError(401, 'Correo o contrasena incorrectos', 'INVALID_CREDENTIALS');
  }
  if (!row.active) throw new HttpError(403, 'Tu cuenta esta desactivada', 'ACCOUNT_DEACTIVATED');
  await withPlatform((db) => db.query('UPDATE nayo_customers SET last_login_at = now() WHERE id = $1', [row.id]));
  const customer = { id: row.id, name: row.name, phone: row.phone, email: row.email, email_verified: row.email_verified };
  res.json({ token: signNayoToken(customer), customer });
}));

// Como se puede entrar: el boton de Google sale solo si hay GOOGLE_CLIENT_ID.
marketplacePublicRouter.get('/account/options', (req, res) => {
  res.json({ google_client_id: env.googleClientId || null });
});

// Continuar con Google: entra a la cuenta ligada a esa persona de Google; si no
// hay, liga la cuenta con el mismo correo (Google ya lo verifico) o crea una
// nueva sin contrasena ni telefono (el telefono se pide en el primer pedido).
marketplacePublicRouter.post('/account/google', loginLimiter, ah(async (req, res) => {
  const g = await verifyGoogleIdToken((req.body || {}).credential);
  const { customer, created } = await withPlatform(async (db) => {
    const found = (await db.query(
      `SELECT ${ACCOUNT_COLUMNS}, active, google_sub FROM nayo_customers WHERE google_sub = $1 OR email = $2
        ORDER BY (google_sub = $1) DESC NULLS LAST LIMIT 1 FOR UPDATE`,
      [g.sub, g.email],
    )).rows[0];
    if (found) {
      if (!found.active) throw new HttpError(403, 'Tu cuenta esta desactivada', 'ACCOUNT_DEACTIVATED');
      if (found.google_sub && found.google_sub !== g.sub) {
        throw new HttpError(409, 'Ese correo ya está ligado a otra cuenta de Google', 'GOOGLE_MISMATCH');
      }
      const row = (await db.query(
        `UPDATE nayo_customers SET google_sub = $2, email_verified_at = COALESCE(email_verified_at, now()), last_login_at = now(), updated_at = now()
          WHERE id = $1 RETURNING ${ACCOUNT_COLUMNS}`,
        [found.id, g.sub],
      )).rows[0];
      return { customer: row, created: false };
    }
    const row = (await db.query(
      `INSERT INTO nayo_customers (name, email, google_sub, email_verified_at, last_login_at)
       VALUES ($1, $2, $3, now(), now()) RETURNING ${ACCOUNT_COLUMNS}`,
      [g.name, g.email, g.sub],
    )).rows[0];
    return { customer: row, created: true };
  });
  if (created) void sendNayoWelcome(customer);
  res.status(created ? 201 : 200).json({ token: signNayoToken(customer), customer });
}));

// Confirmar el correo con el codigo que le mandamos.
marketplacePublicRouter.post('/account/verify', loginLimiter, authenticateNayo, ah(async (req, res) => {
  const me = req.nayoCustomer;
  if (me.email_verified) return res.json({ customer: me });
  const code = String((req.body || {}).code || '').replace(/\D/g, '');
  const customer = await withPlatform(async (db) => {
    const c = (await db.query(
      'SELECT verify_code_hash, verify_expires_at, verify_attempts FROM nayo_customers WHERE id = $1 FOR UPDATE', [me.id],
    )).rows[0];
    if (!c.verify_code_hash || new Date(c.verify_expires_at) < new Date() || c.verify_attempts >= VERIFY_ATTEMPTS) {
      throw badRequest('El código ya venció. Pide otro.', 'VERIFY_CODE_EXPIRED');
    }
    const a = hashToken(`${me.id}:${code}`);
    const b = c.verify_code_hash;
    if (code.length !== 6 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      // Sin throw aqui: la transaccion debe guardar el intento.
      await db.query('UPDATE nayo_customers SET verify_attempts = verify_attempts + 1 WHERE id = $1', [me.id]);
      return null;
    }
    return (await db.query(
      `UPDATE nayo_customers SET email_verified_at = now(), verify_code_hash = NULL, verify_expires_at = NULL, verify_attempts = 0, updated_at = now()
        WHERE id = $1 RETURNING ${ACCOUNT_COLUMNS}`,
      [me.id],
    )).rows[0];
  });
  if (!customer) throw badRequest('Ese código no es correcto', 'INVALID_VERIFY_CODE');
  void sendNayoWelcome(customer);
  return res.json({ customer });
}));

marketplacePublicRouter.post('/account/verify/resend', loginLimiter, authenticateNayo, ah(async (req, res) => {
  if (req.nayoCustomer.email_verified) return res.json({ ok: true, sent: false });
  const sent = await withPlatform((db) => sendVerifyCode(db, req.nayoCustomer));
  return res.json({ ok: true, sent });
}));

// Mi cuenta y mis pedidos recientes.
marketplacePublicRouter.get('/account', authenticateNayo, ah(async (req, res) => {
  const orders = await withPlatform(async (db) => (await db.query(
    `SELECT m.public_token AS token, r.name AS restaurant, m.status, m.total, m.created_at
       FROM marketplace_orders m JOIN restaurants r ON r.id = m.restaurant_id
      WHERE m.customer_id = $1 ORDER BY m.created_at DESC LIMIT 20`,
    [req.nayoCustomer.id],
  )).rows);
  res.set('Cache-Control', 'no-store').json({ customer: req.nayoCustomer, orders });
}));

marketplacePublicRouter.post('/orders', orderLimiter, authenticateNayo, ah(async (req, res) => {
  const me = req.nayoCustomer;
  if (!me.email_verified) throw new HttpError(403, 'Confirma tu correo con el código que te mandamos para poder pedir', 'EMAIL_NOT_VERIFIED');
  const body = req.body || {};
  // Nombre y telefono salen de la cuenta si el cliente no los cambia.
  const c = body.customer || {};
  const input = readMarketplaceOrder({ ...body, customer: { name: c.name || me.name, phone: c.phone || me.phone } });
  const order = await createMarketplaceOrder({ ...input, customer_id: me.id });
  // Las cuentas de Google no traen telefono: se queda el del primer pedido.
  if (!me.phone) {
    await withPlatform((db) => db.query('UPDATE nayo_customers SET phone = $2, updated_at = now() WHERE id = $1 AND phone IS NULL', [me.id, input.phone]));
  }
  // Con tarjeta el pedido llega al restaurante hasta que se paga; el correo es para los pedidos ya confirmados.
  if (order.status !== 'pago_pendiente') void sendNayoOrderReceived(me, order);
  res.status(201).json({ order });
}));

marketplacePublicRouter.get('/orders/:token', ah(async (req, res) => {
  let order = await trackOrder(req.params.token);
  if (order.status === 'pago_pendiente') {
    const url = await refreshOrderPayment(order.token);
    order = { ...(await trackOrder(order.token)), payment_url: url };
  }
  res.set('Cache-Control', 'no-store').json({ order });
}));

const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.isTest,
  message: { error: 'Demasiados mensajes. Espera unos minutos.', code: 'RATE_LIMITED' },
});

// /orders/<uuid>/messages es la ruta del restaurante (marketplaceRouter); el token del cliente nunca es uuid.
const customerToken = (req, res, next) => (UUID_RE.test(req.params.token) ? next('router') : next());

marketplacePublicRouter.get('/orders/:token/messages', customerToken, ah(async (req, res) => {
  res.set('Cache-Control', 'no-store').json(await customerChat(req.params.token));
}));

marketplacePublicRouter.post('/orders/:token/messages', customerToken, chatLimiter, ah(async (req, res) => {
  res.status(201).json(await customerSend(req.params.token, readMessageBody(req.body)));
}));

// ---------------------------------------------------------------------------
// Restaurante: ficha de cada sucursal
// ---------------------------------------------------------------------------

export const marketplaceRouter = Router();
marketplaceRouter.use(authenticateUser, requireModule('marketplace'));

const LISTING_COLUMNS = `l.latitude, l.longitude, l.description, l.cuisine, l.cover_url, l.prep_minutes, l.min_order,
  l.published, l.paused_until, l.blocked, l.blocked_reason, l.approval_status, l.approval_note, l.published_at, l.updated_at`;

async function readListings(db, rid, branchId = null) {
  const { rows } = await db.query(
    `SELECT b.id AS branch_id, b.name AS branch_name, b.address, b.phone, b.active AS branch_active,
            (l.branch_id IS NOT NULL) AS has_listing, ${LISTING_COLUMNS},
            (SELECT count(*) FROM branch_hours h WHERE h.branch_id = b.id)::int AS hours_days,
            (SELECT count(*) FROM menu_items i
              WHERE i.restaurant_id = b.restaurant_id AND i.active
                AND NOT EXISTS (SELECT 1 FROM menu_item_branches x
                                 WHERE x.menu_item_id = i.id AND x.branch_id = b.id AND NOT x.available))::int AS products
       FROM branches b
       LEFT JOIN marketplace_listings l ON l.branch_id = b.id
      WHERE b.restaurant_id = $1 AND ($2::uuid IS NULL OR b.id = $2)
      ORDER BY b.name`,
    [rid, branchId],
  );
  const now = Date.now();
  return rows.map((r) => {
    const missing = [];
    if (r.latitude === null) missing.push('ubicacion');
    if (!r.hours_days) missing.push('horario');
    if (!r.products) missing.push('menu');
    const paused = Boolean(r.paused_until && new Date(r.paused_until).getTime() > now);
    return {
      branch_id: r.branch_id,
      branch_name: r.branch_name,
      address: r.address,
      phone: r.phone,
      branch_active: r.branch_active,
      location: r.latitude === null ? null : { latitude: Number(r.latitude), longitude: Number(r.longitude) },
      description: r.description,
      cuisine: r.cuisine,
      cover_url: r.cover_url,
      prep_minutes: r.prep_minutes ?? 25,
      min_order: r.min_order ?? '0.00',
      published: Boolean(r.published),
      paused_until: paused ? r.paused_until : null,
      blocked: Boolean(r.blocked),
      blocked_reason: r.blocked ? r.blocked_reason : null,
      // Sin ficha todavia: al crearla queda pendiente de revision.
      approval_status: r.approval_status ?? 'pendiente',
      approval_note: r.approval_status === 'rechazado' ? r.approval_note : null,
      hours_days: r.hours_days,
      products: r.products,
      missing,
      // Lo que ve el cliente: aprobada, publicada, sin bloqueo ni pausa y completa.
      visible: r.approval_status === 'aprobado' && Boolean(r.published) && !r.blocked && !paused && r.branch_active && missing.length === 0,
    };
  });
}

marketplaceRouter.get('/listings', ah(async (req, res) => {
  const listings = await withTenant(req.tenant.id, (db) => readListings(db, req.tenant.id));
  res.json({ listings });
}));

marketplaceRouter.put('/listings/:branchId', requireRole('admin', 'gerente'), ah(async (req, res) => {
  requireUuid(req.params.branchId);
  const body = req.body || {};
  const f = {
    location: body.location === undefined ? undefined : readPoint(body.location),
    description: str(body.description, { field: 'description', max: 500 }),
    cuisine: str(body.cuisine, { field: 'cuisine', max: 60 }),
    cover_url: str(body.cover_url, { field: 'cover_url', max: 1000 }),
    prep_minutes: body.prep_minutes === undefined ? undefined : Number(body.prep_minutes),
    min_order: money(body.min_order, { field: 'min_order' }),
    published: bool(body.published, 'published'),
  };
  if (f.cover_url && !/^(https?:\/\/|\/api\/uploads\/)/i.test(f.cover_url)) throw badRequest('La portada debe ser una URL', 'INVALID_URL');
  if (f.prep_minutes !== undefined && (!Number.isInteger(f.prep_minutes) || f.prep_minutes < 5 || f.prep_minutes > 180)) {
    throw badRequest('El tiempo de preparacion debe ser de 5 a 180 minutos', 'INVALID_FIELD');
  }
  const rid = req.tenant.id;
  const listing = await withTenant(rid, async (db) => {
    const branch = await db.query('SELECT 1 FROM branches WHERE id = $1 AND restaurant_id = $2', [req.params.branchId, rid]);
    if (!branch.rowCount) throw notFound('Sucursal no encontrada', 'BRANCH_NOT_FOUND');
    await db.query(
      'INSERT INTO marketplace_listings (restaurant_id, branch_id) VALUES ($1, $2) ON CONFLICT (branch_id) DO NOTHING',
      [rid, req.params.branchId],
    );
    const set = [];
    const values = [];
    const add = (col, v) => { values.push(v); set.push(`${col} = $${values.length + 2}`); };
    if (f.location !== undefined) {
      add('latitude', f.location?.latitude ?? null);
      add('longitude', f.location?.longitude ?? null);
    }
    for (const k of ['description', 'cuisine', 'cover_url', 'prep_minutes', 'min_order']) if (f[k] !== undefined) add(k, f[k]);
    if (f.published !== undefined) {
      add('published', f.published);
      if (f.published) set.push('published_at = coalesce(published_at, now())');
    }
    if (set.length) {
      await db.query(
        `UPDATE marketplace_listings SET ${set.join(', ')}, updated_at = now() WHERE restaurant_id = $1 AND branch_id = $2`,
        [rid, req.params.branchId, ...values],
      );
    }
    const [row] = await readListings(db, rid, req.params.branchId);
    // Para publicar, la ficha debe estar completa (ubicacion, horario, menu).
    if (row.published && row.missing.length && f.published) {
      throw badRequest(`Antes de publicar falta: ${row.missing.join(', ')}`, 'LISTING_INCOMPLETE');
    }
    return row;
  });
  res.json({ listing });
}));

// Pausar pedidos un rato (cocina saturada) o reanudar (minutes = 0).
marketplaceRouter.post('/listings/:branchId/pause', requireRole('admin', 'gerente', 'cajero'), ah(async (req, res) => {
  requireUuid(req.params.branchId);
  const minutes = Number((req.body || {}).minutes);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 24 * 60) throw badRequest('Indica de 0 a 1440 minutos', 'INVALID_FIELD');
  const rid = req.tenant.id;
  const listing = await withTenant(rid, async (db) => {
    const { rowCount } = await db.query(
      `UPDATE marketplace_listings SET paused_until = CASE WHEN $3 = 0 THEN NULL ELSE now() + make_interval(mins => $3) END,
              updated_at = now()
        WHERE restaurant_id = $1 AND branch_id = $2`,
      [rid, req.params.branchId, minutes],
    );
    if (!rowCount) throw notFound('Esta sucursal aun no tiene ficha en Nayo', 'LISTING_NOT_FOUND');
    return (await readListings(db, rid, req.params.branchId))[0];
  });
  res.json({ listing });
}));

// ---------------------------------------------------------------------------
// Restaurante: pedidos que llegan por Nayo
// ---------------------------------------------------------------------------

const STAFF = ['admin', 'gerente', 'cajero'];

marketplaceRouter.get('/orders', requireRole(...STAFF), ah(async (req, res) => {
  const branchId = req.query.branch_id ? requireUuid(req.query.branch_id, 'branch_id') : null;
  const rid = req.tenant.id;
  const rows = await withTenant(rid, async (db) => (await db.query(
    `SELECT m.id, m.order_id, m.branch_id, b.name AS branch_name, o.folio, m.status, m.customer_name, m.customer_phone,
            m.address, m.reference, m.distance_km, m.delivery_fee, m.food_total, m.total, m.payment_method, m.pay_with,
            m.cancel_reason, o.notes, o.estimated_ready_at, m.created_at, m.accepted_at, m.ready_at, m.delivered_at,
            m.picked_up_at, m.paid_at, (m.driver_id IS NOT NULL) AS driver_assigned,
            (SELECT count(*) FROM marketplace_messages x WHERE x.marketplace_order_id = m.id)::int AS messages,
            (SELECT coalesce(json_agg(json_build_object(
                      'name', i.name, 'quantity', i.quantity, 'notes', i.notes,
                      'modifiers', (SELECT coalesce(json_agg(x.name), '[]') FROM order_item_modifiers x WHERE x.order_item_id = i.id))
                    ORDER BY i.created_at), '[]')
               FROM order_items i WHERE i.order_id = o.id AND i.voided_at IS NULL) AS items
       FROM marketplace_orders m
       JOIN orders o ON o.id = m.order_id
       JOIN branches b ON b.id = m.branch_id
      WHERE m.restaurant_id = $1 AND ($2::uuid IS NULL OR m.branch_id = $2)
        AND (m.status IN ('nuevo', 'aceptado', 'listo', 'en_camino') OR m.created_at > now() - interval '18 hours')
      ORDER BY (m.status = 'nuevo') DESC, m.created_at DESC LIMIT 200`,
    [rid, branchId],
  )).rows);
  res.json({ orders: rows });
}));

async function onOrder(req, fn) {
  requireUuid(req.params.id);
  const rid = req.tenant.id;
  return withTenant(rid, async (db) => {
    const m = (await db.query(
      `SELECT m.*, o.folio FROM marketplace_orders m JOIN orders o ON o.id = m.order_id
        WHERE m.id = $1 AND m.restaurant_id = $2 FOR UPDATE OF m`,
      [req.params.id, rid],
    )).rows[0];
    if (!m) throw notFound('Pedido no encontrado', 'ORDER_NOT_FOUND');
    await fn(db, m);
    return (await db.query('SELECT id, status, accepted_at, ready_at, cancel_reason FROM marketplace_orders WHERE id = $1', [m.id])).rows[0];
  });
}

marketplaceRouter.post('/orders/:id/accept', requireRole(...STAFF), ah(async (req, res) => {
  const prep = (req.body || {}).prep_minutes === undefined ? null : Number(req.body.prep_minutes);
  if (prep !== null && (!Number.isInteger(prep) || prep < 5 || prep > 180)) throw badRequest('Indica de 5 a 180 minutos', 'INVALID_FIELD');
  const order = await onOrder(req, async (db, m) => {
    if (m.status !== 'nuevo') throw new HttpError(409, 'Este pedido ya no esta esperando respuesta', 'INVALID_TRANSITION');
    const listing = (await db.query('SELECT prep_minutes FROM marketplace_listings WHERE branch_id = $1', [m.branch_id])).rows[0];
    await acceptOnlineOrder(db, req.tenant.id, m.order_id, { userId: req.user.id, prepMinutes: prep ?? listing?.prep_minutes ?? 25 });
  });
  res.json({ order });
}));

marketplaceRouter.post('/orders/:id/reject', requireRole(...STAFF), ah(async (req, res) => {
  const reason = str((req.body || {}).reason, { field: 'reason', required: true, max: 300 });
  const order = await onOrder(req, async (db, m) => {
    // Uno pagado con tarjeta entra aceptado solo: se puede rechazar mientras
    // no este listo (queda en el Panel para reembolsar).
    const paidAuto = m.status === 'aceptado' && m.payment_method === 'tarjeta';
    if (m.status !== 'nuevo' && !paidAuto) throw new HttpError(409, 'El pedido ya fue aceptado', 'INVALID_TRANSITION');
    await db.query(
      `UPDATE orders SET status = 'cancelada', online_status = 'rechazada', cancelled_at = now(), cancelled_by = $3,
              cancel_reason = $4, updated_at = now()
        WHERE id = $1 AND restaurant_id = $2`,
      [m.order_id, req.tenant.id, req.user.id, reason],
    );
  });
  res.json({ order });
}));

marketplaceRouter.post('/orders/:id/ready', requireRole(...STAFF), ah(async (req, res) => {
  const order = await onOrder(req, async (db, m) => {
    if (m.status !== 'aceptado') throw new HttpError(409, 'Primero acepta el pedido', 'INVALID_TRANSITION');
    await db.query(
      'UPDATE orders SET ready_at = coalesce(ready_at, now()), updated_at = now() WHERE id = $1 AND restaurant_id = $2',
      [m.order_id, req.tenant.id],
    );
  });
  res.json({ order });
}));

marketplaceRouter.get('/orders/:id/messages', requireRole(...STAFF), ah(async (req, res) => {
  requireUuid(req.params.id);
  res.set('Cache-Control', 'no-store').json(await restaurantChat(req.tenant.id, req.params.id));
}));

marketplaceRouter.post('/orders/:id/messages', requireRole(...STAFF), ah(async (req, res) => {
  requireUuid(req.params.id);
  res.status(201).json(await restaurantSend(req.tenant.id, req.params.id, req.user, readMessageBody(req.body)));
}));
