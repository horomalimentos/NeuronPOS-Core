// Promociones automaticas del POS y del portal (admin y gerente las editan;
// todos las leen). El calculo esta en services/promotions.js.
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { requireRole } from '../../middleware/auth.js';
import { isPromotionActive } from '../../services/promotions.js';
import { localParts } from '../../services/hours.js';
import { ah, badRequest, bool, buildSet, money, notFound, oneOf, requireUuid, str } from '../../utils/http.js';
import { ROLES, insertSql, int, uuidList } from './common.js';

const router = Router();

const KINDS = ['nxm', 'paquete', 'porcentaje', 'monto', 'regalo'];
const COLS = `id, name, description, kind, item_ids, category_ids, buy_quantity, pay_quantity, percent, amount,
  bundle_price, reward_item_id, reward_quantity, same_modifiers, min_amount, applies_pos, applies_web, branch_ids,
  to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on, days_of_week,
  to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time, priority, active`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function optional(value, re, field) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!re.test(String(value))) throw badRequest(`El campo "${field}" no es valido`, 'INVALID_FIELD');
  return String(value);
}

function fields(body, creating) {
  const pct = body.percent === undefined || body.percent === null || body.percent === '' ? body.percent ?? undefined : Number(body.percent);
  if (pct !== undefined && pct !== null && !(pct >= 0 && pct <= 100)) throw badRequest('El porcentaje debe estar entre 0 y 100', 'INVALID_FIELD');
  const days = body.days_of_week === undefined ? undefined : body.days_of_week;
  if (days !== undefined && (!Array.isArray(days) || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) {
    throw badRequest('Los dias deben ser numeros del 0 (domingo) al 6 (sabado)', 'INVALID_FIELD');
  }
  const nullableMoney = (v, field) => (v === null || v === '' ? null : money(v, { field }));
  const f = {
    name: str(body.name, { field: 'name', required: creating, max: 80 }),
    description: str(body.description, { field: 'description', max: 300 }),
    kind: oneOf(body.kind, KINDS, 'kind'),
    item_ids: uuidList(body.item_ids, 'item_ids'),
    category_ids: uuidList(body.category_ids, 'category_ids'),
    buy_quantity: int(body.buy_quantity, { field: 'buy_quantity', min: 1, max: 100, nullable: true }),
    pay_quantity: int(body.pay_quantity, { field: 'pay_quantity', min: 0, max: 99, nullable: true }),
    percent: pct === undefined ? undefined : pct === null || pct === '' ? null : Math.round(pct * 100) / 100,
    amount: body.amount === undefined ? undefined : nullableMoney(body.amount, 'amount'),
    bundle_price: body.bundle_price === undefined ? undefined : nullableMoney(body.bundle_price, 'bundle_price'),
    reward_item_id: body.reward_item_id === undefined ? undefined : body.reward_item_id ? requireUuid(body.reward_item_id, 'reward_item_id') : null,
    reward_quantity: int(body.reward_quantity, { field: 'reward_quantity', min: 1, max: 100, nullable: true }),
    same_modifiers: bool(body.same_modifiers, 'same_modifiers'),
    min_amount: body.min_amount === undefined ? undefined : money(body.min_amount || 0, { field: 'min_amount' }),
    applies_pos: bool(body.applies_pos, 'applies_pos'),
    applies_web: bool(body.applies_web, 'applies_web'),
    branch_ids: uuidList(body.branch_ids, 'branch_ids'),
    starts_on: optional(body.starts_on, DATE_RE, 'starts_on'),
    ends_on: optional(body.ends_on, DATE_RE, 'ends_on'),
    days_of_week: days === undefined ? undefined : [...new Set(days)].sort(),
    start_time: optional(body.start_time, TIME_RE, 'start_time'),
    end_time: optional(body.end_time, TIME_RE, 'end_time'),
    priority: int(body.priority, { field: 'priority', min: 0, max: 1000 }),
    active: bool(body.active, 'active'),
  };
  if (f.name === null) throw badRequest('El nombre no puede quedar vacio', 'MISSING_FIELD');
  if (creating && !f.kind) throw badRequest('Elige el tipo de promocion', 'MISSING_FIELD');
  return f;
}

/** Reglas del tipo sobre la promocion completa (para mensajes claros antes del CHECK). */
function checkKind(p) {
  const need = (cond, msg) => { if (!cond) throw badRequest(msg, 'INVALID_PROMOTION'); };
  if (p.kind === 'nxm') {
    need(p.buy_quantity && p.pay_quantity !== null && p.pay_quantity !== undefined, 'Indica cuantas lleva y cuantas paga (ej. 2x1)');
    need(p.pay_quantity < p.buy_quantity, 'Debe pagar menos piezas de las que lleva');
  }
  if (p.kind === 'paquete') need(p.buy_quantity && p.bundle_price !== null && p.bundle_price !== undefined, 'Indica las piezas y el precio del paquete');
  if (p.kind === 'porcentaje') need(p.percent !== null && p.percent !== undefined, 'Indica el porcentaje de descuento');
  if (p.kind === 'monto') need(p.amount !== null && p.amount !== undefined, 'Indica el monto de descuento');
  if (p.kind === 'regalo') need(p.reward_item_id, 'Elige el producto de regalo');
  if (p.starts_on && p.ends_on) need(p.ends_on >= p.starts_on, 'La fecha final es anterior a la inicial');
  if ((p.start_time && !p.end_time) || (!p.start_time && p.end_time)) need(false, 'Indica la hora de inicio y la de fin');
}

async function checkRefs(db, rid, f) {
  const count = async (table, ids) => (ids?.length
    ? (await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE restaurant_id = $1 AND id = ANY($2::uuid[])`, [rid, ids])).rows[0].n
    : 0);
  if (f.item_ids?.length && (await count('menu_items', f.item_ids)) !== f.item_ids.length) throw badRequest('Algun producto no existe', 'ITEM_NOT_FOUND');
  if (f.category_ids?.length && (await count('menu_categories', f.category_ids)) !== f.category_ids.length) throw badRequest('Alguna categoria no existe', 'CATEGORY_NOT_FOUND');
  if (f.branch_ids?.length && (await count('branches', f.branch_ids)) !== f.branch_ids.length) throw badRequest('Alguna sucursal no existe', 'BRANCH_NOT_FOUND');
  if (f.reward_item_id && !(await count('menu_items', [f.reward_item_id]))) throw badRequest('El producto de regalo no existe', 'ITEM_NOT_FOUND');
}

const getOne = async (db, rid, id) => (await db.query(`SELECT ${COLS} FROM promotions WHERE id = $1 AND restaurant_id = $2`, [id, rid])).rows[0];

// Lista. Cada una trae active_now (aplica en este momento) para la sucursal dada.
router.get('/promotions', requireRole(...ROLES.kitchen), ah(async (req, res) => {
  const branchId = req.query.branch_id ? requireUuid(req.query.branch_id, 'branch_id') : null;
  const promotions = await withTenant(req.tenant.id, async (db) => {
    const rows = (await db.query(`SELECT ${COLS} FROM promotions WHERE restaurant_id = $1 ORDER BY active DESC, priority, name`, [req.tenant.id])).rows;
    const tz = branchId
      ? (await db.query('SELECT timezone FROM branches WHERE id = $1 AND restaurant_id = $2', [branchId, req.tenant.id])).rows[0]?.timezone
      : null;
    const when = localParts(new Date(), tz || 'America/Mexico_City');
    return rows.map((p) => ({
      ...p,
      active_now: isPromotionActive(p, { when, branchId: branchId || p.branch_ids[0], source: 'pos' })
        || isPromotionActive(p, { when, branchId: branchId || p.branch_ids[0], source: 'web' }),
    }));
  });
  res.json({ promotions });
}));

router.post('/promotions', requireRole(...ROLES.manage), ah(async (req, res) => {
  const f = fields(req.body || {}, true);
  checkKind(f);
  const promotion = await withTenant(req.tenant.id, async (db) => {
    await checkRefs(db, req.tenant.id, f);
    const q = insertSql('promotions', req.tenant.id, f, 'id');
    const { rows } = await db.query(q.text, q.values);
    return getOne(db, req.tenant.id, rows[0].id);
  });
  res.status(201).json({ promotion });
}));

router.patch('/promotions/:id', requireRole(...ROLES.manage), ah(async (req, res) => {
  requireUuid(req.params.id);
  const f = fields(req.body || {}, false);
  const set = buildSet(f, 3);
  if (!set) throw badRequest('No hay cambios', 'NO_CHANGES');
  const promotion = await withTenant(req.tenant.id, async (db) => {
    const current = await getOne(db, req.tenant.id, req.params.id);
    if (!current) throw notFound('Promocion no encontrada', 'PROMOTION_NOT_FOUND');
    checkKind({ ...current, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) });
    await checkRefs(db, req.tenant.id, f);
    await db.query(`UPDATE promotions SET ${set.sql}, updated_at = now() WHERE id = $1 AND restaurant_id = $2`, [req.params.id, req.tenant.id, ...set.values]);
    return getOne(db, req.tenant.id, req.params.id);
  });
  res.json({ promotion });
}));

// Una promocion que ya se aplico en ventas se desactiva en lugar de borrarse.
router.delete('/promotions/:id', requireRole(...ROLES.manage), ah(async (req, res) => {
  requireUuid(req.params.id);
  const result = await withTenant(req.tenant.id, async (db) => {
    const used = await db.query('SELECT 1 FROM order_promotions WHERE promotion_id = $1 AND restaurant_id = $2 LIMIT 1', [req.params.id, req.tenant.id]);
    if (used.rowCount) {
      const { rowCount } = await db.query('UPDATE promotions SET active = false, updated_at = now() WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]);
      if (!rowCount) throw notFound('Promocion no encontrada', 'PROMOTION_NOT_FOUND');
      return { archived: true };
    }
    const { rowCount } = await db.query('DELETE FROM promotions WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]);
    if (!rowCount) throw notFound('Promocion no encontrada', 'PROMOTION_NOT_FOUND');
    return null;
  });
  if (result) return res.json(result);
  res.status(204).end();
}));

export default router;
