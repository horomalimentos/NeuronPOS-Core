// Caja sin internet (modulo "sin_internet"). Cuando se cae el internet, la
// caja sigue vendiendo para llevar con el menu guardado en el navegador y
// guarda cada venta ya cobrada en una cola local. Al volver la conexion la
// cola se sube aqui, una venta a la vez.
//
// - Idempotente: cada venta trae offline_id (uuid generado en la caja). Si ya
//   se subio, se regresa la misma orden sin duplicar nada.
// - Se respeta lo que se cobro: precio, modificadores e impuesto vienen de la
//   caja (el menu guardado). El producto debe existir en el restaurante
//   aunque hoy este inactivo o agotado. No aplican promociones ni vales.
// - Llega cobrada completa: los pagos suman exactamente el total. Solo
//   efectivo y tarjeta/transferencia (puntos, monedero, Clip y dolares
//   necesitan internet).
// - Entra al turno de caja con el que se vendio; si ese turno ya se cerro, al
//   turno abierto de la misma sucursal (de preferencia de la misma caja). Si
//   no hay ninguno abierto responde 409 y la caja lo vuelve a intentar.
// - No pasa por cocina (la comanda se imprimio en la caja): sus articulos
//   quedan enviados y listos con la hora de la venta.
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { requireModule } from '../../middleware/requireModule.js';
import { deductOrder } from '../../services/inventory.js';
import { assertDeviceBranch, requireDevice } from '../../services/devices.js';
import { can } from '../../services/permissions.js';
import { calculateOrderTotals, normalizePayments, toCents } from '../../services/posMath.js';
import {
  HttpError, ah, badRequest, money, requireUuid, str,
} from '../../utils/http.js';
import { int, requireBranch } from './common.js';
import { loadOrder, nextFolio } from './orders.js';

const router = Router();

const MAX_FUTURE_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 31 * 24 * 60 * 60 * 1000;
const NO_OFFLINE_KINDS = ['puntos', 'monedero', 'en_linea'];

function readSale(body) {
  const offlineId = requireUuid(body.offline_id, 'offline_id');
  const createdAt = new Date(body.created_at);
  if (!body.created_at || Number.isNaN(createdAt.getTime())) throw badRequest('Falta la hora de la venta', 'MISSING_FIELD');
  const now = Date.now();
  if (createdAt.getTime() > now + MAX_FUTURE_MS || createdAt.getTime() < now - MAX_AGE_MS) {
    throw badRequest('La hora de la venta no es valida', 'OFFLINE_BAD_DATE');
  }
  const taxRatePct = Number(body.tax_rate_pct ?? 0);
  if (!(taxRatePct >= 0 && taxRatePct <= 100)) throw badRequest('Impuesto no valido', 'INVALID_FIELD');
  if (!Array.isArray(body.items) || !body.items.length) throw badRequest('La venta no tiene articulos', 'MISSING_ITEMS');
  if (body.items.length > 100) throw badRequest('Demasiados articulos', 'INVALID_FIELD');
  if (!Array.isArray(body.payments) || !body.payments.length) throw badRequest('La venta no tiene pagos', 'MISSING_PAYMENTS');
  if (body.payments.length > 10) throw badRequest('Demasiados pagos', 'INVALID_FIELD');
  return {
    offlineId,
    createdAt,
    branchId: body.branch_id,
    cashSessionId: body.cash_session_id ? requireUuid(body.cash_session_id, 'cash_session_id') : null,
    localFolio: str(body.local_folio, { field: 'local_folio', max: 30 }) || null,
    customerName: str(body.customer_name, { field: 'customer_name', max: 120 }) || null,
    notes: str(body.notes, { field: 'notes', max: 500 }) || null,
    taxRatePct,
    pricesIncludeTax: body.prices_include_tax !== false,
    items: body.items.map((it) => ({
      menu_item_id: requireUuid(it?.menu_item_id, 'menu_item_id'),
      quantity: int(it.quantity ?? 1, { field: 'quantity', min: 1, max: 999 }),
      unit_price: money(it.unit_price, { field: 'unit_price' }),
      notes: str(it.notes, { field: 'notes', max: 300 }) || null,
      modifiers: (Array.isArray(it.modifiers) ? it.modifiers : []).slice(0, 50).map((m) => ({
        id: requireUuid(m?.id, 'modifier_id'),
        price_delta: Number(m.price_delta ?? 0),
      })),
    })),
    payments: body.payments.map((p) => ({
      payment_method_id: requireUuid(p?.payment_method_id, 'payment_method_id'),
      amount: money(p.amount, { field: 'amount' }),
      tip: money(p.tip ?? 0, { field: 'tip' }),
      received: p.received === undefined || p.received === null || p.received === ''
        ? undefined : money(p.received, { field: 'received' }),
      reference: str(p.reference, { field: 'reference', max: 100 }) || null,
    })),
  };
}

