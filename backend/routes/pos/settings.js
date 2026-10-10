// Configuracion del POS (impuesto, descuentos, ticket), metodos de pago y
// canales de venta (plataformas de delivery con su comision).
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { ah, badRequest, bool, buildSet, notFound, oneOf, requireUuid, str } from '../../utils/http.js';
import { ROLES, assertModule, insertSql, int, moduleActive, uuidList } from './common.js';
import { requireModule } from '../../middleware/requireModule.js';
import { can } from '../../services/permissions.js';

const router = Router();

const SETTINGS_COLS = 'tax_rate_pct, prices_include_tax, cashier_max_discount_pct, ticket_header, ticket_footer, usd_rate';
const METHOD_COLS = 'id, name, kind, currency, active, sort_order';
const CHANNEL_COLS = 'id, name, color, commission_pct, payment_method_ids, requires_order_number, requires_address, sort_order, active';
export const METHOD_KINDS = ['efectivo', 'tarjeta', 'transferencia', 'otro'];

export async function getSettings(db, restaurantId) {
  const { rows } = await db.query(`SELECT ${SETTINGS_COLS} FROM pos_settings WHERE restaurant_id = $1`, [restaurantId]);
  if (rows[0]) return rows[0];
  // Por si el restaurante se creo antes de sembrar valores: se crean ahora.
  await db.query('SELECT seed_pos_defaults($1)', [restaurantId]);
  return (await db.query(`SELECT ${SETTINGS_COLS} FROM pos_settings WHERE restaurant_id = $1`, [restaurantId])).rows[0];
}

/** Tipo de cambio (pesos por dolar). */
export function usdRate(value) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (value === null || value === '' || !Number.isFinite(n) || n <= 0 || n >= 1000) {
    throw badRequest('El tipo de cambio no es valido', 'INVALID_FIELD');
  }
  return Math.round(n * 10000) / 10000;
}

function percent(value, field) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (value === null || value === '' || !Number.isFinite(n) || n < 0 || n > 100) {
    throw badRequest(`El campo "${field}" debe ser un porcentaje entre 0 y 100`, 'INVALID_FIELD');
  }
  return Math.round(n * 100) / 100;
}

router.get('/settings', can('kitchen'), ah(async (req, res) => {
  const settings = await withTenant(req.tenant.id, (db) => getSettings(db, req.tenant.id));
  res.json({ settings });
}));

router.patch('/settings', can('manage'), ah(async (req, res) => {
  const body = req.body || {};
  const set = buildSet({
    tax_rate_pct: percent(body.tax_rate_pct, 'tax_rate_pct'),
    prices_include_tax: bool(body.prices_include_tax, 'prices_include_tax'),
    cashier_max_discount_pct: percent(body.cashier_max_discount_pct, 'cashier_max_discount_pct'),
    ticket_header: str(body.ticket_header, { field: 'ticket_header', max: 500 }),
    ticket_footer: str(body.ticket_footer, { field: 'ticket_footer', max: 500 }),
    usd_rate: usdRate(body.usd_rate),
  }, 2);
  if (!set) throw badRequest('No hay cambios', 'NO_CHANGES');
  const settings = await withTenant(req.tenant.id, async (db) => {
    await getSettings(db, req.tenant.id);
    return (await db.query(
      `UPDATE pos_settings SET ${set.sql}, updated_at = now() WHERE restaurant_id = $1 RETURNING ${SETTINGS_COLS}`,
      [req.tenant.id, ...set.values],
    )).rows[0];
  });
  res.json({ settings });
}));

// ---------------------------------------------------------------------------
// Metodos de pago
// ---------------------------------------------------------------------------

router.get('/payment-methods', can('kitchen'), ah(async (req, res) => {
  const methods = await withTenant(req.tenant.id, async (db) => (await db.query(
    `SELECT ${METHOD_COLS} FROM payment_methods WHERE restaurant_id = $1 ORDER BY sort_order, name`,
    [req.tenant.id],
  )).rows);
  res.json({ payment_methods: methods });
}));

