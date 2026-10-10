// Clientes y lealtad (modulo 'lealtad'): fichas de clientes con historial,
// ajustes del programa de puntos, ajustes manuales y ligar un cliente a una
// orden en caja. El canje se hace como pago en POST /api/pos/orders/:id/payments.
import { Router } from 'express';
import { withTenant } from '../config/database.js';
import { authenticateUser, requireRole } from '../middleware/auth.js';
import { requireModule } from '../middleware/requireModule.js';
import { applyPoints, loadLoyaltySettings, pointsValue } from '../services/loyalty.js';
import {
  EMAIL_RE, HttpError, ah, badRequest, bool, buildSet, notFound, oneOf, requireUuid, str,
} from '../utils/http.js';
import { ROLES, int } from './pos/common.js';
import { ACTIVE_STATUSES, lockOrder } from './pos/orders.js';

const router = Router();
router.use(authenticateUser, requireModule('lealtad'));
const staff = requireRole(...ROLES.orders);
const manage = requireRole(...ROLES.manage);

// ---------------------------------------------------------------------------
// Ajustes del programa
// ---------------------------------------------------------------------------

router.get('/settings', staff, ah(async (req, res) => {
  res.json({ settings: await withTenant(req.tenant.id, (db) => loadLoyaltySettings(db, req.tenant.id)) });
}));

const ratio = (v, field, { positive = false } = {}) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (positive && n <= 0) || n > 10000) {
    throw badRequest(`El campo "${field}" debe ser un número válido`, 'INVALID_FIELD');
  }
  return Math.round(n * 10000) / 10000;
};

router.patch('/settings', manage, ah(async (req, res) => {
  const b = req.body || {};
  const f = {
    program_name: str(b.program_name, { field: 'program_name', max: 40 }) ?? undefined,
    earn_enabled: bool(b.earn_enabled, 'earn_enabled'),
    redeem_enabled: bool(b.redeem_enabled, 'redeem_enabled'),
    points_per_peso: ratio(b.points_per_peso, 'points_per_peso'),
    peso_per_point: ratio(b.peso_per_point, 'peso_per_point', { positive: true }),
    min_redeem_points: int(b.min_redeem_points, { field: 'min_redeem_points', max: 1000000 }),
    max_points_per_order: int(b.max_points_per_order, { field: 'max_points_per_order', min: 1, max: 10000000, nullable: true }),
    require_code: bool(b.require_code, 'require_code'),
    earn_on_web: bool(b.earn_on_web, 'earn_on_web'),
  };
  const settings = await withTenant(req.tenant.id, async (db) => {
    await db.query('INSERT INTO loyalty_settings (restaurant_id) VALUES ($1) ON CONFLICT DO NOTHING', [req.tenant.id]);
    const set = buildSet(f, 2);
    if (set) await db.query(`UPDATE loyalty_settings SET ${set.sql}, updated_at = now() WHERE restaurant_id = $1`, [req.tenant.id, ...set.values]);
    return loadLoyaltySettings(db, req.tenant.id);
  });
  res.json({ settings });
}));

// ---------------------------------------------------------------------------
// Clientes
// ---------------------------------------------------------------------------

// Compras: ordenes pagadas del cliente.
const CUSTOMER_SELECT = `
  SELECT c.id, c.name, c.email, c.phone, c.notes, c.active, c.created_at, c.last_login_at,
         c.password_hash IS NOT NULL AS has_account, c.points_balance, c.points_earned, c.points_redeemed,
         c.pos_code_locked AS code_locked,
         coalesce(s.orders, 0)::int AS orders, coalesce(s.spent, 0) AS spent, s.last_order_at
    FROM customers c
    LEFT JOIN LATERAL (
      SELECT count(*) AS orders, sum(o.total) AS spent, max(o.paid_at) AS last_order_at
        FROM orders o WHERE o.restaurant_id = c.restaurant_id AND o.customer_id = c.id AND o.status = 'pagada'
    ) s ON true`;

const publicRow = (r, settings) => ({ ...r, spent: Number(r.spent), points_value: pointsValue(settings, r.points_balance) });

const SORTS = { recientes: 'c.created_at DESC', nombre: 'c.name', puntos: 'c.points_balance DESC', compras: 'coalesce(s.spent, 0) DESC', ultima: 's.last_order_at DESC NULLS LAST' };

router.get('/customers', staff, ah(async (req, res) => {
  const q = str(req.query.q, { field: 'q', max: 100 }) || '';
  const sort = oneOf(req.query.sort || 'recientes', Object.keys(SORTS), 'sort');
  const limit = int(req.query.limit ?? 50, { field: 'limit', min: 1, max: 500 });
  const digits = q.replace(/\D/g, '');
  const data = await withTenant(req.tenant.id, async (db) => {
    const settings = await loadLoyaltySettings(db, req.tenant.id);
    const rows = (await db.query(
      `${CUSTOMER_SELECT}
        WHERE c.restaurant_id = $1
          AND ($2 = '' OR c.name ILIKE '%' || $2 || '%' OR c.email ILIKE '%' || $2 || '%'
               OR (length($3) >= 3 AND c.phone_digits LIKE '%' || $3 || '%'))
        ORDER BY ${SORTS[sort]}, c.name LIMIT $4`,
      [req.tenant.id, q.replace(/[%_]/g, ''), digits, limit],
    )).rows;
    return rows.map((r) => publicRow(r, settings));
  });
  res.json({ customers: data });
}));

