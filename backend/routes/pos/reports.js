// Reportes de ventas del POS (y de los pedidos en linea que pasan por el):
// resumen, por dia y hora, metodos de pago, tipos de orden, sucursales,
// productos, categorias, modificadores y personal. Cuenta las ordenes pagadas
// cuyo pago cae en el rango de fechas, en la zona horaria de cada sucursal.
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { requireRole } from '../../middleware/auth.js';
import { ah, badRequest } from '../../utils/http.js';
import { ROLES, requireBranch } from './common.js';

const router = Router();
const manager = requireRole(...ROLES.manage);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;

const toDate = (s) => new Date(`${s}T00:00:00Z`);
const fmt = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

/** Valida from/to (YYYY-MM-DD) y calcula el periodo anterior de la misma duracion. */
export function parseRange(from, to) {
  if (!DATE_RE.test(String(from || '')) || !DATE_RE.test(String(to || ''))) {
    throw badRequest('Indica las fechas "from" y "to" (AAAA-MM-DD)', 'INVALID_RANGE');
  }
  const a = toDate(from);
  const b = toDate(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || fmt(a) !== from || fmt(b) !== to) {
    throw badRequest('Fecha invalida', 'INVALID_RANGE');
  }
  if (b < a) throw badRequest('La fecha final es anterior a la inicial', 'INVALID_RANGE');
  const days = Math.round((b - a) / 86400000) + 1;
  if (days > MAX_DAYS) throw badRequest(`El rango maximo es de ${MAX_DAYS} dias`, 'INVALID_RANGE');
  return { from, to, days, prevFrom: fmt(addDays(a, -days)), prevTo: fmt(addDays(a, -1)) };
}

// Ordenes pagadas en el rango ($2..$3, fechas locales de la sucursal),
// opcionalmente de una sola sucursal ($4).
const PAID = `
  paid AS (
    SELECT o.*, (o.paid_at AT TIME ZONE b.timezone) AS local_at, b.name AS branch_name
      FROM orders o
      JOIN branches b ON b.id = o.branch_id AND b.restaurant_id = o.restaurant_id
     WHERE o.restaurant_id = $1 AND o.status = 'pagada'
       AND (o.paid_at AT TIME ZONE b.timezone)::date BETWEEN $2::date AND $3::date
       AND ($4::uuid IS NULL OR o.branch_id = $4)
  )`;

const TOTALS = `
  WITH ${PAID}
  SELECT count(*)::int AS orders,
         coalesce(sum(subtotal), 0) AS subtotal,
         coalesce(sum(discount_amount), 0) AS discounts,
         coalesce(sum(tax_amount), 0) AS tax,
         coalesce(sum(delivery_fee), 0) AS delivery_fees,
         coalesce(sum(total), 0) AS total,
         coalesce(sum(tip_amount), 0) AS tips,
         coalesce(sum(guests), 0)::int AS guests
    FROM paid`;

const n = (v) => Number(v || 0);
const round2 = (v) => Math.round(v * 100) / 100;

async function totals(db, params) {
  const t = (await db.query(TOTALS, params)).rows[0];
  const out = {
    orders: t.orders,
    subtotal: n(t.subtotal),
    discounts: n(t.discounts),
    tax: n(t.tax),
    delivery_fees: n(t.delivery_fees),
    total: n(t.total),
    tips: n(t.tips),
    guests: t.guests,
  };
  out.average_ticket = out.orders ? round2(out.total / out.orders) : 0;
  return out;
}

