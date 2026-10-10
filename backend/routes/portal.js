// Portal de clientes y pedidos en linea (modulo "portal").
//
// Todo es por restaurante: el restaurante se resuelve por Host (o el header
// de desarrollo) y los clientes, direcciones y pedidos viven en tablas con
// RLS. Un token de cliente lleva audiencia 'customer' y el restaurante; no
// sirve en otro restaurante ni en rutas del personal (ni al reves).
//
// Precios: el cliente solo manda productos, cantidades, modificadores y
// notas. El servidor valua todo con las mismas reglas del POS (priceItems y
// posMath); cualquier precio que mande el cliente se ignora.
import crypto from 'node:crypto';
import express, { Router } from 'express';
import bcrypt from 'bcryptjs';
import { withTenant } from '../config/database.js';
import { authenticateCustomer, optionalCustomer, signCustomerToken } from '../middleware/auth.js';
import {
  customerAuthLimiter, feedbackLimiter, orderLimiter, publicLimiter,
} from '../middleware/rateLimits.js';
import { loadModuleRow, requireModule } from '../middleware/requireModule.js';
import { requireTenant } from '../middleware/tenant.js';
import { checkModuleAccess } from '../services/access.js';
import { customerDeliveryView } from '../services/delivery/tenant.js';
import { loadZones, quoteZone, readPoint } from '../services/deliveryZones.js';
import { readScheduledFor, scheduleSlots } from '../services/scheduling.js';
import {
  MAX_EVIDENCE, createComplaint, customerFeedback, feedbackOpen, rateOrder, saveEvidence,
} from '../services/feedback.js';
import {
  alertNewComplaint, alertNewOnlineOrder, sendCustomerReset, sendOrderReceived, sendWelcome,
} from '../services/emails.js';
import { activeLoyalty, customerCode, pointsValue, resetCustomerCode } from '../services/loyalty.js';
import {
  activeWallet, checkTopupAmount, createTopupCheckout, reconcileCustomerTopups, refundOrderWallet,
} from '../services/wallet.js';
import {
  acceptOnlineOrder, customerOrderView, getOnlineSettings, loadBranches, publicBranch,
} from '../services/online.js';
import { DEFAULT_PROVIDER, getPaymentProvider, publicPaymentOptions } from '../services/onlinePayments.js';
import { consumeResetToken, createResetToken, readResetToken } from '../services/passwordReset.js';
import { calculateOrderTotals, toCents } from '../services/posMath.js';
import {
  ensureOrderCheckout, getPaymentSettings, loadRestaurantClipCredentials, onlinePaymentAvailable, reconcileOrder,
} from '../services/restaurantPayments.js';
import {
  EMAIL_RE, HttpError, ah, badRequest, notFound, oneOf, requireUuid, str,
} from '../utils/http.js';
import { loadMenu } from './pos/menu.js';
import { MAX_UPLOAD_BYTES, sniffImage } from './uploads.js';
import {
  insertItems, loadItems, loadOrder, nextFolio, priceItems, readItemInputs, recalcOrder,
} from './pos/orders.js';
import { getSettings } from './pos/settings.js';

const router = Router();
router.use(requireTenant, publicLimiter, requireModule('portal'));

const conflict = (msg, code) => new HttpError(409, msg, code);
const DUMMY_HASH = bcrypt.hashSync('no-existe', 10);
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

const brand = (t) => ({
  slug: t.slug, name: t.name, logo_url: t.logo_url, primary_color: t.primary_color, secondary_color: t.secondary_color,
});

/** Pago de pedidos con monedero: modulo vigente y encendido en sus ajustes. */
async function walletPayAvailable(db, restaurantId) {
  return Boolean((await activeWallet(db, restaurantId))?.web_enabled);
}

/** Modulos que el portal necesita ademas de si mismo. */
async function moduleState(tenant) {
  const [pos, domicilios, zonas, programados] = await Promise.all(
    ['pos', 'domicilios', 'zonas_entrega', 'pedidos_programados'].map((c) => loadModuleRow(tenant.id, c)),
  );
  return {
    pos: !checkModuleAccess(tenant, 'pos', pos),
    domicilios: checkModuleAccess(tenant, 'domicilios', domicilios),
    zonas: !checkModuleAccess(tenant, 'zonas_entrega', zonas),
    programados: !checkModuleAccess(tenant, 'pedidos_programados', programados),
  };
}

/** Calificaciones y quejas (modulo quejas). */
async function feedbackActive(tenant) {
  return !checkModuleAccess(tenant, 'quejas', await loadModuleRow(tenant.id, 'quejas'));
}

async function requireFeedback(req) {
  const denied = checkModuleAccess(req.tenant, 'quejas', await loadModuleRow(req.tenant.id, 'quejas'));
  if (denied) throw new HttpError(denied.status, denied.error, denied.code);
}

// ---------------------------------------------------------------------------
// Configuracion y menu
// ---------------------------------------------------------------------------

router.get('/config', ah(async (req, res) => {
  const mods = await moduleState(req.tenant);
  const data = await withTenant(req.tenant.id, async (db) => ({
    settings: await getOnlineSettings(db, req.tenant.id),
    branches: await loadBranches(db, req.tenant.id),
    clipAvailable: onlinePaymentAvailable(await getPaymentSettings(db, req.tenant.id)),
    walletAvailable: await walletPayAvailable(db, req.tenant.id),
    zones: mods.zonas ? await loadZones(db, req.tenant.id) : new Map(),
  }));
  const s = data.settings;
  const delivery = s.allow_delivery && !mods.domicilios;
  res.json({
    restaurant: brand(req.tenant),
    ordering_available: Boolean(s.enabled && mods.pos),
    settings: {
      min_order: s.min_order,
      prep_time_minutes: s.prep_time_minutes,
      allow_pickup: s.allow_pickup,
      allow_delivery: delivery,
      // Pedidos para mas tarde (modulo 'pedidos_programados').
      scheduling: mods.programados ? { max_days: s.schedule_max_days, min_lead_minutes: s.schedule_min_lead_minutes } : null,
    },
    branches: data.branches.map((b) => ({
      ...publicBranch(b),
      accepts_orders: b.online_enabled,
      delivery_available: delivery && b.delivery_enabled,
      delivery_fee: data.zones.get(b.id) ? data.zones.get(b.id).tiers[0].fee : b.delivery_fee,
      // Con zona: el cliente marca su domicilio en el mapa y el envio va por distancia.
      delivery_zone: data.zones.get(b.id) ?? null,
    })),
    payment_options: publicPaymentOptions({ clipAvailable: data.clipAvailable, walletAvailable: data.walletAvailable }),
  });
}));