function readPhone(v, required) {
  const phone = str(v, { field: 'phone', required, max: 30 });
  if (phone && phone.replace(/\D/g, '').length < 7) throw badRequest('Escribe un teléfono válido (al menos 7 dígitos)', 'INVALID_PHONE');
  return phone;
}

function readEmail(v) {
  const email = str(v, { field: 'email', max: 200 });
  if (!email) return email;
  if (!EMAIL_RE.test(email)) throw badRequest('Correo inválido', 'INVALID_EMAIL');
  return email.toLowerCase();
}

// Alta rapida en caja: nombre y telefono. Si el telefono ya existe se regresa ese cliente.
router.post('/customers', staff, ah(async (req, res) => {
  const b = req.body || {};
  const name = str(b.name, { field: 'name', required: true, max: 120 });
  const phone = readPhone(b.phone, true);
  const email = readEmail(b.email);
  const notes = str(b.notes, { field: 'notes', max: 1000 });
  const digits = phone.replace(/\D/g, '').slice(-10);
  const result = await withTenant(req.tenant.id, async (db) => {
    const settings = await loadLoyaltySettings(db, req.tenant.id);
    const existing = (await db.query(`${CUSTOMER_SELECT} WHERE c.restaurant_id = $1 AND c.phone_digits = $2 ORDER BY c.points_balance DESC LIMIT 1`,
      [req.tenant.id, digits])).rows[0];
    if (existing) return { customer: publicRow(existing, settings), existing: true };
    try {
      const { rows } = await db.query(
        `INSERT INTO customers (restaurant_id, name, phone, email, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [req.tenant.id, name, phone, email || null, notes || null, req.user.id],
      );
      const row = (await db.query(`${CUSTOMER_SELECT} WHERE c.id = $1 AND c.restaurant_id = $2`, [rows[0].id, req.tenant.id])).rows[0];
      return { customer: publicRow(row, settings), existing: false };
    } catch (err) {
      if (err?.code === '23505') throw new HttpError(409, 'Ya hay un cliente con ese correo', 'EMAIL_TAKEN');
      throw err;
    }
  });
  res.status(result.existing ? 200 : 201).json(result);
}));

async function customerDetail(db, req, id) {
  requireUuid(id);
  const settings = await loadLoyaltySettings(db, req.tenant.id);
  const row = (await db.query(`${CUSTOMER_SELECT} WHERE c.id = $1 AND c.restaurant_id = $2`, [id, req.tenant.id])).rows[0];
  if (!row) throw notFound('Cliente no encontrado', 'CUSTOMER_NOT_FOUND');
  const orders = (await db.query(
    `SELECT o.id, o.folio, o.branch_id, b.name AS branch_name, o.order_type, o.source, o.status, o.total, o.created_at, o.paid_at,
            (SELECT sum(t.points) FROM loyalty_transactions t WHERE t.order_id = o.id AND t.kind = 'earn')::int AS points_earned,
            (SELECT -sum(t.points) FROM loyalty_transactions t WHERE t.order_id = o.id AND t.kind = 'redeem')::int AS points_redeemed
       FROM orders o JOIN branches b ON b.id = o.branch_id AND b.restaurant_id = o.restaurant_id
      WHERE o.restaurant_id = $1 AND o.customer_id = $2 ORDER BY o.created_at DESC LIMIT 50`,
    [req.tenant.id, id],
  )).rows;
  const transactions = (await db.query(
    `SELECT t.id, t.kind, t.points, t.balance_after, t.amount, t.order_id, t.reason, t.created_at, u.name AS created_by_name
       FROM loyalty_transactions t LEFT JOIN users u ON u.id = t.created_by AND u.restaurant_id = t.restaurant_id
      WHERE t.restaurant_id = $1 AND t.customer_id = $2 ORDER BY t.created_at DESC LIMIT 100`,
    [req.tenant.id, id],
  )).rows;
  return { customer: publicRow(row, settings), orders, transactions };
}

router.get('/customers/:id', staff, ah(async (req, res) => {
  res.json(await withTenant(req.tenant.id, (db) => customerDetail(db, req, req.params.id)));
}));

router.patch('/customers/:id', manage, ah(async (req, res) => {
  requireUuid(req.params.id);
  const b = req.body || {};
  const f = {
    name: str(b.name, { field: 'name', max: 120 }) ?? undefined,
    phone: readPhone(b.phone, false),
    email: readEmail(b.email),
    notes: str(b.notes, { field: 'notes', max: 1000 }),
    active: bool(b.active, 'active'),
  };
  const data = await withTenant(req.tenant.id, async (db) => {
    const cur = (await db.query('SELECT password_hash FROM customers WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id])).rows[0];
    if (!cur) throw notFound('Cliente no encontrado', 'CUSTOMER_NOT_FOUND');
    // El correo de una cuenta del portal es su usuario: solo lo cambia el cliente.
    if (cur.password_hash && f.email !== undefined) throw badRequest('El correo de una cuenta del sitio solo lo cambia el cliente', 'EMAIL_LOCKED');
    const set = buildSet(f, 3);
    if (!set) throw badRequest('Nada que actualizar', 'NOTHING_TO_UPDATE');
    try {
      await db.query(`UPDATE customers SET ${set.sql}, updated_at = now() WHERE id = $1 AND restaurant_id = $2`, [req.params.id, req.tenant.id, ...set.values]);
    } catch (err) {
      if (err?.code === '23505') throw new HttpError(409, 'Ya hay un cliente con ese correo', 'EMAIL_TAKEN');
      if (err?.code === '23514') throw badRequest('El cliente necesita teléfono o correo', 'CONTACT_REQUIRED');
      throw err;
    }
    return customerDetail(db, req, req.params.id);
  });
  res.json(data);
}));

// Ajuste manual de puntos (+/-), con motivo.
router.post('/customers/:id/points', manage, ah(async (req, res) => {
  requireUuid(req.params.id);
  const b = req.body || {};
  const points = Number(b.points);
  if (!Number.isInteger(points) || points === 0 || Math.abs(points) > 10000000) {
    throw badRequest('Indica los puntos a sumar o restar (entero distinto de cero)', 'INVALID_FIELD');
  }
  const reason = str(b.reason, { field: 'reason', required: true, max: 200 });
  const data = await withTenant(req.tenant.id, async (db) => {
    await applyPoints(db, req.tenant.id, { customerId: req.params.id, kind: 'adjust', points, reason, userId: req.user.id });
    return customerDetail(db, req, req.params.id);
  });
  res.json(data);
}));

router.get('/stats', manage, ah(async (req, res) => {
  const data = await withTenant(req.tenant.id, async (db) => {
    const settings = await loadLoyaltySettings(db, req.tenant.id);
    const [c] = (await db.query(
      `SELECT count(*)::int AS customers,
              count(*) FILTER (WHERE password_hash IS NOT NULL)::int AS with_account,
              count(*) FILTER (WHERE created_at >= date_trunc('month', now()))::int AS new_this_month,
              coalesce(sum(points_balance), 0)::int AS points_outstanding
         FROM customers WHERE restaurant_id = $1`,
      [req.tenant.id],
    )).rows;
    const [t] = (await db.query(
      `SELECT coalesce(sum(points) FILTER (WHERE kind = 'earn'), 0)::int AS earned,
              coalesce(-sum(points) FILTER (WHERE kind = 'redeem'), 0)::int AS redeemed,
              coalesce(sum(amount) FILTER (WHERE kind = 'redeem'), 0) AS redeemed_amount
         FROM loyalty_transactions WHERE restaurant_id = $1 AND created_at >= now() - interval '30 days'`,
      [req.tenant.id],
    )).rows;
    return {
      ...c,
      points_outstanding_value: pointsValue(settings, c.points_outstanding),
      last_30_days: { earned: t.earned, redeemed: t.redeemed, redeemed_amount: Number(t.redeemed_amount) },
    };
  });
  res.json({ stats: data });
}));

// ---------------------------------------------------------------------------
// Cliente de una orden (caja)
// ---------------------------------------------------------------------------

router.post('/orders/:id/customer', staff, ah(async (req, res) => {
  const customerId = req.body?.customer_id ? requireUuid(req.body.customer_id, 'customer_id') : null;
  const order = await withTenant(req.tenant.id, async (db) => {
    const o = await lockOrder(db, req, req.params.id);
    if (!ACTIVE_STATUSES.includes(o.status)) throw badRequest('La orden ya está cerrada', 'ORDER_CLOSED');
    const redeemed = await db.query("SELECT 1 FROM loyalty_transactions WHERE order_id = $1 AND kind = 'redeem' LIMIT 1", [o.id]);
    if (redeemed.rowCount) throw badRequest('La orden ya tiene un canje de puntos: no se puede cambiar el cliente', 'ORDER_HAS_REDEMPTION');
    if (o.source === 'web' && o.customer_id) throw badRequest('El pedido en línea ya es de un cliente', 'ONLINE_ORDER_CUSTOMER');
    if (customerId) {
      const c = (await db.query('SELECT name, phone FROM customers WHERE id = $1 AND restaurant_id = $2 AND active', [customerId, req.tenant.id])).rows[0];
      if (!c) throw notFound('Cliente no encontrado', 'CUSTOMER_NOT_FOUND');
      await db.query(
        `UPDATE orders SET customer_id = $3, customer_name = coalesce(customer_name, $4), customer_phone = coalesce(customer_phone, $5), updated_at = now()
          WHERE id = $1 AND restaurant_id = $2`,
        [o.id, req.tenant.id, customerId, c.name, c.phone],
      );
    } else {
      await db.query('UPDATE orders SET customer_id = NULL, updated_at = now() WHERE id = $1 AND restaurant_id = $2', [o.id, req.tenant.id]);
    }
    return { id: o.id, customer_id: customerId };
  });
  res.json({ order });
}));

export default router;
