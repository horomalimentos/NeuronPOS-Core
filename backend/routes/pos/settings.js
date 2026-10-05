// Configuracion del POS (impuesto, descuentos, ticket) y metodos de pago.
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { requireRole } from '../../middleware/auth.js';
import { ah, badRequest, bool, buildSet, notFound, oneOf, requireUuid, str } from '../../utils/http.js';
import { ROLES, insertSql, int } from './common.js';

const router = Router();

const SETTINGS_COLS = 'tax_rate_pct, prices_include_tax, cashier_max_discount_pct, ticket_header, ticket_footer';
const METHOD_COLS = 'id, name, kind, active, sort_order';
export const METHOD_KINDS = ['efectivo', 'tarjeta', 'transferencia', 'otro'];

export async function getSettings(db, restaurantId) {
  const { rows } = await db.query(`SELECT ${SETTINGS_COLS} FROM pos_settings WHERE restaurant_id = $1`, [restaurantId]);
  if (rows[0]) return rows[0];
  // Por si el restaurante se creo antes de sembrar valores: se crean ahora.
  await db.query('SELECT seed_pos_defaults($1)', [restaurantId]);
  return (await db.query(`SELECT ${SETTINGS_COLS} FROM pos_settings WHERE restaurant_id = $1`, [restaurantId])).rows[0];
}

function percent(value, field) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (value === null || value === '' || !Number.isFinite(n) || n < 0 || n > 100) {
    throw badRequest(`El campo "${field}" debe ser un porcentaje entre 0 y 100`, 'INVALID_FIELD');
  }
  return Math.round(n * 100) / 100;
}

router.get('/settings', requireRole(...ROLES.kitchen), ah(async (req, res) => {
  const settings = await withTenant(req.tenant.id, (db) => getSettings(db, req.tenant.id));
  res.json({ settings });
}));

router.patch('/settings', requireRole(...ROLES.manage), ah(async (req, res) => {
  const body = req.body || {};
  const set = buildSet({
    tax_rate_pct: percent(body.tax_rate_pct, 'tax_rate_pct'),
    prices_include_tax: bool(body.prices_include_tax, 'prices_include_tax'),
    cashier_max_discount_pct: percent(body.cashier_max_discount_pct, 'cashier_max_discount_pct'),
    ticket_header: str(body.ticket_header, { field: 'ticket_header', max: 500 }),
    ticket_footer: str(body.ticket_footer, { field: 'ticket_footer', max: 500 }),
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

router.get('/payment-methods', requireRole(...ROLES.kitchen), ah(async (req, res) => {
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
    active: bool(body.active, 'active'),
    sort_order: int(body.sort_order, { field: 'sort_order', max: 100000 }),
  };
  if (f.name === null) throw badRequest('El nombre no puede quedar vacio', 'MISSING_FIELD');
  return f;
}

router.post('/payment-methods', requireRole(...ROLES.manage), ah(async (req, res) => {
  const q = insertSql('payment_methods', req.tenant.id, methodFields(req.body || {}, true), METHOD_COLS);
  const method = await withTenant(req.tenant.id, async (db) => (await db.query(q.text, q.values)).rows[0]);
  res.status(201).json({ payment_method: method });
}));

router.patch('/payment-methods/:id', requireRole(...ROLES.manage), ah(async (req, res) => {
  requireUuid(req.params.id);
  const fields = methodFields(req.body || {}, false);
  const set = buildSet(fields, 3);
  if (!set) throw badRequest('No hay cambios', 'NO_CHANGES');
  const method = await withTenant(req.tenant.id, async (db) => {
    const cur = (await db.query('SELECT kind FROM payment_methods WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id])).rows[0];
    // "Clip en linea" lo usa el pago en linea: se puede renombrar, no cambiar de tipo.
    if (cur?.kind === 'en_linea' && fields.kind !== undefined) {
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
router.delete('/payment-methods/:id', requireRole(...ROLES.manage), ah(async (req, res) => {
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

export default router;
