// Existencias por sucursal, kardex (movimientos), mermas y ajustes, y el
// reporte de consumo (lo vendido por receta contra mermas y diferencias de
// conteo) en un rango de fechas.
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { requireRole } from '../../middleware/auth.js';
import { applyMovement, round4, toBase } from '../../services/inventory.js';
import { ah, badRequest, forbidden, oneOf, requireUuid, str } from '../../utils/http.js';
import { assertBranchExists, int, requireBranch } from '../pos/common.js';
import { parseRange } from '../pos/reports.js';
import { INV_ROLES, getProduct, loadProducts, purchaseUnit, qty } from './common.js';

const router = Router();
const staff = requireRole(...INV_ROLES.staff);
const manage = requireRole(...INV_ROLES.manage);

/** Existencias de la sucursal con valor, minimo y sugerencia de compra. */
export async function stockView(db, rid, branchId, coverDays) {
  const products = await loadProducts(db, rid);
  const stock = new Map((await db.query(
    'SELECT product_id, quantity, last_count_at FROM inv_stock WHERE restaurant_id = $1 AND branch_id = $2',
    [rid, branchId],
  )).rows.map((s) => [s.product_id, s]));
  return products.map((p) => {
    const s = stock.get(p.id);
    const quantity = s ? Number(s.quantity) : 0;
    const target = Math.max(Number(p.min_stock), Number(p.daily_use) * coverDays);
    const need = round4(target - quantity);
    const pu = purchaseUnit(p);
    return {
      ...p,
      quantity,
      last_count_at: s?.last_count_at || null,
      value: Math.round(quantity * Number(p.unit_cost) * 100) / 100,
      below_min: Number(p.min_stock) > 0 && quantity < Number(p.min_stock),
      days_left: Number(p.daily_use) > 0 ? Math.max(0, Math.floor(quantity / Number(p.daily_use))) : null,
      suggested: need > 0 ? { unit: pu.name, factor: pu.factor, quantity: Math.ceil(need / pu.factor) } : null,
    };
  });
}

router.get('/stock', staff, ah(async (req, res) => {
  const branchId = requireBranch(req, req.query.branch_id);
  const data = await withTenant(req.tenant.id, async (db) => {
    const { order_cover_days: days } = (await db.query('SELECT order_cover_days FROM inv_settings WHERE restaurant_id = $1', [req.tenant.id])).rows[0] || { order_cover_days: 3 };
    const products = await stockView(db, req.tenant.id, branchId, days);
    const total = Math.round(products.reduce((a, p) => a + p.value, 0) * 100) / 100;
    return { products, total_value: total, cover_days: days };
  });
  res.json(data);
}));

const KINDS = ['conteo', 'compra', 'venta', 'cancelacion', 'merma', 'ajuste'];

router.get('/movements', staff, ah(async (req, res) => {
  const branchId = requireBranch(req, req.query.branch_id);
  const productId = req.query.product_id ? requireUuid(req.query.product_id, 'product_id') : null;
  const kind = oneOf(req.query.kind || undefined, KINDS, 'kind') || null;
  const limit = int(req.query.limit ?? 200, { field: 'limit', min: 1, max: 1000 });
  const movements = await withTenant(req.tenant.id, async (db) => (await db.query(
    `SELECT m.id, m.product_id, p.name AS product_name, p.base_unit, m.kind, m.quantity, m.balance, m.unit_cost,
            m.reason, m.order_id, m.count_id, m.purchase_order_id, m.created_at, u.name AS created_by_name
       FROM inv_movements m
       JOIN inv_products p ON p.id = m.product_id AND p.restaurant_id = m.restaurant_id
       LEFT JOIN users u ON u.id = m.created_by AND u.restaurant_id = m.restaurant_id
      WHERE m.restaurant_id = $1 AND m.branch_id = $2
        AND ($3::uuid IS NULL OR m.product_id = $3) AND ($4::text IS NULL OR m.kind = $4)
      ORDER BY m.created_at DESC LIMIT $5`,
    [req.tenant.id, branchId, productId, kind, limit],
  )).rows);
  res.json({ movements });
}));

