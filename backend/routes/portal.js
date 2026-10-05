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
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { withTenant } from '../config/database.js';
import { authenticateCustomer, optionalCustomer, signCustomerToken } from '../middleware/auth.js';
import { customerAuthLimiter, orderLimiter, publicLimiter } from '../middleware/rateLimits.js';
import { loadModuleRow, requireModule } from '../middleware/requireModule.js';
import { requireTenant } from '../middleware/tenant.js';
import { checkModuleAccess } from '../services/access.js';
import {
  acceptOnlineOrder, customerOrderView, getOnlineSettings, loadBranches, publicBranch,
} from '../services/online.js';
import { DEFAULT_PROVIDER, getPaymentProvider, publicPaymentOptions } from '../services/onlinePayments.js';
import { calculateOrderTotals, toCents } from '../services/posMath.js';
import {
  ensureOrderCheckout, getPaymentSettings, loadRestaurantClipCredentials, onlinePaymentAvailable, reconcileOrder,
} from '../services/restaurantPayments.js';
import {
  EMAIL_RE, HttpError, ah, badRequest, notFound, oneOf, requireUuid, str,
} from '../utils/http.js';
import { loadMenu } from './pos/menu.js';
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

/** Modulos que el portal necesita ademas de si mismo. */
async function moduleState(tenant) {
  const [pos, domicilios] = await Promise.all([loadModuleRow(tenant.id, 'pos'), loadModuleRow(tenant.id, 'domicilios')]);
  return {
    pos: !checkModuleAccess(tenant, 'pos', pos),
    domicilios: checkModuleAccess(tenant, 'domicilios', domicilios),
  };
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
    },
    branches: data.branches.map((b) => ({
      ...publicBranch(b),
      accepts_orders: b.online_enabled,
      delivery_available: delivery && b.delivery_enabled,
      delivery_fee: b.delivery_fee,
    })),
    payment_options: publicPaymentOptions({ clipAvailable: data.clipAvailable }),
  });
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
const ADDRESS_COLS = 'id, label, address, reference, created_at';
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
    customer = await withTenant(req.tenant.id, async (db) => (await db.query(
      `INSERT INTO customers (restaurant_id, name, email, phone, password_hash, last_login_at)
       VALUES ($1, $2, $3, $4, $5, now()) RETURNING ${CUSTOMER_COLS}`,
      [req.tenant.id, name, email, phone, hash],
    )).rows[0]);
  } catch (err) {
    if (err?.code === '23505') throw conflict('Ya existe una cuenta con ese correo. Inicia sesion.', 'EMAIL_TAKEN');
    throw err;
  }
  res.status(201).json({ token: signCustomerToken(customer), customer: publicCustomer(customer) });
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
  if (f.address === null) throw badRequest('La direccion no puede quedar vacia', 'MISSING_FIELD');
  if (f.label === null) f.label = undefined;
  return f;
}

