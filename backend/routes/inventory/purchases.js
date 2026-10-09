// Compras: solicitudes y ordenes de compra por proveedor. Cualquier persona
// del inventario solicita; admin/gerente aprueba (o crea ya aprobada) y
// recibe: lo recibido entra a la existencia con su precio, que queda en el
// historial y como costo del insumo. Tambien sugiere que pedir segun
// existencia, minimo y consumo diario (como el pedido sugerido de Horom).
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { requireRole } from '../../middleware/auth.js';
import { applyMovement, round4 } from '../../services/inventory.js';
import { ah, badRequest, notFound, oneOf, requireUuid, str } from '../../utils/http.js';
import { assertBranchExists, canAccessBranch, imageUrl, int, requireBranch } from '../pos/common.js';
import { INV_ROLES, getProduct, loadSettings, qty } from './common.js';
import { stockView } from './stock.js';

const router = Router();
const staff = requireRole(...INV_ROLES.staff);
const manage = requireRole(...INV_ROLES.manage);
const isManager = (u) => INV_ROLES.manage.includes(u.role);
const round2 = (n) => Math.round(n * 100) / 100;

router.get('/purchase-suggestions', staff, ah(async (req, res) => {
  const branchId = requireBranch(req, req.query.branch_id);
  const data = await withTenant(req.tenant.id, async (db) => {
    const settings = await loadSettings(db, req.tenant.id);
    const stock = await stockView(db, req.tenant.id, branchId, settings.order_cover_days);
    // Ultimo precio pagado por unidad de compra (o el costo por unidad base).
    const lastPrices = new Map((await db.query(
      `SELECT DISTINCT ON (product_id, unit_name) product_id, unit_name, unit_price
         FROM inv_price_history WHERE restaurant_id = $1 ORDER BY product_id, unit_name, created_at DESC`,
      [req.tenant.id],
    )).rows.map((r) => [`${r.product_id}:${r.unit_name}`, Number(r.unit_price)]));
    const groups = new Map();
    for (const p of stock.filter((x) => x.suggested)) {
      const key = p.supplier_id || 'sin';
      if (!groups.has(key)) groups.set(key, { supplier_id: p.supplier_id, supplier_name: p.supplier_name || 'Sin proveedor', items: [] });
      const price = lastPrices.get(`${p.id}:${p.suggested.unit}`) ?? round4(Number(p.unit_cost) * p.suggested.factor);
      groups.get(key).items.push({
        product_id: p.id, name: p.name, base_unit: p.base_unit, stock: p.quantity, min_stock: Number(p.min_stock),
        daily_use: Number(p.daily_use), unit: p.suggested.unit, factor: p.suggested.factor,
        quantity: p.suggested.quantity, unit_price: price, units: p.units,
      });
    }
    return { cover_days: settings.order_cover_days, suppliers: [...groups.values()] };
  });
  res.json(data);
}));

const PO_SELECT = `
  SELECT o.id, o.folio, o.branch_id, b.name AS branch_name, o.supplier_id, s.name AS supplier_name, s.phone AS supplier_phone,
         o.status, o.notes, o.total, o.receipt_url, o.created_at, uc.name AS created_by_name,
         o.approved_at, ua.name AS approved_by_name, o.received_at, ur.name AS received_by_name, o.cancelled_reason,
         (SELECT count(*)::int FROM inv_purchase_order_items i WHERE i.purchase_order_id = o.id) AS items_count
    FROM inv_purchase_orders o
    JOIN branches b ON b.id = o.branch_id AND b.restaurant_id = o.restaurant_id
    LEFT JOIN inv_suppliers s ON s.id = o.supplier_id AND s.restaurant_id = o.restaurant_id
    LEFT JOIN users uc ON uc.id = o.created_by AND uc.restaurant_id = o.restaurant_id
    LEFT JOIN users ua ON ua.id = o.approved_by AND ua.restaurant_id = o.restaurant_id
    LEFT JOIN users ur ON ur.id = o.received_by AND ur.restaurant_id = o.restaurant_id`;

