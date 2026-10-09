// Conteos fisicos (como el inventario diario de Horom): por sucursal, area y
// fecha; se capturan insumo por insumo, se pueden pausar y retomar, y al
// completarlos la existencia queda en lo contado (la diferencia va al kardex).
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { requireRole } from '../../middleware/auth.js';
import { applyMovement, toBase } from '../../services/inventory.js';
import { HttpError, ah, badRequest, notFound, oneOf, requireUuid, str } from '../../utils/http.js';
import { assertBranchExists, canAccessBranch, imageUrl, int, requireBranch } from '../pos/common.js';
import { INV_ROLES, isoDate, loadProducts, qty } from './common.js';

const router = Router();
const staff = requireRole(...INV_ROLES.staff);

const COUNT_SELECT = `
  SELECT c.id, c.branch_id, b.name AS branch_name, c.area_id, a.name AS area_name,
         to_char(c.count_date, 'YYYY-MM-DD') AS count_date, c.status, c.notes,
         c.created_by, uc.name AS created_by_name, c.created_at, c.completed_at, ud.name AS completed_by_name,
         (SELECT count(*)::int FROM inv_count_items i WHERE i.count_id = c.id) AS counted_items
    FROM inv_counts c
    JOIN branches b ON b.id = c.branch_id AND b.restaurant_id = c.restaurant_id
    LEFT JOIN inv_areas a ON a.id = c.area_id AND a.restaurant_id = c.restaurant_id
    LEFT JOIN users uc ON uc.id = c.created_by AND uc.restaurant_id = c.restaurant_id
    LEFT JOIN users ud ON ud.id = c.completed_by AND ud.restaurant_id = c.restaurant_id`;