router.get('/reports/sales', manager, ah(async (req, res) => {
  const range = parseRange(req.query.from, req.query.to);
  const branchId = req.query.branch_id ? requireBranch(req, req.query.branch_id) : null;
  const rid = req.tenant.id;
  const params = [rid, range.from, range.to, branchId];

  const report = await withTenant(rid, async (db) => {
    const q = async (sql, p = params) => (await db.query(sql, p)).rows;

    const summary = await totals(db, params);
    const previous = await totals(db, [rid, range.prevFrom, range.prevTo, branchId]);

    // Canceladas y articulos cancelados despues de enviarse a cocina (en el rango).
    const [cancelled] = await q(`
      SELECT count(*)::int AS orders, coalesce(sum(o.total), 0) AS total
        FROM orders o JOIN branches b ON b.id = o.branch_id AND b.restaurant_id = o.restaurant_id
       WHERE o.restaurant_id = $1 AND o.status = 'cancelada'
         AND (o.cancelled_at AT TIME ZONE b.timezone)::date BETWEEN $2::date AND $3::date
         AND ($4::uuid IS NULL OR o.branch_id = $4)`);
    const [voided] = await q(`
      SELECT coalesce(sum(i.quantity), 0)::int AS items, coalesce(sum(i.line_total), 0) AS total
        FROM order_items i
        JOIN orders o ON o.id = i.order_id AND o.restaurant_id = i.restaurant_id
        JOIN branches b ON b.id = o.branch_id AND b.restaurant_id = o.restaurant_id
       WHERE i.restaurant_id = $1 AND i.voided_at IS NOT NULL
         AND (i.voided_at AT TIME ZONE b.timezone)::date BETWEEN $2::date AND $3::date
         AND ($4::uuid IS NULL OR o.branch_id = $4)`);

    const byDay = await q(`
      WITH ${PAID}
      SELECT to_char(local_at::date, 'YYYY-MM-DD') AS date, count(*)::int AS orders, sum(total) AS total
        FROM paid GROUP BY 1 ORDER BY 1`);
    const byHour = await q(`
      WITH ${PAID}
      SELECT extract(hour FROM local_at)::int AS hour, count(*)::int AS orders, sum(total) AS total
        FROM paid GROUP BY 1 ORDER BY 1`);
    const byWeekday = await q(`
      WITH ${PAID}
      SELECT extract(isodow FROM local_at)::int AS weekday, count(*)::int AS orders, sum(total) AS total
        FROM paid GROUP BY 1 ORDER BY 1`);

    const byPayment = await q(`
      WITH ${PAID}
      SELECT pm.id, pm.name, pm.kind, count(DISTINCT p.order_id)::int AS orders,
             sum(p.amount) AS amount, sum(p.tip) AS tips
        FROM order_payments p
        JOIN paid ON paid.id = p.order_id
        JOIN payment_methods pm ON pm.id = p.payment_method_id AND pm.restaurant_id = p.restaurant_id
       WHERE p.restaurant_id = $1
       GROUP BY pm.id, pm.name, pm.kind, pm.sort_order
       ORDER BY sum(p.amount) DESC, pm.sort_order`);

    const byType = await q(`
      WITH ${PAID}
      SELECT order_type, source, count(*)::int AS orders, sum(total) AS total
        FROM paid GROUP BY 1, 2 ORDER BY sum(total) DESC`);

    const byBranch = await q(`
      WITH ${PAID}
      SELECT branch_id, branch_name, count(*)::int AS orders, sum(total) AS total, sum(tip_amount) AS tips
        FROM paid GROUP BY 1, 2 ORDER BY sum(total) DESC`);

    // Productos (sin articulos cancelados). line_total es antes del descuento de la orden.
    const items = await q(`
      WITH ${PAID}
      SELECT i.menu_item_id, i.name, c.name AS category,
             sum(i.quantity)::int AS quantity, sum(i.line_total) AS total, count(DISTINCT i.order_id)::int AS orders
        FROM order_items i
        JOIN paid ON paid.id = i.order_id
        LEFT JOIN menu_items mi ON mi.id = i.menu_item_id AND mi.restaurant_id = i.restaurant_id
        LEFT JOIN menu_categories c ON c.id = mi.category_id AND c.restaurant_id = mi.restaurant_id
       WHERE i.restaurant_id = $1 AND i.voided_at IS NULL
       GROUP BY i.menu_item_id, i.name, c.name
       ORDER BY sum(i.line_total) DESC, i.name`);

    const categories = await q(`
      WITH ${PAID}
      SELECT coalesce(c.name, 'Sin categoría') AS category,
             sum(i.quantity)::int AS quantity, sum(i.line_total) AS total
        FROM order_items i
        JOIN paid ON paid.id = i.order_id
        LEFT JOIN menu_items mi ON mi.id = i.menu_item_id AND mi.restaurant_id = i.restaurant_id
        LEFT JOIN menu_categories c ON c.id = mi.category_id AND c.restaurant_id = mi.restaurant_id
       WHERE i.restaurant_id = $1 AND i.voided_at IS NULL
       GROUP BY 1 ORDER BY sum(i.line_total) DESC`);

    const modifiers = await q(`
      WITH ${PAID}
      SELECT m.group_name, m.name, sum(i.quantity)::int AS quantity, sum(m.price_delta * i.quantity) AS total
        FROM order_item_modifiers m
        JOIN order_items i ON i.id = m.order_item_id AND i.restaurant_id = m.restaurant_id
        JOIN paid ON paid.id = i.order_id
       WHERE m.restaurant_id = $1 AND i.voided_at IS NULL
       GROUP BY 1, 2 ORDER BY sum(i.quantity) DESC, 1, 2`);

    // Quien abrio la orden (mesero o cajero); los pedidos en linea no tienen.
    const staff = await q(`
      WITH ${PAID}
      SELECT paid.created_by AS user_id, coalesce(u.name, 'Pedidos en línea') AS name,
             count(*)::int AS orders, sum(paid.total) AS total, sum(paid.tip_amount) AS tips,
             sum(paid.discount_amount) AS discounts
        FROM paid
        LEFT JOIN users u ON u.id = paid.created_by AND u.restaurant_id = paid.restaurant_id
       GROUP BY 1, 2 ORDER BY sum(paid.total) DESC`);

    const money = (rows, ...keys) => rows.map((r) => {
      const o = { ...r };
      for (const k of keys) o[k] = n(r[k]);
      return o;
    });

    return {
      range: { from: range.from, to: range.to, days: range.days, branch_id: branchId },
      previous_range: { from: range.prevFrom, to: range.prevTo },
      summary,
      previous,
      cancelled: { orders: cancelled.orders, total: n(cancelled.total) },
      voided: { items: voided.items, total: n(voided.total) },
      by_day: money(byDay, 'total'),
      by_hour: money(byHour, 'total'),
      by_weekday: money(byWeekday, 'total'),
      by_payment_method: money(byPayment, 'amount', 'tips'),
      by_order_type: money(byType, 'total'),
      by_branch: money(byBranch, 'total', 'tips'),
      items: money(items, 'total'),
      categories: money(categories, 'total'),
      modifiers: money(modifiers, 'total'),
      staff: money(staff, 'total', 'tips', 'discounts'),
    };
  });
  res.json(report);
}));

export default router;