// Merma (sale de inventario con motivo) o ajuste manual (+/-, solo admin/gerente).
router.post('/movements', staff, ah(async (req, res) => {
  const body = req.body || {};
  const branchId = requireBranch(req, body.branch_id);
  const kind = oneOf(body.kind, ['merma', 'ajuste'], 'kind');
  if (!kind) throw badRequest('Indica si es merma o ajuste', 'MISSING_FIELD');
  if (kind === 'ajuste' && !INV_ROLES.manage.includes(req.user.role)) {
    throw forbidden('Solo un administrador o gerente puede hacer ajustes', 'ROLE_REQUIRED');
  }
  requireUuid(body.product_id, 'product_id');
  const amount = qty(body.quantity, { field: 'quantity', signed: kind === 'ajuste', positive: kind === 'merma' });
  if (!amount) throw badRequest('La cantidad no puede ser cero', 'INVALID_FIELD');
  const reason = str(body.reason, { field: 'reason', required: true, max: 200 });
  const result = await withTenant(req.tenant.id, async (db) => {
    await assertBranchExists(db, req.tenant.id, branchId);
    const p = await getProduct(db, req.tenant.id, body.product_id);
    const base = await toBase(db, req.tenant.id, p.id, Math.abs(amount), body.unit || p.base_unit);
    const delta = kind === 'merma' ? -base.quantity : Math.sign(amount) * base.quantity;
    const balance = await applyMovement(db, req.tenant.id, {
      branchId, productId: p.id, kind, quantity: delta, unitCost: p.unit_cost, reason, userId: req.user.id,
    });
    return { balance, quantity: delta };
  });
  res.status(201).json(result);
}));

// Consumo y diferencias por insumo en el rango (fechas locales de la sucursal).
router.get('/usage', manage, ah(async (req, res) => {
  const range = parseRange(req.query.from, req.query.to);
  const branchId = requireBranch(req, req.query.branch_id);
  const rows = await withTenant(req.tenant.id, async (db) => (await db.query(
    `SELECT p.id, p.name, p.base_unit, p.category, p.unit_cost,
            coalesce(sum(-m.quantity) FILTER (WHERE m.kind = 'venta'), 0) AS sold,
            coalesce(sum(m.quantity) FILTER (WHERE m.kind = 'cancelacion'), 0) AS returned,
            coalesce(sum(-m.quantity) FILTER (WHERE m.kind = 'merma'), 0) AS waste,
            coalesce(sum(m.quantity) FILTER (WHERE m.kind = 'compra'), 0) AS purchased,
            coalesce(sum(m.quantity) FILTER (WHERE m.kind = 'conteo'), 0) AS count_diff,
            coalesce(sum(m.quantity) FILTER (WHERE m.kind = 'ajuste'), 0) AS adjusted
       FROM inv_movements m
       JOIN branches b ON b.id = m.branch_id AND b.restaurant_id = m.restaurant_id
       JOIN inv_products p ON p.id = m.product_id AND p.restaurant_id = m.restaurant_id
      WHERE m.restaurant_id = $1 AND m.branch_id = $4
        AND (m.created_at AT TIME ZONE b.timezone)::date BETWEEN $2::date AND $3::date
      GROUP BY p.id ORDER BY p.name`,
    [req.tenant.id, range.from, range.to, branchId],
  )).rows);
  const products = rows.map((r) => {
    const o = { ...r };
    for (const k of ['unit_cost', 'sold', 'returned', 'waste', 'purchased', 'count_diff', 'adjusted']) o[k] = Number(r[k]);
    const cost = o.unit_cost;
    o.sold_cost = Math.round((o.sold - o.returned) * cost * 100) / 100;
    o.waste_cost = Math.round(o.waste * cost * 100) / 100;
    // Diferencia de conteo negativa = faltante (se uso o perdio mas de lo registrado).
    o.count_diff_cost = Math.round(o.count_diff * cost * 100) / 100;
    o.purchased_cost = Math.round(o.purchased * cost * 100) / 100;
    return o;
  });
  const sum = (k) => Math.round(products.reduce((a, p) => a + p[k], 0) * 100) / 100;
  res.json({
    range: { from: range.from, to: range.to },
    products,
    totals: { sold_cost: sum('sold_cost'), waste_cost: sum('waste_cost'), count_diff_cost: sum('count_diff_cost'), purchased_cost: sum('purchased_cost') },
  });
}));

export default router;
