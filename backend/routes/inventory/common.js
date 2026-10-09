// Utilidades del modulo de inventario: roles, validaciones de cantidades y
// carga de insumos con sus unidades.
import { badRequest, notFound, requireUuid } from '../../utils/http.js';

export const INV_ROLES = {
  // Catalogos (insumos, areas, proveedores, recetas), aprobar y recibir compras.
  manage: ['admin', 'gerente'],
  // Ver existencias, contar, registrar mermas y solicitar compras.
  staff: ['admin', 'gerente', 'cajero', 'cocina'],
};

/** Cantidad >= 0 (o > 0 con positive) con hasta 4 decimales. */
export function qty(value, { field, positive = false, signed = false, nullable = false } = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === '') {
    if (nullable) return null;
    throw badRequest(`El campo "${field}" es obligatorio`, 'MISSING_FIELD');
  }
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > 1e9 || (!signed && n < 0) || (positive && n <= 0)) {
    throw badRequest(`El campo "${field}" debe ser una cantidad valida${positive ? ' mayor a cero' : ''}`, 'INVALID_FIELD');
  }
  return Math.round(n * 10000) / 10000;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isoDate(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  const s = String(value);
  if (!DATE_RE.test(s) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) {
    throw badRequest(`El campo "${field}" debe ser una fecha AAAA-MM-DD`, 'INVALID_FIELD');
  }
  return s;
}

export const PRODUCT_COLS = `p.id, p.name, p.category, p.base_unit, p.area_id, p.supplier_id, p.unit_cost, p.min_stock,
  p.daily_use, p.count_days, p.requires_photo, p.sort_order, p.active`;

/** Insumos con sus unidades alternas (y nombre de area y proveedor). */
export async function loadProducts(db, restaurantId, { ids = null, includeInactive = false } = {}) {
  const params = [restaurantId];
  let where = 'p.restaurant_id = $1';
  if (!includeInactive) where += ' AND p.active';
  if (ids) { params.push(ids); where += ` AND p.id = ANY($${params.length}::uuid[])`; }
  const products = (await db.query(
    `SELECT ${PRODUCT_COLS}, a.name AS area_name, s.name AS supplier_name
       FROM inv_products p
       LEFT JOIN inv_areas a ON a.id = p.area_id AND a.restaurant_id = p.restaurant_id
       LEFT JOIN inv_suppliers s ON s.id = p.supplier_id AND s.restaurant_id = p.restaurant_id
      WHERE ${where}
      ORDER BY a.sort_order NULLS LAST, p.sort_order, p.name`,
    params,
  )).rows;
  const units = (await db.query(
    'SELECT id, product_id, name, factor, is_purchase FROM inv_product_units WHERE restaurant_id = $1 ORDER BY factor',
    [restaurantId],
  )).rows;
  for (const p of products) p.units = units.filter((u) => u.product_id === p.id).map(({ product_id: _, ...u }) => u);
  return products;
}

export async function getProduct(db, restaurantId, id) {
  requireUuid(id);
  const [p] = await loadProducts(db, restaurantId, { ids: [id], includeInactive: true });
  if (!p) throw notFound('Insumo no encontrado', 'PRODUCT_NOT_FOUND');
  return p;
}

/** Unidad de compra de un insumo (la marcada, o la base). */
export function purchaseUnit(p) {
  const u = p.units.find((x) => x.is_purchase);
  return u ? { name: u.name, factor: Number(u.factor) } : { name: p.base_unit, factor: 1 };
}

export async function loadSettings(db, rid) {
  const { rows } = await db.query('SELECT deduct_on_sale, order_cover_days FROM inv_settings WHERE restaurant_id = $1', [rid]);
  return rows[0] || { deduct_on_sale: true, order_cover_days: 3 };
}