function methodFields(body, creating) {
  const f = {
    name: str(body.name, { field: 'name', required: creating, max: 60 }),
    kind: oneOf(body.kind, METHOD_KINDS, 'kind'),
    currency: oneOf(body.currency, ['MXN', 'USD'], 'currency'),
    active: bool(body.active, 'active'),
    sort_order: int(body.sort_order, { field: 'sort_order', max: 100000 }),
  };
  if (f.name === null) throw badRequest('El nombre no puede quedar vacio', 'MISSING_FIELD');
  if (f.currency === 'USD' && f.kind && f.kind !== 'efectivo') throw badRequest('Solo el efectivo puede ser en dolares', 'INVALID_FIELD');
  return f;
}

router.post('/payment-methods', can('manage'), ah(async (req, res) => {
  const f = methodFields(req.body || {}, true);
  const q = insertSql('payment_methods', req.tenant.id, f, METHOD_COLS);
  const method = await withTenant(req.tenant.id, async (db) => {
    if (f.currency === 'USD') await assertModule(db, req.tenant.id, 'multimoneda', 'Cobro en dolares');
    return (await db.query(q.text, q.values)).rows[0];
  });
  res.status(201).json({ payment_method: method });
}));

router.patch('/payment-methods/:id', can('manage'), ah(async (req, res) => {
  requireUuid(req.params.id);
  const fields = methodFields(req.body || {}, false);
  const set = buildSet(fields, 3);
  if (!set) throw badRequest('No hay cambios', 'NO_CHANGES');
  const method = await withTenant(req.tenant.id, async (db) => {
    const cur = (await db.query('SELECT kind FROM payment_methods WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id])).rows[0];
    if (fields.currency === 'USD') await assertModule(db, req.tenant.id, 'multimoneda', 'Cobro en dolares');
    // "Clip en linea" lo usa el pago en linea: se puede renombrar, no cambiar de tipo.
    // Igual los de "Puntos" y "Monedero" (los usan el canje y el monedero).
    if (['en_linea', 'puntos', 'monedero'].includes(cur?.kind) && fields.kind !== undefined) {
      throw badRequest('El metodo de pago en linea no puede cambiar de tipo', 'ONLINE_METHOD_LOCKED');
    }
    return (await db.query(
      `UPDATE payment_methods SET ${set.sql}, updated_at = now()
        WHERE id = $1 AND restaurant_id = $2 RETURNING ${METHOD_COLS}`,
      [req.params.id, req.tenant.id, ...set.values],
    )).rows[0];
  });
  if (!method) throw notFound('Metodo de pago no encontrado', 'PAYMENT_METHOD_NOT_FOUND');
  res.json({ payment_method: method });
}));

// Si ya tiene pagos registrados se desactiva en lugar de borrarse.
router.delete('/payment-methods/:id', can('manage'), ah(async (req, res) => {
  requireUuid(req.params.id);
  const result = await withTenant(req.tenant.id, async (db) => {
    const used = await db.query(
      `SELECT 1 FROM order_payments WHERE payment_method_id = $1 AND restaurant_id = $2
       UNION ALL SELECT 1 FROM cash_session_counts WHERE payment_method_id = $1 AND restaurant_id = $2 LIMIT 1`,
      [req.params.id, req.tenant.id],
    );
    if (used.rowCount) {
      const { rowCount } = await db.query(
        'UPDATE payment_methods SET active = false, updated_at = now() WHERE id = $1 AND restaurant_id = $2',
        [req.params.id, req.tenant.id],
      );
      if (!rowCount) throw notFound('Metodo de pago no encontrado', 'PAYMENT_METHOD_NOT_FOUND');
      return { archived: true };
    }
    const { rowCount } = await db.query('DELETE FROM payment_methods WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]);
    if (!rowCount) throw notFound('Metodo de pago no encontrado', 'PAYMENT_METHOD_NOT_FOUND');
    return null;
  });
  if (result) return res.json(result);
  res.status(204).end();
}));

// ---------------------------------------------------------------------------
// Canales de venta (Rappi, Uber Eats, Didi...)
// ---------------------------------------------------------------------------

router.get('/channels', can('kitchen'), ah(async (req, res) => {
  const all = req.query.all === '1';
  // Sin el modulo no hay plataformas que elegir en la caja.
  const channels = await withTenant(req.tenant.id, async (db) => (!(await moduleActive(db, req.tenant.id, 'plataformas')) ? [] : (await db.query(
    `SELECT ${CHANNEL_COLS} FROM sales_channels WHERE restaurant_id = $1 ${all ? '' : 'AND active'}
      ORDER BY sort_order, name`,
    [req.tenant.id],
  )).rows));
  res.json({ channels });
}));

function channelFields(body, creating) {
  const color = body.color === undefined ? undefined : (body.color || null);
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw badRequest('El color debe ser como #22AA66', 'INVALID_FIELD');
  const f = {
    name: str(body.name, { field: 'name', required: creating, max: 60 }),
    color,
    commission_pct: percent(body.commission_pct, 'commission_pct'),
    payment_method_ids: uuidList(body.payment_method_ids, 'payment_method_ids'),
    requires_order_number: bool(body.requires_order_number, 'requires_order_number'),
    requires_address: bool(body.requires_address, 'requires_address'),
    sort_order: int(body.sort_order, { field: 'sort_order', max: 100000 }),
    active: bool(body.active, 'active'),
  };
  if (f.name === null) throw badRequest('El nombre no puede quedar vacio', 'MISSING_FIELD');
  return f;
}

async function assertMethods(db, restaurantId, ids) {
  if (!ids?.length) return;
  const { rowCount } = await db.query(
    'SELECT 1 FROM payment_methods WHERE restaurant_id = $1 AND id = ANY($2::uuid[])',
    [restaurantId, ids],
  );
  if (rowCount !== ids.length) throw badRequest('Algun metodo de pago no existe', 'PAYMENT_METHOD_NOT_FOUND');
}

const duplicateChannel = (err) => {
  if (err.code === '23505') throw badRequest('Ya existe un canal con ese nombre', 'CHANNEL_EXISTS');
  throw err;
};

router.post('/channels', requireModule('plataformas'), can('manage'), ah(async (req, res) => {
  const f = channelFields(req.body || {}, true);
  const q = insertSql('sales_channels', req.tenant.id, f, CHANNEL_COLS);
  const channel = await withTenant(req.tenant.id, async (db) => {
    await assertMethods(db, req.tenant.id, f.payment_method_ids);
    return (await db.query(q.text, q.values)).rows[0];
  }).catch(duplicateChannel);
  res.status(201).json({ channel });
}));

router.patch('/channels/:id', requireModule('plataformas'), can('manage'), ah(async (req, res) => {
  requireUuid(req.params.id);
  const f = channelFields(req.body || {}, false);
  const set = buildSet(f, 3);
  if (!set) throw badRequest('No hay cambios', 'NO_CHANGES');
  const channel = await withTenant(req.tenant.id, async (db) => {
    await assertMethods(db, req.tenant.id, f.payment_method_ids);
    return (await db.query(
      `UPDATE sales_channels SET ${set.sql}, updated_at = now()
        WHERE id = $1 AND restaurant_id = $2 RETURNING ${CHANNEL_COLS}`,
      [req.params.id, req.tenant.id, ...set.values],
    )).rows[0];
  }).catch(duplicateChannel);
  if (!channel) throw notFound('Canal no encontrado', 'CHANNEL_NOT_FOUND');
  res.json({ channel });
}));

// Un canal con ventas se desactiva en lugar de borrarse.
router.delete('/channels/:id', can('manage'), ah(async (req, res) => {
  requireUuid(req.params.id);
  const result = await withTenant(req.tenant.id, async (db) => {
    const used = await db.query('SELECT 1 FROM orders WHERE channel_id = $1 AND restaurant_id = $2 LIMIT 1', [req.params.id, req.tenant.id]);
    if (used.rowCount) {
      const { rowCount } = await db.query(
        'UPDATE sales_channels SET active = false, updated_at = now() WHERE id = $1 AND restaurant_id = $2',
        [req.params.id, req.tenant.id],
      );
      if (!rowCount) throw notFound('Canal no encontrado', 'CHANNEL_NOT_FOUND');
      return { archived: true };
    }
    const { rowCount } = await db.query('DELETE FROM sales_channels WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]);
    if (!rowCount) throw notFound('Canal no encontrado', 'CHANNEL_NOT_FOUND');
    return null;
  });
  if (result) return res.json(result);
  res.status(204).end();
}));

export default router;