// Horarios para programar un pedido en una sucursal (modulo 'pedidos_programados').
router.get('/schedule', ah(async (req, res) => {
  const branchId = requireUuid(req.query.branch_id, 'branch_id');
  const mods = await moduleState(req.tenant);
  if (!mods.programados) return res.json({ available: false, days: [] });
  const data = await withTenant(req.tenant.id, async (db) => ({
    settings: await getOnlineSettings(db, req.tenant.id),
    branch: (await loadBranches(db, req.tenant.id)).find((b) => b.id === branchId),
  }));
  if (!data.branch) throw notFound('Sucursal no encontrada', 'BRANCH_NOT_FOUND');
  res.set('Cache-Control', 'no-store').json({ available: true, days: scheduleSlots(data.branch, data.settings) });
}));

router.get('/menu', ah(async (req, res) => {
  const branchId = req.query.branch_id ? requireUuid(req.query.branch_id, 'branch_id') : null;
  const menu = await withTenant(req.tenant.id, async (db) => {
    if (branchId) {
      const ok = await db.query('SELECT 1 FROM branches WHERE id = $1 AND restaurant_id = $2 AND active', [branchId, req.tenant.id]);
      if (!ok.rowCount) throw badRequest('La sucursal no existe', 'BRANCH_NOT_FOUND');
    }
    return loadMenu(db, req.tenant.id, { branchId });
  });
  const categoryIds = new Set(menu.categories.map((c) => c.id));
  const items = menu.items
    .filter((i) => categoryIds.has(i.category_id))
    .map(({ unavailable_branch_ids, active, sort_order, ...i }) => i);
  const usedGroups = new Set(items.flatMap((i) => i.modifier_group_ids));
  res.json({
    categories: menu.categories.map(({ id, name, description }) => ({ id, name, description })),
    items,
    modifier_groups: menu.modifier_groups
      .filter((g) => usedGroups.has(g.id))
      .map((g) => ({
        id: g.id,
        name: g.name,
        min_selections: g.min_selections,
        max_selections: g.max_selections,
        modifiers: g.modifiers.map(({ id, group_id, name, price_delta }) => ({ id, group_id, name, price_delta })),
      })),
  });
}));

// ---------------------------------------------------------------------------
// Cuenta del cliente
// ---------------------------------------------------------------------------

const CUSTOMER_COLS = 'id, restaurant_id, name, email, phone, created_at';
const ADDRESS_COLS = 'id, label, address, reference, latitude, longitude, created_at';
const publicCustomer = ({ restaurant_id, ...c }) => c;

function readPhone(value, { required = false } = {}) {
  const v = str(value, { field: 'phone', required, max: 30 });
  if (v && (v.replace(/\D/g, '').length < 7 || !/^[+0-9 ()-]+$/.test(v))) {
    throw badRequest('Escribe un telefono valido (al menos 7 digitos)', 'INVALID_PHONE');
  }
  return v;
}

function readNewPassword(value) {
  if (typeof value !== 'string' || value.length < 8) {
    throw badRequest('La contrasena debe tener al menos 8 caracteres', 'WEAK_PASSWORD');
  }
  if (value.length > 200) throw badRequest('La contrasena es demasiado larga', 'WEAK_PASSWORD');
  return value;
}

