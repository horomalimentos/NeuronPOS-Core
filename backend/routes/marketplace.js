// NeuronPOS Delivery (fase 1).
//
// marketplacePublicRouter (sin tenant, /api/marketplace):
//   - GET  /info         tarifas de envio y reglas publicas.
//   - POST /restaurants  registro gratis de un restaurante: cuenta nueva con
//                        el modulo 'marketplace', su sucursal y su ficha.
//   - POST /drivers      registro de repartidor con epicentro y radio; queda
//                        pendiente hasta que el Panel lo aprueba.
//   - GET  /restaurants?lat&lng       restaurantes cercanos (fase 2).
//   - GET  /restaurants/:branchId     ficha y menu para pedir.
//   - POST /quote, POST /orders       cotizar y pedir (efectivo).
//   - GET  /orders/:token             seguimiento del cliente.
// marketplaceRouter (con tenant, /api/marketplace): la ficha de cada sucursal
// y los pedidos que llegan por Delivery (aceptar, rechazar, listo).
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { withPlatform, withTenant } from '../config/database.js';
import { env } from '../config/env.js';
import { authenticateUser, requireRole, signFleetToken } from '../middleware/auth.js';
import { requireModule } from '../middleware/requireModule.js';
import { readPoint } from '../services/deliveryZones.js';
import {
  freeSlug, getMarketplaceSettings, listFeeTiers,
} from '../services/marketplace.js';
import {
  createMarketplaceOrder, nearbyRestaurants, quoteMarketplaceOrder, readMarketplaceOrder, restaurantFor, trackOrder,
} from '../services/marketplaceOrders.js';
import { acceptOnlineOrder } from '../services/online.js';
import { createRestaurant } from '../services/restaurants.js';
import { loadMenu } from './pos/menu.js';
import { restaurantSiteUrl } from '../services/urls.js';
import {
  EMAIL_RE, HttpError, ah, badRequest, bool, money, notFound, requireUuid, str,
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

const closedError = () => new HttpError(403, 'NeuronPOS Delivery no esta recibiendo registros por ahora', 'MARKETPLACE_DISABLED');

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
      fee_tiers: await listFeeTiers(db),
    };
  });
  res.json(data);
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
        notes: 'Registro propio en NeuronPOS Delivery',
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

marketplacePublicRouter.post('/orders', orderLimiter, ah(async (req, res) => {
  res.status(201).json({ order: await createMarketplaceOrder(readMarketplaceOrder(req.body)) });
}));

marketplacePublicRouter.get('/orders/:token', ah(async (req, res) => {
  res.set('Cache-Control', 'no-store').json({ order: await trackOrder(req.params.token) });
}));

// ---------------------------------------------------------------------------
// Restaurante: ficha de cada sucursal
// ---------------------------------------------------------------------------

export const marketplaceRouter = Router();
marketplaceRouter.use(authenticateUser, requireModule('marketplace'));

const LISTING_COLUMNS = `l.latitude, l.longitude, l.description, l.cuisine, l.cover_url, l.prep_minutes, l.min_order,
  l.published, l.paused_until, l.blocked, l.blocked_reason, l.published_at, l.updated_at`;

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
      hours_days: r.hours_days,
      products: r.products,
      missing,
      // Lo que ve el cliente: publicada, sin bloqueo ni pausa y completa.
      visible: Boolean(r.published) && !r.blocked && !paused && r.branch_active && missing.length === 0,
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
    if (!rowCount) throw notFound('Esta sucursal aun no tiene ficha en NeuronPOS Delivery', 'LISTING_NOT_FOUND');
    return (await readListings(db, rid, req.params.branchId))[0];
  });
  res.json({ listing });
}));

// ---------------------------------------------------------------------------
// Restaurante: pedidos que llegan por NeuronPOS Delivery
// ---------------------------------------------------------------------------

const STAFF = ['admin', 'gerente', 'cajero'];

marketplaceRouter.get('/orders', requireRole(...STAFF), ah(async (req, res) => {
  const branchId = req.query.branch_id ? requireUuid(req.query.branch_id, 'branch_id') : null;
  const rid = req.tenant.id;
  const rows = await withTenant(rid, async (db) => (await db.query(
    `SELECT m.id, m.order_id, m.branch_id, b.name AS branch_name, o.folio, m.status, m.customer_name, m.customer_phone,
            m.address, m.reference, m.distance_km, m.delivery_fee, m.food_total, m.total, m.payment_method, m.pay_with,
            m.cancel_reason, o.notes, o.estimated_ready_at, m.created_at, m.accepted_at, m.ready_at, m.delivered_at,
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
    if (m.status !== 'nuevo') throw new HttpError(409, 'El pedido ya fue aceptado', 'INVALID_TRANSITION');
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
