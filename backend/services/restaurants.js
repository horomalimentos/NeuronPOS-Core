// Consultas compartidas sobre restaurantes. Reciben un `db` que ya viene de
// withTenant/withPlatform (cliente dentro de la transaccion con contexto RLS).
import bcrypt from 'bcryptjs';
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

/**
 * Alta de un restaurante (Panel o registro en NeuronPOS Delivery): la fila,
 * un registro por modulo del catalogo (habilitados los de moduleCodes),
 * ajustes por defecto, la primera sucursal y, si viene, su administrador.
 * fields: columnas de restaurants ya validadas. Regresa { id, branchId, userId }.
 */
export async function createRestaurant(db, { fields, moduleCodes = [], branchName = 'Matriz', branch = {}, admin = null }) {
  const cols = Object.entries(fields).filter(([, v]) => v !== undefined);
  const { rows } = await db.query(
    `INSERT INTO restaurants (${cols.map(([k]) => k).join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    cols.map(([, v]) => v),
  );
  const rid = rows[0].id;

  // Una fila por modulo del catalogo; habilitados los que se pidieron.
  await db.query(
    `INSERT INTO restaurant_modules (restaurant_id, module_code, enabled, started_at)
     SELECT $1, m.code, m.code = ANY($2::text[]), CASE WHEN m.code = ANY($2::text[]) THEN now() END
       FROM modules m`,
    [rid, moduleCodes],
  );
  await db.query('INSERT INTO delivery_settings (restaurant_id) VALUES ($1)', [rid]);
  // Configuracion del POS y metodos de pago basicos (efectivo, tarjeta, transferencia).
  await db.query('SELECT seed_pos_defaults($1)', [rid]);
  // Fase 4: reglas de nomina y del empleado del mes con sus valores por defecto.
  await db.query('SELECT seed_hr_defaults($1)', [rid]);
  const b = await db.query(
    'INSERT INTO branches (restaurant_id, name, address, phone) VALUES ($1, $2, $3, $4) RETURNING id',
    [rid, branchName, branch.address ?? null, branch.phone ?? null],
  );
  const branchId = b.rows[0].id;
  let userId = null;
  if (admin) {
    const hash = await bcrypt.hash(admin.password, 12);
    const u = await db.query(
      `INSERT INTO users (restaurant_id, email, name, password_hash, role)
       VALUES ($1, $2, $3, $4, 'admin') RETURNING id`,
      [rid, admin.email, admin.name, hash],
    );
    userId = u.rows[0].id;
    await db.query(
      'INSERT INTO user_branches (restaurant_id, user_id, branch_id, is_primary) VALUES ($1, $2, $3, true)',
      [rid, userId, branchId],
    );
  }
  return { id: rid, branchId, userId };
}