function readEmail(value) {
  const email = str(value, { field: 'email', required: true, max: 200 }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw badRequest('Correo invalido', 'INVALID_EMAIL');
  return email;
}

router.post('/auth/register', customerAuthLimiter, ah(async (req, res) => {
  const body = req.body || {};
  const name = str(body.name, { field: 'name', required: true, max: 120 });
  const email = readEmail(body.email);
  const phone = readPhone(body.phone, { required: true });
  const hash = await bcrypt.hash(readNewPassword(body.password), 10);
  let customer;
  try {
    customer = await withTenant(req.tenant.id, async (db) => {
      // Si en caja ya lo dieron de alta con ese correo (sin cuenta), se usa
      // esa ficha para que conserve sus puntos y su historial.
      const claimed = (await db.query(
        `UPDATE customers SET password_hash = $3, phone = coalesce(phone, $4), last_login_at = now(), updated_at = now()
          WHERE restaurant_id = $1 AND email = $2 AND password_hash IS NULL RETURNING ${CUSTOMER_COLS}`,
        [req.tenant.id, email, hash, phone],
      )).rows[0];
      if (claimed) return claimed;
      return (await db.query(
        `INSERT INTO customers (restaurant_id, name, email, phone, password_hash, last_login_at)
         VALUES ($1, $2, $3, $4, $5, now()) RETURNING ${CUSTOMER_COLS}`,
        [req.tenant.id, name, email, phone, hash],
      )).rows[0];
    });
  } catch (err) {
    if (err?.code === '23505') throw conflict('Ya existe una cuenta con ese correo. Inicia sesion.', 'EMAIL_TAKEN');
    throw err;
  }
  void sendWelcome(req.tenant, customer);
  res.status(201).json({ token: signCustomerToken(customer), customer: publicCustomer(customer) });
}));

// Olvide mi contrasena: siempre la misma respuesta (no revela si el correo existe).
router.post('/auth/forgot', customerAuthLimiter, ah(async (req, res) => {
  const email = readEmail((req.body || {}).email);
  const reset = await withTenant(req.tenant.id, (db) => createResetToken(db, 'customers', req.tenant.id, email));
  if (reset) void sendCustomerReset(req.tenant, reset.account, reset.token);
  res.json({ ok: true });
}));

// Nueva contrasena con la liga del correo: cierra las otras sesiones y entra.
router.post('/auth/reset', customerAuthLimiter, ah(async (req, res) => {
  const body = req.body || {};
  const token = readResetToken(body.token);
  const hash = await bcrypt.hash(readNewPassword(body.password), 10);
  const customer = await withTenant(req.tenant.id, (db) => consumeResetToken(
    db, 'customers', req.tenant.id, token, hash, CUSTOMER_COLS,
  ));
  res.json({ token: signCustomerToken(customer), customer: publicCustomer(customer) });
}));

router.post('/auth/login', customerAuthLimiter, ah(async (req, res) => {
  const body = req.body || {};
  const email = str(body.email, { field: 'email', required: true, max: 200 }).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  if (!password) throw badRequest('La contrasena es obligatoria', 'MISSING_FIELD');
  const row = await withTenant(req.tenant.id, async (db) => (await db.query(
    `SELECT ${CUSTOMER_COLS}, active, password_hash FROM customers WHERE restaurant_id = $1 AND email = $2`,
    [req.tenant.id, email],
  )).rows[0]);
  const ok = await bcrypt.compare(password, row?.password_hash || DUMMY_HASH);
  if (!row || !ok || !row.active) throw new HttpError(401, 'Correo o contrasena incorrectos', 'INVALID_CREDENTIALS');
  await withTenant(req.tenant.id, (db) =>
    db.query('UPDATE customers SET last_login_at = now() WHERE id = $1 AND restaurant_id = $2', [row.id, req.tenant.id]));
  const { active, password_hash, ...customer } = row;
  res.json({ token: signCustomerToken(customer), customer: publicCustomer(customer) });
}));

async function listAddresses(db, req) {
  return (await db.query(
    `SELECT ${ADDRESS_COLS} FROM customer_addresses WHERE restaurant_id = $1 AND customer_id = $2 ORDER BY created_at`,
    [req.tenant.id, req.customer.id],
  )).rows;
}

router.get('/me', authenticateCustomer, ah(async (req, res) => {
  const addresses = await withTenant(req.tenant.id, (db) => listAddresses(db, req));
  res.json({ customer: publicCustomer(req.customer), addresses });
}));

router.patch('/me', authenticateCustomer, ah(async (req, res) => {
  const body = req.body || {};
  const f = {
    name: str(body.name, { field: 'name', max: 120 }),
    phone: body.phone === undefined ? undefined : readPhone(body.phone, { required: true }),
  };
  if (f.name === null) throw badRequest('El nombre no puede quedar vacio', 'MISSING_FIELD');
  const customer = await withTenant(req.tenant.id, async (db) => {
    if (body.password !== undefined) {
      const current = (await db.query('SELECT password_hash FROM customers WHERE id = $1 AND restaurant_id = $2', [req.customer.id, req.tenant.id])).rows[0];
      const ok = await bcrypt.compare(String(body.current_password || ''), current.password_hash);
      if (!ok) throw badRequest('La contrasena actual no es correcta', 'INVALID_CREDENTIALS');
      f.password_hash = await bcrypt.hash(readNewPassword(body.password), 10);
    }
    const entries = Object.entries(f).filter(([, v]) => v !== undefined);
    if (!entries.length) throw badRequest('No hay cambios', 'NO_CHANGES');
    return (await db.query(
      `UPDATE customers SET ${entries.map(([k], i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now()
        WHERE id = $1 AND restaurant_id = $2 RETURNING ${CUSTOMER_COLS}`,
      [req.customer.id, req.tenant.id, ...entries.map(([, v]) => v)],
    )).rows[0];
  });
  res.json({ customer: publicCustomer(customer) });
}));

function addressFields(body, creating) {
  const f = {
    label: str(body.label, { field: 'label', max: 40 }),
    address: str(body.address, { field: 'address', required: creating, max: 400 }),
    reference: str(body.reference, { field: 'reference', max: 200 }),
  };
  // Pin en el mapa (zonas de entrega); null lo quita.
  if (body.location !== undefined) {
    const point = readPoint(body.location);
    f.latitude = point?.latitude ?? null;
    f.longitude = point?.longitude ?? null;
  }
  if (f.address === null) throw badRequest('La direccion no puede quedar vacia', 'MISSING_FIELD');
  if (f.label === null) f.label = undefined;
  return f;
}

// Puntos del cliente y su codigo para canjear en caja (modulo 'lealtad').
router.get('/me/loyalty', authenticateCustomer, ah(async (req, res) => {
  const data = await withTenant(req.tenant.id, async (db) => {
    const s = await activeLoyalty(db, req.tenant.id);
    if (!s) return { enabled: false };
    const c = (await db.query(
      'SELECT points_balance, points_earned, points_redeemed, pos_code_locked FROM customers WHERE id = $1 AND restaurant_id = $2',
      [req.customer.id, req.tenant.id],
    )).rows[0];
    const transactions = (await db.query(
      `SELECT t.kind, t.points, t.balance_after, t.reason, t.created_at FROM loyalty_transactions t
        WHERE t.restaurant_id = $1 AND t.customer_id = $2 ORDER BY t.created_at DESC LIMIT 30`,
      [req.tenant.id, req.customer.id],
    )).rows;
    return {
      enabled: true,
      program: {
        name: s.program_name, points_per_peso: s.points_per_peso, peso_per_point: s.peso_per_point,
        min_redeem_points: s.min_redeem_points, redeem_enabled: s.redeem_enabled, require_code: s.require_code,
      },
      balance: c.points_balance,
      value: pointsValue(s, c.points_balance),
      earned: c.points_earned,
      redeemed: c.points_redeemed,
      code_locked: c.pos_code_locked,
      code: c.pos_code_locked ? null : await customerCode(db, req.tenant.id, req.customer.id),
      transactions,
    };
  });
  res.set('Cache-Control', 'no-store').json(data);
}));

// Nuevo codigo (y desbloqueo si se bloqueo por intentos fallidos).
router.post('/me/loyalty/reset-code', authenticateCustomer, ah(async (req, res) => {
  const code = await withTenant(req.tenant.id, async (db) => {
    if (!(await activeLoyalty(db, req.tenant.id))) throw notFound('El restaurante no tiene programa de puntos', 'LOYALTY_DISABLED');
    await resetCustomerCode(db, req.tenant.id, req.customer.id);
    return customerCode(db, req.tenant.id, req.customer.id);
  });
  res.set('Cache-Control', 'no-store').json({ code });
}));

// Codigo de 6 digitos para pagar en caja con puntos o con monedero.
async function codeNeeded(db, rid) {
  const [loyalty, wallet] = await Promise.all([activeLoyalty(db, rid), activeWallet(db, rid)]);
  return Boolean((loyalty?.redeem_enabled && loyalty.require_code) || wallet?.require_code);
}

router.get('/me/pos-code', authenticateCustomer, ah(async (req, res) => {
  const data = await withTenant(req.tenant.id, async (db) => {
    if (!(await codeNeeded(db, req.tenant.id))) return { needed: false };
    const c = (await db.query('SELECT pos_code_locked FROM customers WHERE id = $1 AND restaurant_id = $2',
      [req.customer.id, req.tenant.id])).rows[0];
    return {
      needed: true,
      code_locked: c.pos_code_locked,
      code: c.pos_code_locked ? null : await customerCode(db, req.tenant.id, req.customer.id),
    };
  });
  res.set('Cache-Control', 'no-store').json(data);
}));

router.post('/me/pos-code/reset', authenticateCustomer, ah(async (req, res) => {
  const code = await withTenant(req.tenant.id, async (db) => {
    if (!(await codeNeeded(db, req.tenant.id))) throw notFound('Este restaurante no usa código de caja', 'CODE_DISABLED');
    await resetCustomerCode(db, req.tenant.id, req.customer.id);
    return customerCode(db, req.tenant.id, req.customer.id);
  });
  res.set('Cache-Control', 'no-store').json({ code });
}));

// Monedero: saldo, movimientos y recargas con tarjeta (Clip del restaurante).
async function walletView(db, req) {
  const rid = req.tenant.id;
  const s = await activeWallet(db, rid);
  if (!s) return { enabled: false };
  const c = (await db.query(
    'SELECT wallet_balance, wallet_loaded, wallet_spent FROM customers WHERE id = $1 AND restaurant_id = $2',
    [req.customer.id, rid],
  )).rows[0];
  const transactions = (await db.query(
    `SELECT kind, amount, balance_after, reason, created_at FROM wallet_transactions
      WHERE restaurant_id = $1 AND customer_id = $2 ORDER BY created_at DESC LIMIT 30`,
    [rid, req.customer.id],
  )).rows;
  const pending = (await db.query(
    `SELECT id, amount, payment_url, created_at FROM clip_checkouts
      WHERE restaurant_id = $1 AND customer_id = $2 AND purpose = 'recarga' AND status = 'pending'
        AND (expires_at IS NULL OR expires_at > now()) AND created_at > now() - interval '1 day'
      ORDER BY created_at DESC LIMIT 3`,
    [rid, req.customer.id],
  )).rows;
  const clip = onlinePaymentAvailable(await getPaymentSettings(db, rid));
  return {
    enabled: true,
    settings: {
      topups_available: s.topups_enabled && clip,
      min_topup: s.min_topup,
      max_topup: s.max_topup,
      suggested_amounts: s.suggested_amounts,
      max_balance: s.max_balance,
      web_enabled: s.web_enabled,
    },
    balance: Number(c.wallet_balance),
    loaded: Number(c.wallet_loaded),
    spent: Number(c.wallet_spent),
    pending_topups: pending,
    transactions,
  };
}

router.get('/me/wallet', authenticateCustomer, ah(async (req, res) => {
  res.set('Cache-Control', 'no-store').json(await withTenant(req.tenant.id, (db) => walletView(db, req)));
}));

router.post('/me/wallet/topup', authenticateCustomer, orderLimiter, ah(async (req, res) => {
  const rid = req.tenant.id;
  const creds = await loadRestaurantClipCredentials(rid);
  const payment = await withTenant(rid, async (db) => {
    const s = await activeWallet(db, rid);
    if (!s) throw notFound('Este restaurante no tiene monedero', 'WALLET_DISABLED');
    if (!s.topups_enabled || !onlinePaymentAvailable(await getPaymentSettings(db, rid))) {
      throw conflict('Las recargas en línea no están disponibles', 'TOPUPS_UNAVAILABLE');
    }
    const c = (await db.query('SELECT id, wallet_balance, active FROM customers WHERE id = $1 AND restaurant_id = $2 FOR UPDATE',
      [req.customer.id, rid])).rows[0];
    if (!c?.active) throw notFound('Cuenta no encontrada', 'CUSTOMER_NOT_FOUND');
    const amount = checkTopupAmount(s, (req.body || {}).amount, c.wallet_balance);
    return createTopupCheckout(db, req.tenant, c, amount, creds);
  });
  res.status(201).json({ payment });
}));

// Al volver de Clip: se concilia con Clip (no se cree en la URL de regreso).
router.post('/me/wallet/verify', authenticateCustomer, ah(async (req, res) => {
  await reconcileCustomerTopups(req.tenant.id, req.customer.id);
  res.set('Cache-Control', 'no-store').json(await withTenant(req.tenant.id, (db) => walletView(db, req)));
}));

router.post('/me/addresses', authenticateCustomer, ah(async (req, res) => {
  const f = addressFields(req.body || {}, true);
  const address = await withTenant(req.tenant.id, async (db) => {
    const n = (await db.query('SELECT count(*)::int AS n FROM customer_addresses WHERE restaurant_id = $1 AND customer_id = $2', [req.tenant.id, req.customer.id])).rows[0].n;
    if (n >= 20) throw badRequest('Puedes guardar hasta 20 direcciones', 'TOO_MANY_ADDRESSES');
    return (await db.query(
      `INSERT INTO customer_addresses (restaurant_id, customer_id, label, address, reference, latitude, longitude)
       VALUES ($1, $2, coalesce($3, 'Casa'), $4, $5, $6, $7) RETURNING ${ADDRESS_COLS}`,
      [req.tenant.id, req.customer.id, f.label ?? null, f.address, f.reference ?? null, f.latitude ?? null, f.longitude ?? null],
    )).rows[0];
  });
  res.status(201).json({ address });
}));

router.patch('/me/addresses/:id', authenticateCustomer, ah(async (req, res) => {
  requireUuid(req.params.id);
  const entries = Object.entries(addressFields(req.body || {}, false)).filter(([, v]) => v !== undefined);
  if (!entries.length) throw badRequest('No hay cambios', 'NO_CHANGES');
  const address = await withTenant(req.tenant.id, async (db) => (await db.query(
    `UPDATE customer_addresses SET ${entries.map(([k], i) => `${k} = $${i + 4}`).join(', ')}
      WHERE id = $1 AND restaurant_id = $2 AND customer_id = $3 RETURNING ${ADDRESS_COLS}`,
    [req.params.id, req.tenant.id, req.customer.id, ...entries.map(([, v]) => v)],
  )).rows[0]);
  if (!address) throw notFound('Direccion no encontrada', 'ADDRESS_NOT_FOUND');
  res.json({ address });
}));

router.delete('/me/addresses/:id', authenticateCustomer, ah(async (req, res) => {
  requireUuid(req.params.id);
  const { rowCount } = await withTenant(req.tenant.id, (db) => db.query(
    'DELETE FROM customer_addresses WHERE id = $1 AND restaurant_id = $2 AND customer_id = $3',
    [req.params.id, req.tenant.id, req.customer.id],
  ));
  if (!rowCount) throw notFound('Direccion no encontrada', 'ADDRESS_NOT_FOUND');
  res.status(204).end();
}));

// ---------------------------------------------------------------------------
// Pedidos
// ---------------------------------------------------------------------------

/** Lee y valida lo que manda el cliente (sin tocar la BD). */
function readOrderInput(body = {}, customer, { quote = false } = {}) {
  const orderType = oneOf(body.order_type, ['para_llevar', 'domicilio'], 'order_type');
  if (!orderType) throw badRequest('Elige si recoges en sucursal o a domicilio', 'MISSING_FIELD');
  const c = body.customer || {};
  const input = {
    branch_id: requireUuid(body.branch_id, 'branch_id'),
    order_type: orderType,
    items: readItemInputs(body.items),
    name: str(c.name, { field: 'name', max: 120 }) || customer?.name || null,
    phone: readPhone(c.phone) || customer?.phone || null,
    notes: str(body.notes, { field: 'notes', max: 500 }) || null,
    address_id: body.address_id ? requireUuid(body.address_id, 'address_id') : null,
    address: null,
    reference: null,
    save_address: body.save_address === true,
    payment: body.payment || {},
    // Pin del domicilio en el mapa (zonas de entrega).
    location: readPoint(body.location),
    // Para mas tarde: uno de los horarios de GET /portal/schedule (ISO).
    scheduled_for: body.scheduled_for ? String(body.scheduled_for).slice(0, 40) : null,
  };
  // La cotizacion no necesita datos de contacto ni direccion (el envio es por sucursal).
  if (!input.name && !quote) throw badRequest('Escribe tu nombre', 'CUSTOMER_REQUIRED');
  if (!input.phone && !quote) throw badRequest('Escribe tu telefono para avisarte de tu pedido', 'CUSTOMER_REQUIRED');
  if (orderType === 'domicilio' && !input.address_id) {
    const a = body.address || {};
    input.address = str(a.address, { field: 'address', max: 400 }) || null;
    input.reference = str(a.reference, { field: 'reference', max: 200 }) || null;
    if (!input.address && !quote) throw badRequest('Escribe la direccion de entrega', 'ADDRESS_REQUIRED');
  }
  if (input.address_id && !customer) throw badRequest('Inicia sesion para usar tus direcciones guardadas', 'ADDRESS_NOT_FOUND');
  return input;
}

/**
 * Valida el pedido contra la configuracion, la sucursal (abierta) y el menu,
 * y lo valua del lado del servidor. Se usa para cotizar y para crear.
 */
async function prepareOrder(db, req, input, mods, { quote = false } = {}) {
  const rid = req.tenant.id;
  const settings = await getOnlineSettings(db, rid);
  if (!settings.enabled || !mods.pos) throw conflict('Este restaurante no esta recibiendo pedidos en linea', 'ONLINE_ORDERS_DISABLED');
  if (input.order_type === 'para_llevar' && !settings.allow_pickup) {
    throw badRequest('Este restaurante no recibe pedidos para recoger', 'ORDER_TYPE_UNAVAILABLE');
  }
  if (input.order_type === 'domicilio' && !settings.allow_delivery) {
    throw badRequest('Este restaurante no recibe pedidos a domicilio', 'ORDER_TYPE_UNAVAILABLE');
  }

  const branch = (await loadBranches(db, rid)).find((b) => b.id === input.branch_id);
  if (!branch) throw badRequest('La sucursal no existe', 'BRANCH_NOT_FOUND');
  if (!branch.online_enabled) throw conflict('Esta sucursal no recibe pedidos en linea', 'BRANCH_NOT_ACCEPTING');
  if (input.order_type === 'domicilio' && !branch.delivery_enabled) {
    throw badRequest('Esta sucursal no entrega a domicilio', 'ORDER_TYPE_UNAVAILABLE');
  }
  let scheduledFor = null;
  if (input.scheduled_for) {
    if (!mods.programados) throw badRequest('Este restaurante no recibe pedidos programados', 'SCHEDULING_UNAVAILABLE');
    scheduledFor = readScheduledFor(input.scheduled_for, branch, settings);
  } else if (!branch.status.open) {
    throw conflict(`${branch.name} esta cerrada en este momento. Intenta en su horario de atencion.`, 'BRANCH_CLOSED');
  }

  // Productos de categorias desactivadas no se venden en linea.
  const hidden = await db.query(
    `SELECT 1 FROM menu_items i JOIN menu_categories c ON c.id = i.category_id AND c.restaurant_id = i.restaurant_id
      WHERE i.restaurant_id = $1 AND i.id = ANY($2::uuid[]) AND NOT c.active LIMIT 1`,
    [rid, input.items.map((i) => i.menu_item_id)],
  );
  if (hidden.rowCount) throw badRequest('Algun producto ya no esta disponible', 'ITEM_NOT_FOUND');
  const lines = await priceItems(db, rid, branch.id, input.items);

  const subtotalCents = lines.reduce((s, l) => s + toCents(l.line_total), 0);
  if (subtotalCents < toCents(settings.min_order)) {
    throw badRequest(`El pedido minimo es de $${Number(settings.min_order).toFixed(2)}`, 'BELOW_MIN_ORDER');
  }

  let address = input.address;
  let reference = input.reference;
  let point = input.location;
  if (input.order_type === 'domicilio' && input.address_id) {
    const a = (await db.query(
      'SELECT address, reference, latitude, longitude FROM customer_addresses WHERE id = $1 AND restaurant_id = $2 AND customer_id = $3',
      [input.address_id, rid, req.customer.id],
    )).rows[0];
    if (!a) throw notFound('Direccion no encontrada', 'ADDRESS_NOT_FOUND');
    address = a.address;
    reference = a.reference;
    if (!point && a.latitude !== null) point = { latitude: Number(a.latitude), longitude: Number(a.longitude) };
  }

  // Zona de entrega: tarifa por distancia y domicilio dentro de la zona.
  let deliveryFee = input.order_type === 'domicilio' ? branch.delivery_fee : 0;
  let distanceKm = null;
  const zone = input.order_type === 'domicilio' && mods.zonas ? (await loadZones(db, rid)).get(branch.id) : null;
  if (zone) {
    if (point) {
      const z = quoteZone(zone, point);
      deliveryFee = z.fee;
      distanceKm = z.distance_km;
    } else if (quote) {
      deliveryFee = zone.tiers[0].fee;
    } else {
      throw badRequest('Marca tu domicilio en el mapa para calcular el envío', 'LOCATION_REQUIRED');
    }
    if (subtotalCents < toCents(zone.min_order)) {
      throw badRequest(`El pedido mínimo a domicilio en esta sucursal es de $${zone.min_order.toFixed(2)}`, 'BELOW_MIN_ORDER');
    }
  } else {
    point = null;
  }

  const pos = await getSettings(db, rid);
  const totals = calculateOrderTotals(lines, {
    taxRatePct: pos.tax_rate_pct, pricesIncludeTax: pos.prices_include_tax, deliveryFee,
  });
  const clipAvailable = onlinePaymentAvailable(await getPaymentSettings(db, rid));
  const walletAvailable = input.payment.provider === 'monedero' && await walletPayAvailable(db, rid);
  const provider = getPaymentProvider(input.payment.provider || DEFAULT_PROVIDER, { clipAvailable, walletAvailable });
  if (provider.needsCustomer && !req.customer) {
    throw badRequest('Inicia sesión para pagar con tu monedero', 'LOGIN_REQUIRED');
  }
  const payment = provider.validate(input.payment, { total: totals.total });
  return { settings, branch, lines, totals, pos, provider, payment, address, reference, point, distanceKm, zone, scheduledFor };
}

async function readMods(req, input) {
  const mods = await moduleState(req.tenant);
  if (input.order_type === 'domicilio' && mods.domicilios) {
    const { status, ...body } = mods.domicilios;
    throw new HttpError(status, body.error, body.code, { module: body.module });
  }
  return mods;
}

// Cotizacion: los totales que calcula el servidor (el carrito solo muestra estimados).
router.post('/quote', optionalCustomer, ah(async (req, res) => {
  const input = readOrderInput(req.body, req.customer, { quote: true });
  const mods = await readMods(req, input);
  const p = await withTenant(req.tenant.id, (db) => prepareOrder(db, req, input, mods, { quote: true }));
  res.json({
    branch_id: p.branch.id,
    order_type: input.order_type,
    items: p.lines.map((l) => ({
      menu_item_id: l.menu_item_id, name: l.name, quantity: l.quantity, unit_price: l.unit_price,
      modifiers_total: l.modifiers_total, line_total: l.line_total,
      modifiers: l.modifiers.map((m) => ({ id: m.id, name: m.name, group_name: m.group_name, price_delta: m.price_delta })),
    })),
    ...p.totals,
    tax_rate_pct: p.pos.tax_rate_pct,
    prices_include_tax: p.pos.prices_include_tax,
    prep_time_minutes: p.settings.prep_time_minutes,
    // Zona de entrega: distancia calculada, o falta el pin del domicilio.
    delivery_distance_km: p.distanceKm,
    delivery_location_required: Boolean(p.zone && !p.point),
  });
}));

router.post('/orders', orderLimiter, optionalCustomer, ah(async (req, res) => {
  const input = readOrderInput(req.body, req.customer);
  const mods = await readMods(req, input);
  const rid = req.tenant.id;
  // Pago en linea: credenciales del restaurante (se descifran fuera de la transaccion).
  const creds = input.payment.provider === 'clip' ? await loadRestaurantClipCredentials(rid) : null;
  const result = await withTenant(rid, async (db) => {
    const p = await prepareOrder(db, req, input, mods);
    const online = p.provider.online;
    const timeout = online ? (await getPaymentSettings(db, rid)).payment_timeout_minutes : null;
    const folio = await nextFolio(db, rid, p.branch.id);
    const token = crypto.randomBytes(18).toString('base64url');
    const { rows } = await db.query(
      `INSERT INTO orders (restaurant_id, branch_id, folio, order_type, source, online_status, customer_id,
                           customer_name, customer_phone, customer_address, delivery_reference, notes,
                           tax_rate_pct, prices_include_tax, delivery_fee, payment_provider,
                           payment_preference, pay_with, public_token, online_payment_status, payment_due_at,
                           delivery_latitude, delivery_longitude, delivery_distance_km, scheduled_for)
       VALUES ($1, $2, $3, $4, 'web', 'pendiente', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
               $18, now() + make_interval(mins => $19::int), $20, $21, $22, $23)
       RETURNING *`,
      [rid, p.branch.id, folio, input.order_type, req.customer?.id ?? null, input.name, input.phone,
        input.order_type === 'domicilio' ? p.address : null, input.order_type === 'domicilio' ? p.reference : null,
        input.notes, p.pos.tax_rate_pct, p.pos.prices_include_tax, p.totals.delivery_fee, p.provider.code,
        p.payment.payment_preference, p.payment.pay_with, token, online ? 'pendiente' : null, timeout,
        p.point?.latitude ?? null, p.point?.longitude ?? null, p.distanceKm, p.scheduledFor],
    );
    const order = rows[0];
    await insertItems(db, rid, order.id, null, p.lines);
    await recalcOrder(db, rid, order);
    // Con pago en linea se acepta (o espera aceptacion) hasta que Clip confirme el pago.
    if (p.settings.auto_accept && !online) {
      await acceptOnlineOrder(db, rid, order.id, { prepMinutes: p.settings.prep_time_minutes });
    }
    if (input.save_address && req.customer && input.order_type === 'domicilio' && !input.address_id) {
      await db.query(
        `INSERT INTO customer_addresses (restaurant_id, customer_id, label, address, reference, latitude, longitude)
         SELECT $1, $2, 'Casa', $3, $4, $5, $6
          WHERE NOT EXISTS (SELECT 1 FROM customer_addresses WHERE restaurant_id = $1 AND customer_id = $2 AND address = $3)
            AND (SELECT count(*) FROM customer_addresses WHERE restaurant_id = $1 AND customer_id = $2) < 20`,
        [rid, req.customer.id, p.address, p.reference, p.point?.latitude ?? null, p.point?.longitude ?? null],
      );
    }
    // Direccion guardada que aun no tenia pin: se le guarda el que marco.
    if (input.address_id && input.location && p.point) {
      await db.query(
        `UPDATE customer_addresses SET latitude = $4, longitude = $5
          WHERE id = $1 AND restaurant_id = $2 AND customer_id = $3 AND latitude IS NULL`,
        [input.address_id, rid, req.customer.id, p.point.latitude, p.point.longitude],
      );
    }
    const totals = await loadOrder(db, rid, order.id);
    const next = await p.provider.start({
      db, restaurantId: rid, tenant: req.tenant, order: totals, creds, customer: req.customer,
    });
    const full = await loadOrder(db, rid, order.id);
    return { order: customerOrderView(full, p.branch), payment: next, full: { ...full, timezone: p.branch.timezone } };
  });
  // Avisos por correo (los de pago con Clip salen cuando Clip lo confirma).
  const { full, ...body } = result;
  if (full.online_payment_status !== 'pendiente') {
    if (req.customer?.email) void sendOrderReceived(req.tenant, full, req.customer.email);
    void alertNewOnlineOrder(req.tenant, full).catch(() => {});
  }
  res.status(201).json(body);
}));

/** Pedidos (con articulos) para la vista del cliente. */
async function customerViews(db, rid, orders, { feedback = false } = {}) {
  if (!orders.length) return [];
  const branches = new Map((await loadBranches(db, rid, { onlyActive: false })).map((b) => [b.id, b]));
  const items = await loadItems(db, rid, orders.map((o) => o.id));
  const views = [];
  for (const o of orders) {
    const view = customerOrderView({ ...o, items: items.filter((i) => i.order_id === o.id) }, branches.get(o.branch_id));
    // Fase 5: estado del reparto y, en camino, ubicacion aproximada del repartidor.
    view.delivery = await customerDeliveryView(db, rid, o);
    // Calificacion y queja (modulo quejas).
    view.feedback = await customerFeedback(db, rid, o, feedback);
    views.push(view);
  }
  return views;
}

router.get('/orders', authenticateCustomer, ah(async (req, res) => {
  const feedback = await feedbackActive(req.tenant);
  const orders = await withTenant(req.tenant.id, async (db) => customerViews(db, req.tenant.id, (await db.query(
    `SELECT * FROM orders WHERE restaurant_id = $1 AND customer_id = $2 AND source = 'web'
      ORDER BY created_at DESC LIMIT 50`,
    [req.tenant.id, req.customer.id],
  )).rows, { feedback }));
  res.json({ orders });
}));

router.get('/orders/:id', authenticateCustomer, ah(async (req, res) => {
  requireUuid(req.params.id);
  const feedback = await feedbackActive(req.tenant);
  const order = await withTenant(req.tenant.id, async (db) => (await customerViews(db, req.tenant.id, (await db.query(
    `SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2 AND customer_id = $3 AND source = 'web'`,
    [req.params.id, req.tenant.id, req.customer.id],
  )).rows, { feedback }))[0]);
  if (!order) throw notFound('Pedido no encontrado', 'ORDER_NOT_FOUND');
  res.json({ order });
}));

// Seguimiento por token (sirve para invitados; el token solo lo tiene quien hizo el pedido).
async function findByToken(db, rid, token, { lock = false } = {}) {
  if (!TOKEN_RE.test(String(token || ''))) throw notFound('Pedido no encontrado', 'ORDER_NOT_FOUND');
  const { rows } = await db.query(
    `SELECT * FROM orders WHERE public_token = $1 AND restaurant_id = $2 AND source = 'web' ${lock ? 'FOR UPDATE' : ''}`,
    [token, rid],
  );
  if (!rows[0]) throw notFound('Pedido no encontrado', 'ORDER_NOT_FOUND');
  return rows[0];
}

router.get('/track/:token', ah(async (req, res) => {
  const feedback = await feedbackActive(req.tenant);
  const order = await withTenant(req.tenant.id, async (db) =>
    (await customerViews(db, req.tenant.id, [await findByToken(db, req.tenant.id, req.params.token)], { feedback }))[0]);
  res.json({ order });
}));

// El cliente puede cancelar mientras el restaurante no lo acepte.
router.post('/track/:token/cancel', ah(async (req, res) => {
  const order = await withTenant(req.tenant.id, async (db) => {
    const o = await findByToken(db, req.tenant.id, req.params.token, { lock: true });
    if (o.online_status !== 'pendiente' || !['abierta', 'enviada', 'lista'].includes(o.status)) {
      throw badRequest('El restaurante ya esta preparando tu pedido: llama a la sucursal para cancelarlo', 'CANNOT_CANCEL');
    }
    // Pagado con monedero: se cancela y el dinero regresa al monedero.
    // Pagado con Clip: cancelarlo implica un reembolso, lo hace la sucursal.
    if (o.online_payment_status === 'pagado' && o.payment_provider !== 'monedero') {
      throw badRequest('Tu pedido ya esta pagado: llama a la sucursal para cancelarlo y gestionar tu reembolso', 'CANNOT_CANCEL');
    }
    await db.query(
      `UPDATE orders SET status = 'cancelada', cancelled_at = now(), cancel_reason = 'Cancelado por el cliente', updated_at = now(),
              online_payment_status = CASE WHEN online_payment_status = 'pendiente' THEN 'cancelado' ELSE online_payment_status END
        WHERE id = $1 AND restaurant_id = $2`,
      [o.id, req.tenant.id],
    );
    await db.query(
      `UPDATE clip_checkouts SET status = 'cancelled', updated_at = now()
        WHERE order_id = $1 AND restaurant_id = $2 AND status = 'pending'`,
      [o.id, req.tenant.id],
    );
    await refundOrderWallet(db, req.tenant.id, o, { reason: `Pedido #${o.folio} cancelado por ti` });
    return (await customerViews(db, req.tenant.id, [await findByToken(db, req.tenant.id, req.params.token)]))[0];
  });
  res.json({ order });
}));

// Pago en linea: al regresar de Clip se concilia con Clip (no se cree en la URL).
router.post('/track/:token/verify-payment', ah(async (req, res) => {
  const rid = req.tenant.id;
  const o = await withTenant(rid, (db) => findByToken(db, rid, req.params.token));
  if (o.online_payment_status) await reconcileOrder(rid, o.id);
  const order = await withTenant(rid, async (db) =>
    (await customerViews(db, rid, [await findByToken(db, rid, req.params.token)]))[0]);
  res.json({ order });
}));

// Liga de pago vigente (o una nueva) para terminar de pagar.
router.post('/track/:token/pay', ah(async (req, res) => {
  if (!TOKEN_RE.test(String(req.params.token || ''))) throw notFound('Pedido no encontrado', 'ORDER_NOT_FOUND');
  const payment = await ensureOrderCheckout(req.tenant, req.params.token);
  res.json({ payment });
}));

// ---------------------------------------------------------------------------
// Calificacion y queja del pedido (modulo quejas)
// ---------------------------------------------------------------------------

async function trackView(req) {
  return withTenant(req.tenant.id, async (db) =>
    (await customerViews(db, req.tenant.id, [await findByToken(db, req.tenant.id, req.params.token)], { feedback: true }))[0]);
}

router.post('/track/:token/rating', feedbackLimiter, ah(async (req, res) => {
  await requireFeedback(req);
  await withTenant(req.tenant.id, async (db) => {
    const o = await findByToken(db, req.tenant.id, req.params.token, { lock: true });
    await rateOrder(db, req.tenant.id, o, req.body || {});
  });
  res.status(201).json({ order: await trackView(req) });
}));

// Foto de evidencia (cuerpo crudo image/*). Se sube antes de mandar la queja.
router.post(
  '/track/:token/evidence',
  feedbackLimiter,
  express.raw({ type: 'image/*', limit: MAX_UPLOAD_BYTES }),
  ah(async (req, res) => {
    await requireFeedback(req);
    const o = await withTenant(req.tenant.id, (db) => findByToken(db, req.tenant.id, req.params.token));
    if (!feedbackOpen(o)) throw badRequest('Podrás reportar un problema cuando recibas tu pedido', 'FEEDBACK_CLOSED');
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      throw badRequest('Manda la foto como archivo (JPG, PNG o WebP)', 'IMAGE_REQUIRED');
    }
    const ext = sniffImage(req.body);
    if (!ext) throw badRequest('El archivo no es una imagen JPG, PNG, WebP o GIF', 'INVALID_IMAGE');
    res.status(201).json({ url: await saveEvidence(req.tenant.id, req.body, ext), max: MAX_EVIDENCE });
  }),
);

router.post('/track/:token/complaint', feedbackLimiter, ah(async (req, res) => {
  await requireFeedback(req);
  const { complaint, order } = await withTenant(req.tenant.id, async (db) => {
    const o = await findByToken(db, req.tenant.id, req.params.token, { lock: true });
    const items = await loadItems(db, req.tenant.id, [o.id]);
    const customer = o.customer_id
      ? (await db.query('SELECT email FROM customers WHERE id = $1 AND restaurant_id = $2', [o.customer_id, req.tenant.id])).rows[0]
      : null;
    return { complaint: await createComplaint(db, req.tenant.id, o, items, req.body || {}, customer), order: o };
  });
  void alertNewComplaint(req.tenant, complaint, order).catch(() => {});
  res.status(201).json({ order: await trackView(req) });
}));

// express.raw responde 413 con su propio error: se traduce al formato de la API.
router.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') return next(new HttpError(413, 'La foto pesa mas de 5 MB', 'IMAGE_TOO_LARGE'));
  next(err);
});

export default router;
