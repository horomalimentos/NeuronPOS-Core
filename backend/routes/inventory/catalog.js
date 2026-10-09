// Catalogos del inventario: areas de conteo, proveedores e insumos (con sus
// unidades alternas). Escritura: admin y gerente. Borrar desactiva.
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { requireRole } from '../../middleware/auth.js';
import { EMAIL_RE, HttpError, ah, badRequest, bool, buildSet, notFound, requireUuid, str } from '../../utils/http.js';
import { insertSql, int } from '../pos/common.js';
import { INV_ROLES, getProduct, loadProducts, qty } from './common.js';

const router = Router();
const manage = requireRole(...INV_ROLES.manage);
const staff = requireRole(...INV_ROLES.staff);

const dupName = (what) => (err) => {
  if (err?.code === '23505') throw new HttpError(409, `Ya existe ${what} con ese nombre`, 'DUPLICATE_NAME');
  throw err;
};

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

router.get('/areas', staff, ah(async (req, res) => {
  const areas = await withTenant(req.tenant.id, async (db) => (await db.query(
    `SELECT a.id, a.name, a.sort_order,
            (SELECT count(*)::int FROM inv_products p WHERE p.area_id = a.id AND p.active) AS products
       FROM inv_areas a WHERE a.restaurant_id = $1 AND a.active ORDER BY a.sort_order, a.name`,
    [req.tenant.id],
  )).rows);
  res.json({ areas });
}));

router.post('/areas', manage, ah(async (req, res) => {
  const body = req.body || {};
  const name = str(body.name, { field: 'name', required: true, max: 80 });
  const sortOrder = int(body.sort_order, { field: 'sort_order', max: 10000 });
  const area = await withTenant(req.tenant.id, async (db) => {
    const q = insertSql('inv_areas', req.tenant.id, { name, sort_order: sortOrder }, 'id, name, sort_order');
    return (await db.query(q.text, q.values)).rows[0];
  }).catch(dupName('un área'));
  res.status(201).json({ area });
}));

router.patch('/areas/:id', manage, ah(async (req, res) => {
  requireUuid(req.params.id);
  const body = req.body || {};
  const set = buildSet({
    name: str(body.name, { field: 'name', max: 80 }) ?? undefined,
    sort_order: int(body.sort_order, { field: 'sort_order', max: 10000 }),
  }, 3);
  if (!set) throw badRequest('Nada que actualizar', 'NOTHING_TO_UPDATE');
  const area = await withTenant(req.tenant.id, async (db) => (await db.query(
    `UPDATE inv_areas SET ${set.sql} WHERE id = $1 AND restaurant_id = $2 AND active RETURNING id, name, sort_order`,
    [req.params.id, req.tenant.id, ...set.values],
  )).rows[0]).catch(dupName('un área'));
  if (!area) throw notFound('Área no encontrada', 'AREA_NOT_FOUND');
  res.json({ area });
}));