async function getPo(db, req, id, { lock = false } = {}) {
  requireUuid(id);
  if (lock) await db.query('SELECT 1 FROM inv_purchase_orders WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [id, req.tenant.id]);
  const po = (await db.query(`${PO_SELECT} WHERE o.id = $1 AND o.restaurant_id = $2`, [id, req.tenant.id])).rows[0];
  if (!po || !canAccessBranch(req.user, po.branch_id)) throw notFound('Orden de compra no encontrada', 'PO_NOT_FOUND');
  po.items = (await db.query(
    `SELECT i.id, i.product_id, p.name, p.base_unit, i.unit_name, i.unit_factor, i.quantity, i.unit_price, i.received_quantity
       FROM inv_purchase_order_items i JOIN inv_products p ON p.id = i.product_id AND p.restaurant_id = i.restaurant_id
      WHERE i.restaurant_id = $1 AND i.purchase_order_id = $2 ORDER BY p.name`,
    [req.tenant.id, id],
  )).rows;
  return po;
}

/** [{ product_id, quantity, unit, unit_price }] validado contra las unidades de cada insumo. */
async function parseItems(db, rid, list) {
  if (!Array.isArray(list) || !list.length || list.length > 300) throw badRequest('Agrega entre 1 y 300 insumos', 'INVALID_FIELD');
  const seen = new Set();
  const out = [];
  for (const l of list) {
    requireUuid(l?.product_id, 'product_id');
    if (seen.has(l.product_id)) throw badRequest('Hay insumos repetidos en la orden', 'INVALID_FIELD');
    seen.add(l.product_id);
    const p = await getProduct(db, rid, l.product_id);
    const unit = l.unit && l.unit !== p.base_unit ? p.units.find((u) => u.name === l.unit) : null;
    if (l.unit && l.unit !== p.base_unit && !unit) throw badRequest(`La unidad "${l.unit}" no existe para ${p.name}`, 'UNIT_NOT_FOUND');
    out.push({
      product_id: p.id,
      unit_name: unit ? unit.name : p.base_unit,
      unit_factor: unit ? Number(unit.factor) : 1,
      quantity: qty(l.quantity, { field: 'quantity', positive: true }),
      unit_price: qty(l.unit_price ?? 0, { field: 'unit_price' }),
    });
  }
  return out;
}

async function writeItems(db, rid, poId, items) {
  await db.query('DELETE FROM inv_purchase_order_items WHERE restaurant_id = $1 AND purchase_order_id = $2', [rid, poId]);
  for (const i of items) {
    await db.query(
      `INSERT INTO inv_purchase_order_items (restaurant_id, purchase_order_id, product_id, unit_name, unit_factor, quantity, unit_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [rid, poId, i.product_id, i.unit_name, i.unit_factor, i.quantity, i.unit_price],
    );
  }
  const total = round2(items.reduce((a, i) => a + i.quantity * i.unit_price, 0));
  await db.query('UPDATE inv_purchase_orders SET total = $3, updated_at = now() WHERE id = $1 AND restaurant_id = $2', [poId, rid, total]);
}

router.get('/purchase-orders', staff, ah(async (req, res) => {
  const branchId = req.query.branch_id ? requireBranch(req, req.query.branch_id) : null;
  if (!branchId && !isManager(req.user)) throw badRequest('Indica la sucursal', 'MISSING_FIELD');
  const status = oneOf(req.query.status || undefined, ['solicitada', 'aprobada', 'recibida', 'cancelada', 'abiertas'], 'status');
  const limit = int(req.query.limit ?? 100, { field: 'limit', min: 1, max: 500 });
  const orders = await withTenant(req.tenant.id, async (db) => (await db.query(
    `${PO_SELECT}
      WHERE o.restaurant_id = $1 AND ($2::uuid IS NULL OR o.branch_id = $2)
        AND ($3::text IS NULL OR ($3 = 'abiertas' AND o.status IN ('solicitada', 'aprobada')) OR o.status = $3)
      ORDER BY o.created_at DESC LIMIT $4`,
    [req.tenant.id, branchId, status || null, limit],
  )).rows);
  res.json({ orders });
}));

router.get('/purchase-orders/:id', staff, ah(async (req, res) => {
  res.json({ order: await withTenant(req.tenant.id, (db) => getPo(db, req, req.params.id)) });
}));

// Crear: el personal crea solicitudes; admin/gerente puede crearla aprobada.
router.post('/purchase-orders', staff, ah(async (req, res) => {
  const body = req.body || {};
  const branchId = requireBranch(req, body.branch_id);
  const supplierId = body.supplier_id ? requireUuid(body.supplier_id, 'supplier_id') : null;
  const notes = str(body.notes, { field: 'notes', max: 1000 });
  const approve = body.approve === true && isManager(req.user);
  const order = await withTenant(req.tenant.id, async (db) => {
    const rid = req.tenant.id;
    await assertBranchExists(db, rid, branchId);
    if (supplierId) {
      const r = await db.query('SELECT 1 FROM inv_suppliers WHERE id = $1 AND restaurant_id = $2 AND active', [supplierId, rid]);
      if (!r.rowCount) throw badRequest('El proveedor no existe', 'SUPPLIER_NOT_FOUND');
    }
    const items = await parseItems(db, rid, body.items);
    // Folio consecutivo por restaurante (bloqueo por restaurante para no repetir).
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`inv_po:${rid}`]);
    const folio = (await db.query('SELECT coalesce(max(folio), 0) + 1 AS n FROM inv_purchase_orders WHERE restaurant_id = $1', [rid])).rows[0].n;
    const { rows } = await db.query(
      `INSERT INTO inv_purchase_orders (restaurant_id, branch_id, supplier_id, folio, status, notes, created_by, approved_by, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $9 THEN now() END) RETURNING id`,
      [rid, branchId, supplierId, folio, approve ? 'aprobada' : 'solicitada', notes, req.user.id, approve ? req.user.id : null, approve],
    );
    await writeItems(db, rid, rows[0].id, items);
    return getPo(db, req, rows[0].id);
  });
  res.status(201).json({ order });
}));

// Editar mientras no se reciba (admin/gerente, o quien la solicito si sigue solicitada).
router.patch('/purchase-orders/:id', staff, ah(async (req, res) => {
  const body = req.body || {};
  const order = await withTenant(req.tenant.id, async (db) => {
    const rid = req.tenant.id;
    const po = await getPo(db, req, req.params.id, { lock: true });
    if (!['solicitada', 'aprobada'].includes(po.status)) throw badRequest('La orden ya no se puede editar', 'PO_CLOSED');
    if (!isManager(req.user) && po.status !== 'solicitada') throw badRequest('La orden ya fue aprobada', 'PO_CLOSED');
    if (body.supplier_id !== undefined) {
      const sid = body.supplier_id ? requireUuid(body.supplier_id, 'supplier_id') : null;
      if (sid) {
        const r = await db.query('SELECT 1 FROM inv_suppliers WHERE id = $1 AND restaurant_id = $2 AND active', [sid, rid]);
        if (!r.rowCount) throw badRequest('El proveedor no existe', 'SUPPLIER_NOT_FOUND');
      }
      await db.query('UPDATE inv_purchase_orders SET supplier_id = $3 WHERE id = $1 AND restaurant_id = $2', [po.id, rid, sid]);
    }
    if (body.notes !== undefined) {
      await db.query('UPDATE inv_purchase_orders SET notes = $3 WHERE id = $1 AND restaurant_id = $2', [po.id, rid, str(body.notes, { field: 'notes', max: 1000 })]);
    }
    if (body.items !== undefined) await writeItems(db, rid, po.id, await parseItems(db, rid, body.items));
    return getPo(db, req, po.id);
  });
  res.json({ order });
}));

router.post('/purchase-orders/:id/approve', manage, ah(async (req, res) => {
  const order = await withTenant(req.tenant.id, async (db) => {
    const po = await getPo(db, req, req.params.id, { lock: true });
    if (po.status !== 'solicitada') throw badRequest('Solo se aprueban solicitudes pendientes', 'PO_NOT_PENDING');
    await db.query(
      "UPDATE inv_purchase_orders SET status = 'aprobada', approved_by = $3, approved_at = now(), updated_at = now() WHERE id = $1 AND restaurant_id = $2",
      [po.id, req.tenant.id, req.user.id],
    );
    return getPo(db, req, po.id);
  });
  res.json({ order });
}));

router.post('/purchase-orders/:id/cancel', staff, ah(async (req, res) => {
  const reason = str(req.body?.reason, { field: 'reason', required: true, max: 200 });
  const order = await withTenant(req.tenant.id, async (db) => {
    const po = await getPo(db, req, req.params.id, { lock: true });
    if (!['solicitada', 'aprobada'].includes(po.status)) throw badRequest('La orden ya está cerrada', 'PO_CLOSED');
    if (!isManager(req.user) && po.status !== 'solicitada') throw badRequest('La orden ya fue aprobada', 'PO_CLOSED');
    await db.query(
      "UPDATE inv_purchase_orders SET status = 'cancelada', cancelled_reason = $3, updated_at = now() WHERE id = $1 AND restaurant_id = $2",
      [po.id, req.tenant.id, reason],
    );
    return getPo(db, req, po.id);
  });
  res.json({ order });
}));

// Recibir: items = [{ product_id, received_quantity, unit_price }] (en la
// unidad de la orden). Lo que no se mande se toma completo con su precio.
router.post('/purchase-orders/:id/receive', manage, ah(async (req, res) => {
  const body = req.body || {};
  const receipt = imageUrl(body.receipt_url);
  const order = await withTenant(req.tenant.id, async (db) => {
    const rid = req.tenant.id;
    const po = await getPo(db, req, req.params.id, { lock: true });
    if (!['solicitada', 'aprobada'].includes(po.status)) throw badRequest('La orden ya está cerrada', 'PO_CLOSED');
    const given = new Map((Array.isArray(body.items) ? body.items : []).map((i) => [i?.product_id, i]));
    let total = 0;
    for (const it of po.items) {
      const g = given.get(it.product_id) || {};
      const received = g.received_quantity === undefined ? Number(it.quantity) : qty(g.received_quantity, { field: 'received_quantity' });
      const price = g.unit_price === undefined ? Number(it.unit_price) : qty(g.unit_price, { field: 'unit_price' });
      await db.query('UPDATE inv_purchase_order_items SET received_quantity = $2, unit_price = $3 WHERE id = $1', [it.id, received, price]);
      total += received * price;
      if (received > 0) {
        const factor = Number(it.unit_factor);
        const baseCost = price > 0 ? round4(price / factor) : null;
        await applyMovement(db, rid, {
          branchId: po.branch_id, productId: it.product_id, kind: 'compra', quantity: round4(received * factor),
          unitCost: baseCost, reason: `Compra #${po.folio}${po.supplier_name ? ` · ${po.supplier_name}` : ''}`,
          purchaseOrderId: po.id, userId: req.user.id,
        });
        if (price > 0) {
          await db.query('UPDATE inv_products SET unit_cost = $3, updated_at = now() WHERE id = $1 AND restaurant_id = $2', [it.product_id, rid, baseCost]);
          await db.query(
            `INSERT INTO inv_price_history (restaurant_id, product_id, supplier_id, unit_name, unit_factor, unit_price, purchase_order_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [rid, it.product_id, po.supplier_id, it.unit_name, factor, price, po.id],
          );
        }
      }
    }
    await db.query(
      `UPDATE inv_purchase_orders SET status = 'recibida', total = $3, receipt_url = coalesce($4, receipt_url),
              received_by = $5, received_at = now(),
              approved_by = coalesce(approved_by, $5), approved_at = coalesce(approved_at, now()), updated_at = now()
        WHERE id = $1 AND restaurant_id = $2`,
      [po.id, rid, round2(total), receipt ?? null, req.user.id],
    );
    return getPo(db, req, po.id);
  });
  res.json({ order });
}));

// Historial de precios de un insumo.
router.get('/products/:id/prices', staff, ah(async (req, res) => {
  requireUuid(req.params.id);
  const prices = await withTenant(req.tenant.id, async (db) => (await db.query(
    `SELECT h.created_at, h.unit_name, h.unit_factor, h.unit_price, s.name AS supplier_name, o.folio
       FROM inv_price_history h
       LEFT JOIN inv_suppliers s ON s.id = h.supplier_id AND s.restaurant_id = h.restaurant_id
       LEFT JOIN inv_purchase_orders o ON o.id = h.purchase_order_id AND o.restaurant_id = h.restaurant_id
      WHERE h.restaurant_id = $1 AND h.product_id = $2 ORDER BY h.created_at DESC LIMIT 100`,
    [req.tenant.id, req.params.id],
  )).rows);
  res.json({ prices });
}));

export default router;
