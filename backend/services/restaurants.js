// Consultas compartidas sobre restaurantes. Reciben un `db` que ya viene de
// withTenant/withPlatform (cliente dentro de la transaccion con contexto RLS).
import { calculateMonthlyTotal, isModuleActive } from './billing.js';

/** Todo el catalogo con el estado de cada modulo para un restaurante. */
export async function listRestaurantModules(db, restaurantId) {
  const { rows } = await db.query(
    `SELECT m.code AS module_code, m.name, m.description, m.monthly_price_mxn,
            m.active AS catalog_active, m.sort_order,
            coalesce(rm.enabled, false) AS enabled, rm.custom_price_mxn,
            coalesce(rm.discount_pct, 0) AS discount_pct, rm.started_at, rm.ends_at
       FROM modules m
       LEFT JOIN restaurant_modules rm
         ON rm.module_code = m.code AND rm.restaurant_id = $1
      ORDER BY m.sort_order, m.code`,
    [restaurantId],
  );
  const now = new Date();
  return rows.map((r) => ({ ...r, is_active: isModuleActive(r, now) }));
}

/** Mapa restaurant_id -> { total_mxn, lines } para varios restaurantes. */
export async function monthlyTotalsByRestaurant(db, restaurantIds) {
  if (restaurantIds.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT rm.restaurant_id, rm.module_code, m.name, m.monthly_price_mxn,
            rm.custom_price_mxn, rm.discount_pct, rm.enabled, rm.started_at, rm.ends_at
       FROM restaurant_modules rm
       JOIN modules m ON m.code = rm.module_code
      WHERE rm.restaurant_id = ANY($1::uuid[]) AND rm.enabled`,
    [restaurantIds],
  );
  const grouped = new Map(restaurantIds.map((id) => [id, []]));
  for (const r of rows) grouped.get(r.restaurant_id)?.push(r);
  const now = new Date();
  return new Map([...grouped].map(([id, list]) => [id, calculateMonthlyTotal(list, now)]));
}

export async function getDeliverySettings(db, restaurantId) {
  const { rows } = await db.query(
    `SELECT mode, horom_enabled, horom_fee_type, horom_fee_value, updated_at
       FROM delivery_settings WHERE restaurant_id = $1`,
    [restaurantId],
  );
  return rows[0] || { mode: 'propio', horom_enabled: false, horom_fee_type: 'fixed', horom_fee_value: '0.00', updated_at: null };
}