// Desactiva el area; sus insumos quedan sin area.
router.delete('/areas/:id', manage, ah(async (req, res) => {
  requireUuid(req.params.id);
  const ok = await withTenant(req.tenant.id, async (db) => {
    const r = await db.query('UPDATE inv_areas SET active = false WHERE id = $1 AND restaurant_id = $2 AND active', [req.params.id, req.tenant.id]);
    if (r.rowCount) await db.query('UPDATE inv_products SET area_id = NULL WHERE area_id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]);
    return r.rowCount;
  });
  if (!ok) throw notFound('Área no encontrada', 'AREA_NOT_FOUND');
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Proveedores
// ---------------------------------------------------------------------------

const SUPPLIER_COLS = 'id, name, contact_name, phone, email, notes, active';

function supplierFields(body, creating) {
  const email = str(body.email, { field: 'email', max: 200 });
  if (email && !EMAIL_RE.test(email)) throw badRequest('Correo invalido', 'INVALID_FIELD');
  return {
    name: str(body.name, { field: 'name', required: creating, max: 120 }) ?? undefined,
    contact_name: str(body.contact_name, { field: 'contact_name', max: 120 }),
    phone: str(body.phone, { field: 'phone', max: 40 }),
    email,
    notes: str(body.notes, { field: 'notes', max: 1000 }),
  };
}

router.get('/suppliers', staff, ah(async (req, res) => {
  const suppliers = await withTenant(req.tenant.id, async (db) => (await db.query(
    `SELECT ${SUPPLIER_COLS.split(', ').map((c) => `s.${c}`).join(', ')},
            (SELECT count(*)::int FROM inv_products p WHERE p.supplier_id = s.id AND p.active) AS products
       FROM inv_suppliers s WHERE s.restaurant_id = $1 AND s.active ORDER BY s.name`,
    [req.tenant.id],
  )).rows);
  res.json({ suppliers });
}));

router.post('/suppliers', manage, ah(async (req, res) => {
  const f = supplierFields(req.body || {}, true);
  const supplier = await withTenant(req.tenant.id, async (db) => {
    const q = insertSql('inv_suppliers', req.tenant.id, f, SUPPLIER_COLS);
    return (await db.query(q.text, q.values)).rows[0];
  }).catch(dupName('un proveedor'));
  res.status(201).json({ supplier });
}));

router.patch('/suppliers/:id', manage, ah(async (req, res) => {
  requireUuid(req.params.id);
  const set = buildSet(supplierFields(req.body || {}, false), 3);
  if (!set) throw badRequest('Nada que actualizar', 'NOTHING_TO_UPDATE');
  const supplier = await withTenant(req.tenant.id, async (db) => (await db.query(
    `UPDATE inv_suppliers SET ${set.sql}, updated_at = now() WHERE id = $1 AND restaurant_id = $2 AND active RETURNING ${SUPPLIER_COLS}`,
    [req.params.id, req.tenant.id, ...set.values],
  )).rows[0]).catch(dupName('un proveedor'));
  if (!supplier) throw notFound('Proveedor no encontrado', 'SUPPLIER_NOT_FOUND');
  res.json({ supplier });
}));

router.delete('/suppliers/:id', manage, ah(async (req, res) => {
  requireUuid(req.params.id);
  const ok = await withTenant(req.tenant.id, async (db) => {
    const r = await db.query('UPDATE inv_suppliers SET active = false, updated_at = now() WHERE id = $1 AND restaurant_id = $2 AND active', [req.params.id, req.tenant.id]);
    if (r.rowCount) await db.query('UPDATE inv_products SET supplier_id = NULL WHERE supplier_id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]);
    return r.rowCount;
  });
  if (!ok) throw notFound('Proveedor no encontrado', 'SUPPLIER_NOT_FOUND');
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Insumos
// ---------------------------------------------------------------------------

function countDays(value) {
  if (value === undefined) return undefined;
  if (value === null || (Array.isArray(value) && (value.length === 0 || value.length === 7))) return null;
  if (!Array.isArray(value) || value.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    throw badRequest('count_days debe ser una lista de dias 1 (lunes) a 7 (domingo)', 'INVALID_FIELD');
  }
  return [...new Set(value)].sort();
}

function units(value, baseUnit) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10) throw badRequest('units debe ser una lista (maximo 10)', 'INVALID_FIELD');
  const seen = new Set([String(baseUnit).toLowerCase()]);
  const out = value.map((u) => {
    const name = str(u?.name, { field: 'units.name', required: true, max: 40 });
    if (seen.has(name.toLowerCase())) throw badRequest(`La unidad "${name}" esta repetida`, 'INVALID_FIELD');
    seen.add(name.toLowerCase());
    return { name, factor: qty(u.factor, { field: 'units.factor', positive: true }), is_purchase: Boolean(u.is_purchase) };
  });
  if (out.filter((u) => u.is_purchase).length > 1) throw badRequest('Solo una unidad puede ser la de compra', 'INVALID_FIELD');
  return out;
}

async function validRefs(db, rid, { area_id: areaId, supplier_id: supplierId }) {
  if (areaId) {
    requireUuid(areaId, 'area_id');
    const r = await db.query('SELECT 1 FROM inv_areas WHERE id = $1 AND restaurant_id = $2 AND active', [areaId, rid]);
    if (!r.rowCount) throw badRequest('El área no existe', 'AREA_NOT_FOUND');
  }
  if (supplierId) {
    requireUuid(supplierId, 'supplier_id');
    const r = await db.query('SELECT 1 FROM inv_suppliers WHERE id = $1 AND restaurant_id = $2 AND active', [supplierId, rid]);
    if (!r.rowCount) throw badRequest('El proveedor no existe', 'SUPPLIER_NOT_FOUND');
  }
}

function productFields(body, creating) {
  return {
    name: str(body.name, { field: 'name', required: creating, max: 120 }) ?? undefined,
    category: str(body.category, { field: 'category', max: 60 }),
    base_unit: str(body.base_unit, { field: 'base_unit', required: creating, max: 40 }) ?? undefined,
    area_id: body.area_id === undefined ? undefined : body.area_id || null,
    supplier_id: body.supplier_id === undefined ? undefined : body.supplier_id || null,
    unit_cost: qty(body.unit_cost, { field: 'unit_cost' }),
    min_stock: qty(body.min_stock, { field: 'min_stock' }),
    daily_use: qty(body.daily_use, { field: 'daily_use' }),
    count_days: countDays(body.count_days),
    requires_photo: bool(body.requires_photo, 'requires_photo'),
    sort_order: int(body.sort_order, { field: 'sort_order', max: 100000 }),
    active: bool(body.active, 'active'),
  };
}

async function saveUnits(db, rid, productId, list) {
  await db.query('DELETE FROM inv_product_units WHERE restaurant_id = $1 AND product_id = $2', [rid, productId]);
  for (const u of list) {
    await db.query(
      'INSERT INTO inv_product_units (restaurant_id, product_id, name, factor, is_purchase) VALUES ($1, $2, $3, $4, $5)',
      [rid, productId, u.name, u.factor, u.is_purchase],
    );
  }
}

router.get('/products', staff, ah(async (req, res) => {
  const includeInactive = req.query.all === '1' && INV_ROLES.manage.includes(req.user.role);
  const products = await withTenant(req.tenant.id, (db) => loadProducts(db, req.tenant.id, { includeInactive }));
  res.json({ products });
}));

router.post('/products', manage, ah(async (req, res) => {
  const body = req.body || {};
  const f = productFields(body, true);
  const unitList = units(body.units, f.base_unit) || [];
  const product = await withTenant(req.tenant.id, async (db) => {
    await validRefs(db, req.tenant.id, f);
    const q = insertSql('inv_products', req.tenant.id, f, 'id');
    const { id } = (await db.query(q.text, q.values)).rows[0];
    await saveUnits(db, req.tenant.id, id, unitList);
    return getProduct(db, req.tenant.id, id);
  }).catch(dupName('un insumo'));
  res.status(201).json({ product });
}));

router.patch('/products/:id', manage, ah(async (req, res) => {
  requireUuid(req.params.id);
  const body = req.body || {};
  const f = productFields(body, false);
  const product = await withTenant(req.tenant.id, async (db) => {
    const cur = await getProduct(db, req.tenant.id, req.params.id);
    await validRefs(db, req.tenant.id, f);
    const set = buildSet(f, 3);
    if (set) {
      await db.query(`UPDATE inv_products SET ${set.sql}, updated_at = now() WHERE id = $1 AND restaurant_id = $2`,
        [req.params.id, req.tenant.id, ...set.values]);
    }
    const unitList = units(body.units, f.base_unit || cur.base_unit);
    if (unitList) await saveUnits(db, req.tenant.id, req.params.id, unitList);
    if (!set && !unitList) throw badRequest('Nada que actualizar', 'NOTHING_TO_UPDATE');
    return getProduct(db, req.tenant.id, req.params.id);
  }).catch(dupName('un insumo'));
  res.json({ product });
}));

// Desactiva (el historial y las recetas se conservan, pero ya no se cuenta).
router.delete('/products/:id', manage, ah(async (req, res) => {
  requireUuid(req.params.id);
  const ok = await withTenant(req.tenant.id, async (db) => (await db.query(
    'UPDATE inv_products SET active = false, updated_at = now() WHERE id = $1 AND restaurant_id = $2 AND active',
    [req.params.id, req.tenant.id],
  )).rowCount);
  if (!ok) throw notFound('Insumo no encontrado', 'PRODUCT_NOT_FOUND');
  res.json({ ok: true });
}));

// Importar varios insumos de una vez (pegados de Excel en el frontend).
router.post('/products/import', manage, ah(async (req, res) => {
  const rows = req.body?.products;
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000) {
    throw badRequest('Manda entre 1 y 1000 insumos', 'INVALID_FIELD');
  }
  const result = await withTenant(req.tenant.id, async (db) => {
    const areas = new Map((await db.query('SELECT id, lower(name) AS n FROM inv_areas WHERE restaurant_id = $1 AND active', [req.tenant.id])).rows.map((a) => [a.n, a.id]));
    const sups = new Map((await db.query('SELECT id, lower(name) AS n FROM inv_suppliers WHERE restaurant_id = $1 AND active', [req.tenant.id])).rows.map((a) => [a.n, a.id]));
    let created = 0;
    let updated = 0;
    for (const [i, r] of rows.entries()) {
      const at = `Renglón ${i + 1}: `;
      let f;
      try {
        f = productFields({ ...r, area_id: undefined, supplier_id: undefined }, true);
      } catch (err) { throw badRequest(at + err.message, err.code); }
      // Areas y proveedores por nombre: se crean si no existen.
      const areaName = str(r.area, { field: 'area', max: 80 });
      if (areaName) {
        if (!areas.has(areaName.toLowerCase())) {
          areas.set(areaName.toLowerCase(), (await db.query('INSERT INTO inv_areas (restaurant_id, name) VALUES ($1, $2) RETURNING id', [req.tenant.id, areaName])).rows[0].id);
        }
        f.area_id = areas.get(areaName.toLowerCase());
      }
      const supName = str(r.supplier, { field: 'supplier', max: 120 });
      if (supName) {
        if (!sups.has(supName.toLowerCase())) {
          sups.set(supName.toLowerCase(), (await db.query('INSERT INTO inv_suppliers (restaurant_id, name) VALUES ($1, $2) RETURNING id', [req.tenant.id, supName])).rows[0].id);
        }
        f.supplier_id = sups.get(supName.toLowerCase());
      }
      const existing = (await db.query('SELECT id FROM inv_products WHERE restaurant_id = $1 AND active AND lower(name) = lower($2)', [req.tenant.id, f.name])).rows[0];
      if (existing) {
        const set = buildSet({ ...f, name: undefined }, 3);
        await db.query(`UPDATE inv_products SET ${set.sql}, updated_at = now() WHERE id = $1 AND restaurant_id = $2`, [existing.id, req.tenant.id, ...set.values]);
        updated += 1;
      } else {
        const q = insertSql('inv_products', req.tenant.id, f, 'id');
        await db.query(q.text, q.values);
        created += 1;
      }
    }
    return { created, updated };
  });
  res.json(result);
}));

export default router;