async function getCount(db, req, id, { lock = false } = {}) {
  requireUuid(id);
  if (lock) await db.query('SELECT 1 FROM inv_counts WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [id, req.tenant.id]);
  const c = (await db.query(`${COUNT_SELECT} WHERE c.id = $1 AND c.restaurant_id = $2`, [id, req.tenant.id])).rows[0];
  if (!c || !canAccessBranch(req.user, c.branch_id)) throw notFound('Conteo no encontrado', 'COUNT_NOT_FOUND');
  return c;
}

/** ISO 1 (lunes) .. 7 (domingo) de una fecha AAAA-MM-DD. */
const isoWeekday = (date) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

/** Conteo con los insumos que tocan (area y dia) y lo capturado. */
async function countDetail(db, req, id, { all = false } = {}) {
  const count = await getCount(db, req, id);
  const weekday = isoWeekday(count.count_date);
  const items = new Map((await db.query(
    `SELECT i.product_id, i.entered_quantity, i.entered_unit, i.quantity, i.expected, i.photo_url, i.counted_at, u.name AS counted_by_name
       FROM inv_count_items i LEFT JOIN users u ON u.id = i.counted_by AND u.restaurant_id = i.restaurant_id
      WHERE i.restaurant_id = $1 AND i.count_id = $2`,
    [req.tenant.id, id],
  )).rows.map((i) => [i.product_id, i]));
  const stock = new Map((await db.query(
    'SELECT product_id, quantity FROM inv_stock WHERE restaurant_id = $1 AND branch_id = $2',
    [req.tenant.id, count.branch_id],
  )).rows.map((s) => [s.product_id, Number(s.quantity)]));
  const products = (await loadProducts(db, req.tenant.id))
    .filter((p) => !count.area_id || p.area_id === count.area_id)
    .map((p) => ({
      ...p,
      scheduled: !p.count_days || p.count_days.includes(weekday),
      system_quantity: stock.get(p.id) ?? 0,
      item: items.get(p.id) || null,
    }))
    .filter((p) => all || p.scheduled || p.item);
  return { count, products };
}

router.get('/counts', staff, ah(async (req, res) => {
  const branchId = requireBranch(req, req.query.branch_id);
  const status = oneOf(req.query.status || undefined, ['abiertos', 'completado', 'cancelado'], 'status');
  const limit = int(req.query.limit ?? 50, { field: 'limit', min: 1, max: 200 });
  const counts = await withTenant(req.tenant.id, async (db) => (await db.query(
    `${COUNT_SELECT}
      WHERE c.restaurant_id = $1 AND c.branch_id = $2
        AND ($3::text IS NULL OR ($3 = 'abiertos' AND c.status IN ('en_progreso', 'pausado')) OR c.status = $3)
      ORDER BY c.count_date DESC, c.created_at DESC LIMIT $4`,
    [req.tenant.id, branchId, status || null, limit],
  )).rows);
  res.json({ counts });
}));

router.post('/counts', staff, ah(async (req, res) => {
  const body = req.body || {};
  const branchId = requireBranch(req, body.branch_id);
  const areaId = body.area_id ? requireUuid(body.area_id, 'area_id') : null;
  const notes = str(body.notes, { field: 'notes', max: 500 });
  try {
    const data = await withTenant(req.tenant.id, async (db) => {
      await assertBranchExists(db, req.tenant.id, branchId);
      if (areaId) {
        const r = await db.query('SELECT 1 FROM inv_areas WHERE id = $1 AND restaurant_id = $2 AND active', [areaId, req.tenant.id]);
        if (!r.rowCount) throw badRequest('El área no existe', 'AREA_NOT_FOUND');
      }
      const tz = (await db.query('SELECT timezone FROM branches WHERE id = $1 AND restaurant_id = $2', [branchId, req.tenant.id])).rows[0].timezone;
      const date = isoDate(body.count_date, 'count_date')
        || (await db.query('SELECT to_char((now() AT TIME ZONE $1)::date, \'YYYY-MM-DD\') AS d', [tz])).rows[0].d;
      const { rows } = await db.query(
        `INSERT INTO inv_counts (restaurant_id, branch_id, area_id, count_date, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [req.tenant.id, branchId, areaId, date, notes, req.user.id],
      );
      return countDetail(db, req, rows[0].id);
    });
    res.status(201).json(data);
  } catch (err) {
    if (err?.code === '23505' && err.constraint === 'inv_counts_one_open') {
      throw new HttpError(409, 'Ya hay un conteo abierto de esa área para ese día: continúalo', 'COUNT_ALREADY_OPEN');
    }
    throw err;
  }
}));

router.get('/counts/:id', staff, ah(async (req, res) => {
  const data = await withTenant(req.tenant.id, (db) => countDetail(db, req, req.params.id, { all: req.query.all === '1' }));
  res.json(data);
}));

const assertOpen = (c) => {
  if (!['en_progreso', 'pausado'].includes(c.status)) throw badRequest('El conteo ya se cerró', 'COUNT_CLOSED');
};

// Captura (o corrige) lo contado de un insumo. quantity en la unidad "unit".
router.put('/counts/:id/items/:productId', staff, ah(async (req, res) => {
  requireUuid(req.params.productId, 'product_id');
  const body = req.body || {};
  const entered = qty(body.quantity, { field: 'quantity' });
  if (entered === undefined) throw badRequest('Indica la cantidad contada', 'MISSING_FIELD');
  const photo = imageUrl(body.photo_url);
  const item = await withTenant(req.tenant.id, async (db) => {
    const c = await getCount(db, req, req.params.id, { lock: true });
    assertOpen(c);
    const base = await toBase(db, req.tenant.id, req.params.productId, entered, body.unit);
    const { rows } = await db.query(
      `INSERT INTO inv_count_items (restaurant_id, count_id, product_id, entered_quantity, entered_unit, quantity, photo_url, counted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (count_id, product_id) DO UPDATE
         SET entered_quantity = $4, entered_unit = $5, quantity = $6,
             photo_url = coalesce($7, inv_count_items.photo_url), counted_by = $8, counted_at = now()
       RETURNING product_id, entered_quantity, entered_unit, quantity, photo_url, counted_at`,
      [req.tenant.id, c.id, req.params.productId, entered, base.unit, base.quantity, photo ?? null, req.user.id],
    );
    if (c.status === 'pausado') await db.query("UPDATE inv_counts SET status = 'en_progreso' WHERE id = $1", [c.id]);
    return rows[0];
  });
  res.json({ item });
}));

router.delete('/counts/:id/items/:productId', staff, ah(async (req, res) => {
  requireUuid(req.params.productId, 'product_id');
  await withTenant(req.tenant.id, async (db) => {
    const c = await getCount(db, req, req.params.id, { lock: true });
    assertOpen(c);
    await db.query('DELETE FROM inv_count_items WHERE restaurant_id = $1 AND count_id = $2 AND product_id = $3', [req.tenant.id, c.id, req.params.productId]);
  });
  res.json({ ok: true });
}));

router.post('/counts/:id/pause', staff, ah(async (req, res) => {
  const count = await withTenant(req.tenant.id, async (db) => {
    const c = await getCount(db, req, req.params.id, { lock: true });
    assertOpen(c);
    await db.query("UPDATE inv_counts SET status = 'pausado' WHERE id = $1", [c.id]);
    return getCount(db, req, c.id);
  });
  res.json({ count });
}));

router.post('/counts/:id/cancel', staff, ah(async (req, res) => {
  const count = await withTenant(req.tenant.id, async (db) => {
    const c = await getCount(db, req, req.params.id, { lock: true });
    assertOpen(c);
    await db.query("UPDATE inv_counts SET status = 'cancelado' WHERE id = $1", [c.id]);
    return getCount(db, req, c.id);
  });
  res.json({ count });
}));

// Completa: lo contado pasa a ser la existencia. Los insumos con foto
// obligatoria no se pueden cerrar sin foto.
router.post('/counts/:id/complete', staff, ah(async (req, res) => {
  const data = await withTenant(req.tenant.id, async (db) => {
    const c = await getCount(db, req, req.params.id, { lock: true });
    assertOpen(c);
    const items = (await db.query(
      `SELECT i.product_id, i.quantity, i.photo_url, p.name, p.requires_photo, p.unit_cost
         FROM inv_count_items i JOIN inv_products p ON p.id = i.product_id AND p.restaurant_id = i.restaurant_id
        WHERE i.restaurant_id = $1 AND i.count_id = $2`,
      [req.tenant.id, c.id],
    )).rows;
    if (!items.length) throw badRequest('Captura al menos un insumo antes de terminar', 'EMPTY_COUNT');
    const noPhoto = items.filter((i) => i.requires_photo && !i.photo_url).map((i) => i.name);
    if (noPhoto.length) throw badRequest(`Falta la foto de: ${noPhoto.join(', ')}`, 'PHOTO_REQUIRED');
    for (const i of items) {
      const before = (await db.query(
        'SELECT quantity FROM inv_stock WHERE branch_id = $1 AND product_id = $2', [c.branch_id, i.product_id],
      )).rows[0];
      await db.query('UPDATE inv_count_items SET expected = $3 WHERE count_id = $1 AND product_id = $2',
        [c.id, i.product_id, before ? before.quantity : 0]);
      await applyMovement(db, req.tenant.id, {
        branchId: c.branch_id, productId: i.product_id, kind: 'conteo', quantity: 0, setTo: Number(i.quantity),
        unitCost: i.unit_cost, reason: `Conteo ${c.count_date}${c.area_name ? ` · ${c.area_name}` : ''}`, countId: c.id, userId: req.user.id,
      });
    }
    await db.query(
      "UPDATE inv_counts SET status = 'completado', completed_by = $2, completed_at = now() WHERE id = $1",
      [c.id, req.user.id],
    );
    return countDetail(db, req, c.id);
  });
  res.json(data);
}));

export default router;