router.post('/me/addresses', authenticateCustomer, ah(async (req, res) => {
  const f = addressFields(req.body || {}, true);
  const address = await withTenant(req.tenant.id, async (db) => {
    const n = (await db.query('SELECT count(*)::int AS n FROM customer_addresses WHERE restaurant_id = $1 AND customer_id = $2', [req.tenant.id, req.customer.id])).rows[0].n;
    if (n >= 20) throw badRequest('Puedes guardar hasta 20 direcciones', 'TOO_MANY_ADDRESSES');
    return (await db.query(
      `INSERT INTO customer_addresses (restaurant_id, customer_id, label, address, reference)
       VALUES ($1, $2, coalesce($3, 'Casa'), $4, $5) RETURNING ${ADDRESS_COLS}`,
      [req.tenant.id, req.customer.id, f.label ?? null, f.address, f.reference ?? null],
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
async function prepareOrder(db, req, input, mods) {
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
  if (!branch.status.open) {
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
  if (input.order_type === 'domicilio' && input.address_id) {
    const a = (await db.query(
      'SELECT address, reference FROM customer_addresses WHERE id = $1 AND restaurant_id = $2 AND customer_id = $3',
      [input.address_id, rid, req.customer.id],
    )).rows[0];
    if (!a) throw notFound('Direccion no encontrada', 'ADDRESS_NOT_FOUND');
    address = a.address;
    reference = a.reference;
  }

  const pos = await getSettings(db, rid);
  const deliveryFee = input.order_type === 'domicilio' ? branch.delivery_fee : 0;
  const totals = calculateOrderTotals(lines, {
    taxRatePct: pos.tax_rate_pct, pricesIncludeTax: pos.prices_include_tax, deliveryFee,
  });
  const clipAvailable = onlinePaymentAvailable(await getPaymentSettings(db, rid));
  const provider = getPaymentProvider(input.payment.provider || DEFAULT_PROVIDER, { clipAvailable });
  const payment = provider.validate(input.payment, { total: totals.total });
  return { settings, branch, lines, totals, pos, provider, payment, address, reference };
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
  const p = await withTenant(req.tenant.id, (db) => prepareOrder(db, req, input, mods));
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
                           payment_preference, pay_with, public_token, online_payment_status, payment_due_at)
       VALUES ($1, $2, $3, $4, 'web', 'pendiente', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
               $18, now() + make_interval(mins => $19::int))
       RETURNING *`,
      [rid, p.branch.id, folio, input.order_type, req.customer?.id ?? null, input.name, input.phone,
        input.order_type === 'domicilio' ? p.address : null, input.order_type === 'domicilio' ? p.reference : null,
        input.notes, p.pos.tax_rate_pct, p.pos.prices_include_tax, p.totals.delivery_fee, p.provider.code,
        p.payment.payment_preference, p.payment.pay_with, token, online ? 'pendiente' : null, timeout],
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
        `INSERT INTO customer_addresses (restaurant_id, customer_id, label, address, reference)
         SELECT $1, $2, 'Casa', $3, $4
          WHERE NOT EXISTS (SELECT 1 FROM customer_addresses WHERE restaurant_id = $1 AND customer_id = $2 AND address = $3)
            AND (SELECT count(*) FROM customer_addresses WHERE restaurant_id = $1 AND customer_id = $2) < 20`,
        [rid, req.customer.id, p.address, p.reference],
      );
    }
    const totals = await loadOrder(db, rid, order.id);
    const next = await p.provider.start({ db, restaurantId: rid, tenant: req.tenant, order: totals, creds });
    const full = await loadOrder(db, rid, order.id);
    return { order: customerOrderView(full, p.branch), payment: next };
  });
  res.status(201).json(result);
}));

/** Pedidos (con articulos) para la vista del cliente. */
async function customerViews(db, rid, orders) {
  if (!orders.length) return [];
  const branches = new Map((await loadBranches(db, rid, { onlyActive: false })).map((b) => [b.id, b]));
  const items = await loadItems(db, rid, orders.map((o) => o.id));
  return orders.map((o) => customerOrderView({ ...o, items: items.filter((i) => i.order_id === o.id) }, branches.get(o.branch_id)));
}

router.get('/orders', authenticateCustomer, ah(async (req, res) => {
  const orders = await withTenant(req.tenant.id, async (db) => customerViews(db, req.tenant.id, (await db.query(
    `SELECT * FROM orders WHERE restaurant_id = $1 AND customer_id = $2 AND source = 'web'
      ORDER BY created_at DESC LIMIT 50`,
    [req.tenant.id, req.customer.id],
  )).rows));
  res.json({ orders });
}));

router.get('/orders/:id', authenticateCustomer, ah(async (req, res) => {
  requireUuid(req.params.id);
  const order = await withTenant(req.tenant.id, async (db) => (await customerViews(db, req.tenant.id, (await db.query(
    `SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2 AND customer_id = $3 AND source = 'web'`,
    [req.params.id, req.tenant.id, req.customer.id],
  )).rows))[0]);
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
  const order = await withTenant(req.tenant.id, async (db) =>
    (await customerViews(db, req.tenant.id, [await findByToken(db, req.tenant.id, req.params.token)]))[0]);
  res.json({ order });
}));

// El cliente puede cancelar mientras el restaurante no lo acepte.
router.post('/track/:token/cancel', ah(async (req, res) => {
  const order = await withTenant(req.tenant.id, async (db) => {
    const o = await findByToken(db, req.tenant.id, req.params.token, { lock: true });
    if (o.online_status !== 'pendiente' || !['abierta', 'enviada', 'lista'].includes(o.status)) {
      throw badRequest('El restaurante ya esta preparando tu pedido: llama a la sucursal para cancelarlo', 'CANNOT_CANCEL');
    }
    // Ya pagado en linea: cancelarlo implica un reembolso, lo hace la sucursal.
    if (o.online_payment_status === 'pagado') {
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

export default router;