/** Turno donde entra la venta: el suyo si sigue abierto, si no otro abierto de la sucursal. */
async function sessionFor(db, restaurantId, branchId, sessionId) {
  const own = sessionId ? (await db.query(
    'SELECT id, branch_id, status, terminal FROM cash_sessions WHERE id = $1 AND restaurant_id = $2',
    [sessionId, restaurantId],
  )).rows[0] : null;
  if (own && own.branch_id === branchId && own.status === 'abierta') return own.id;
  const other = (await db.query(
    `SELECT id FROM cash_sessions WHERE restaurant_id = $1 AND branch_id = $2 AND status = 'abierta'
      ORDER BY (terminal = $3) DESC, opened_at DESC LIMIT 1`,
    [restaurantId, branchId, own?.terminal ?? null],
  )).rows[0];
  if (!other) throw new HttpError(409, 'Abre la caja de esta sucursal para subir las ventas sin internet', 'CASH_SESSION_CLOSED');
  return other.id;
}

router.post('/offline-orders', can('cashier'), requireModule('sin_internet'), requireDevice, ah(async (req, res) => {
  const sale = readSale(req.body || {});
  const branchId = requireBranch(req, sale.branchId);
  assertDeviceBranch(req, branchId);

  const result = await withTenant(req.tenant.id, async (db) => {
    // Dos intentos al mismo tiempo de la misma venta: el segundo espera y la encuentra.
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`offline:${sale.offlineId}`]);
    const existing = (await db.query(
      'SELECT id FROM orders WHERE restaurant_id = $1 AND offline_id = $2',
      [req.tenant.id, sale.offlineId],
    )).rows[0];
    if (existing) return { order: await loadOrder(db, req.tenant.id, existing.id), duplicate: true };

    const branch = (await db.query('SELECT id FROM branches WHERE id = $1 AND restaurant_id = $2', [branchId, req.tenant.id])).rows[0];
    if (!branch) throw badRequest('La sucursal no existe', 'BRANCH_NOT_FOUND');

    // Productos y modificadores: que existan en este restaurante (activos o no).
    const itemIds = [...new Set(sale.items.map((i) => i.menu_item_id))];
    const menuItems = new Map((await db.query(
      `SELECT i.id, i.name, coalesce(i.station_id, c.station_id) AS station_id
         FROM menu_items i
         LEFT JOIN menu_categories c ON c.id = i.category_id AND c.restaurant_id = i.restaurant_id
        WHERE i.restaurant_id = $1 AND i.id = ANY($2::uuid[])`,
      [req.tenant.id, itemIds],
    )).rows.map((r) => [r.id, r]));
    const modIds = [...new Set(sale.items.flatMap((i) => i.modifiers.map((m) => m.id)))];
    const modifiers = new Map((await db.query(
      `SELECT m.id, m.name, g.name AS group_name
         FROM modifiers m JOIN modifier_groups g ON g.id = m.group_id AND g.restaurant_id = m.restaurant_id
        WHERE m.restaurant_id = $1 AND m.id = ANY($2::uuid[])`,
      [req.tenant.id, modIds],
    )).rows.map((m) => [m.id, m]));
    const lines = sale.items.map((it) => {
      const mi = menuItems.get(it.menu_item_id);
      if (!mi) throw badRequest('Algun producto ya no existe', 'ITEM_NOT_FOUND');
      const mods = it.modifiers.map((m) => {
        const row = modifiers.get(m.id);
        if (!row) throw badRequest(`Algun modificador de "${mi.name}" ya no existe`, 'MODIFIER_NOT_FOUND');
        if (!Number.isFinite(m.price_delta)) throw badRequest('Precio de modificador no valido', 'INVALID_FIELD');
        return { ...row, price_delta: toCents(m.price_delta) / 100 };
      });
      const modsCents = mods.reduce((s, m) => s + toCents(m.price_delta), 0);
      const unitCents = toCents(it.unit_price);
      if (unitCents + modsCents < 0) throw badRequest(`"${mi.name}": el precio no puede ser negativo`, 'INVALID_PRICE');
      return {
        ...it, name: mi.name, station_id: mi.station_id, modifiers: mods,
        unit_price: unitCents / 100, modifiers_total: modsCents / 100,
        line_total: ((unitCents + modsCents) * it.quantity) / 100,
      };
    });
    const totals = calculateOrderTotals(lines, { taxRatePct: sale.taxRatePct, pricesIncludeTax: sale.pricesIncludeTax });

    // Pagos: metodos que no necesitan internet y que cubran el total exacto.
    const methods = new Map((await db.query(
      'SELECT id, kind, currency FROM payment_methods WHERE restaurant_id = $1 AND id = ANY($2::uuid[])',
      [req.tenant.id, sale.payments.map((p) => p.payment_method_id)],
    )).rows.map((m) => [m.id, m]));
    const payLines = sale.payments.map((p) => {
      const m = methods.get(p.payment_method_id);
      if (!m) throw badRequest('Metodo de pago no valido', 'PAYMENT_METHOD_NOT_FOUND');
      if (NO_OFFLINE_KINDS.includes(m.kind) || m.currency !== 'MXN') {
        throw badRequest('Ese metodo de pago no se puede usar sin internet', 'OFFLINE_METHOD_NOT_ALLOWED');
      }
      return { ...p, kind: m.kind };
    });
    const norm = normalizePayments(payLines, totals.total);
    if (norm.remaining_after !== 0) throw badRequest('La venta sin internet debe llegar cobrada completa', 'OFFLINE_NOT_PAID');

    const sessionId = await sessionFor(db, req.tenant.id, branchId, sale.cashSessionId);
    const folio = await nextFolio(db, req.tenant.id, branchId);
    const at = sale.createdAt.toISOString();
    const notes = [sale.localFolio ? `Venta sin internet (folio en caja ${sale.localFolio})` : 'Venta sin internet', sale.notes]
      .filter(Boolean).join('. ');
    const tips = norm.lines.reduce((s, p) => s + toCents(p.tip), 0) / 100;
    const { rows: [order] } = await db.query(
      `INSERT INTO orders (restaurant_id, branch_id, folio, order_type, customer_name, notes, status,
                           subtotal, tax_rate_pct, prices_include_tax, tax_amount, total, paid_amount, tip_amount,
                           created_by, sent_at, ready_at, paid_at, created_at, updated_at, source, offline_id)
       VALUES ($1, $2, $3, 'para_llevar', $4, $5, 'pagada', $6, $7, $8, $9, $10, $10, $11, $12, $13, $13, $13, $13, now(), 'pos', $14)
       RETURNING id`,
      [req.tenant.id, branchId, folio, sale.customerName, notes, totals.subtotal, sale.taxRatePct, sale.pricesIncludeTax,
        totals.tax_amount, totals.total, tips, req.user.id, at, sale.offlineId],
    );
    for (const l of lines) {
      const { rows: [item] } = await db.query(
        `INSERT INTO order_items (restaurant_id, order_id, menu_item_id, name, unit_price, modifiers_total,
                                  quantity, line_total, notes, created_by, station_id, sent_at, ready_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12) RETURNING id`,
        [req.tenant.id, order.id, l.menu_item_id, l.name, l.unit_price, l.modifiers_total, l.quantity, l.line_total,
          l.notes, req.user.id, l.station_id || null, at],
      );
      for (const m of l.modifiers) {
        await db.query(
          `INSERT INTO order_item_modifiers (restaurant_id, order_item_id, modifier_id, group_name, name, price_delta)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [req.tenant.id, item.id, m.id, m.group_name, m.name, m.price_delta],
        );
      }
    }
    for (const [i, p] of norm.lines.entries()) {
      await db.query(
        `INSERT INTO order_payments (restaurant_id, order_id, payment_method_id, cash_session_id, amount, tip,
                                     received, change_given, reference, created_by, currency, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'MXN', $11)`,
        [req.tenant.id, order.id, payLines[i].payment_method_id, sessionId, p.amount, p.tip, p.received,
          p.change_given, payLines[i].reference, req.user.id, at],
      );
    }
    await deductOrder(db, req.tenant.id, order.id, req.user.id);
    return { order: await loadOrder(db, req.tenant.id, order.id), duplicate: false };
  });
  res.status(result.duplicate ? 200 : 201).json(result);
}));

export default router;
