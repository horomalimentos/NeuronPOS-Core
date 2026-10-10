// API del dueno de la plataforma (Panel NeuronPOS). Todo corre con
// withPlatform, que habilita ver/editar cualquier restaurante bajo RLS.
import { Router } from 'express';
import { withPlatform } from '../config/database.js';
import { authenticatePlatform } from '../middleware/auth.js';
import { RESTAURANT_COLUMNS } from '../middleware/tenant.js';
import { calculateMonthlyTotal } from '../services/billing.js';
import {
  createRestaurant, getDeliverySettings, listRestaurantModules, monthlyTotalsByRestaurant,
} from '../services/restaurants.js';
import { addDays, getPlatformSettings, listInvoices, today } from '../services/subscriptions.js';
import platformBillingRouter from './platformBilling.js';
import platformFleetRouter from './platformFleet.js';
import platformMarketplaceRouter from './platformMarketplace.js';
import {
  COLOR_RE, DOMAIN_RE, EMAIL_RE, SLUG_RE, ah, badRequest, bool, buildSet, dateOrNull,
  money, notFound, oneOf, requireUuid, str,
} from '../utils/http.js';

const router = Router();
router.use(authenticatePlatform);

const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS, 10) || 14;
const DETAIL_COLUMNS = `${RESTAURANT_COLUMNS}, contact_name, contact_email, contact_phone, notes, dunning_grace_until,
  created_at, updated_at`;

/** Dia de cobro 1-31 (NULL = el dia en que se activo). */
function billingDay(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 31) throw badRequest('El dia de cobro debe ser de 1 a 31', 'INVALID_FIELD');
  return n;
}

/** Al cambiar el estado a mano: motivo de suspension y fecha de alta. */
function statusSideEffects(status) {
  if (status === 'suspended') return { suspended_reason: 'manual' };
  if (status === 'active' || status === 'trial') return { suspended_reason: null };
  return {};
}

function restaurantFields(body, { creating }) {
  const f = {
    slug: str(body.slug, { field: 'slug', required: creating, max: 63 })?.toLowerCase(),
    name: str(body.name, { field: 'name', required: creating, max: 120 }),
    custom_domain: str(body.custom_domain, { field: 'custom_domain', max: 253 })?.toLowerCase(),
    logo_url: str(body.logo_url, { field: 'logo_url', max: 1000 }),
    primary_color: str(body.primary_color, { field: 'primary_color', max: 7 }),
    secondary_color: str(body.secondary_color, { field: 'secondary_color', max: 7 }),
    status: oneOf(body.status, ['active', 'suspended', 'trial'], 'status'),
    trial_ends_at: dateOrNull(body.trial_ends_at, 'trial_ends_at'),
    contact_name: str(body.contact_name, { field: 'contact_name', max: 120 }),
    contact_email: str(body.contact_email, { field: 'contact_email', max: 200 }),
    contact_phone: str(body.contact_phone, { field: 'contact_phone', max: 40 }),
    notes: str(body.notes, { field: 'notes', max: 2000 }),
    billing_day: billingDay(body.billing_day),
  };
  if (f.slug && !SLUG_RE.test(f.slug)) {
    throw badRequest('El slug solo puede tener minusculas, numeros y guiones', 'INVALID_SLUG');
  }
  if (f.custom_domain && !DOMAIN_RE.test(f.custom_domain)) throw badRequest('Dominio invalido', 'INVALID_DOMAIN');
  for (const k of ['primary_color', 'secondary_color']) {
    if (f[k] && !COLOR_RE.test(f[k])) throw badRequest(`Color invalido en "${k}" (usa #RRGGBB)`, 'INVALID_COLOR');
    if (f[k] === null) f[k] = undefined; // no se puede borrar un color: se queda el actual
  }
  if (f.logo_url && !/^https?:\/\//i.test(f.logo_url)) throw badRequest('El logo debe ser una URL http(s)', 'INVALID_URL');
  return f;
}

async function getRestaurantDetail(db, id) {
  const { rows } = await db.query(`SELECT ${DETAIL_COLUMNS} FROM restaurants WHERE id = $1`, [id]);
  const restaurant = rows[0];
  if (!restaurant) throw notFound('Restaurante no encontrado', 'RESTAURANT_NOT_FOUND');
  const modules = await listRestaurantModules(db, id);
  const charge = calculateMonthlyTotal(modules);
  const delivery = await getDeliverySettings(db, id);
  const counts = await db.query(
    `SELECT (SELECT count(*) FROM branches WHERE restaurant_id = $1)::int AS branches,
            (SELECT count(*) FROM users WHERE restaurant_id = $1)::int AS users`,
    [id],
  );
  const invoices = await listInvoices(db, { restaurantId: id, limit: 24 });
  return { restaurant, modules, delivery, monthly: charge, counts: counts.rows[0], invoices };
}

router.get('/me', (req, res) => res.json({ admin: req.platformAdmin }));

// ---------------------------------------------------------------------------
// Catalogo de modulos
// ---------------------------------------------------------------------------

router.get('/modules', ah(async (req, res) => {
  const rows = await withPlatform(async (db) => (await db.query(
    `SELECT m.*,
            (SELECT count(*) FROM restaurant_modules rm WHERE rm.module_code = m.code AND rm.enabled)::int
              AS enabled_restaurants
       FROM modules m ORDER BY sort_order, code`,
  )).rows);
  res.json({ modules: rows });
}));

router.put('/modules/:code', ah(async (req, res) => {
  const body = req.body || {};
  const set = buildSet({
    name: str(body.name, { field: 'name', max: 120 }) ?? undefined,
    description: str(body.description, { field: 'description', max: 1000, allowEmpty: true }) ?? undefined,
    monthly_price_mxn: money(body.monthly_price_mxn, { field: 'monthly_price_mxn' }),
    active: bool(body.active, 'active'),
    sort_order: body.sort_order === undefined ? undefined : Number.parseInt(body.sort_order, 10) || 0,
  });
  if (!set) throw badRequest('No hay cambios', 'NO_CHANGES');
  const row = await withPlatform(async (db) => (await db.query(
    `UPDATE modules SET ${set.sql}, updated_at = now() WHERE code = $${set.values.length + 1} RETURNING *`,
    [...set.values, req.params.code],
  )).rows[0]);
  if (!row) throw notFound('Modulo no encontrado', 'MODULE_NOT_FOUND');
  res.json({ module: row });
}));

// ---------------------------------------------------------------------------
// Restaurantes
// ---------------------------------------------------------------------------

router.get('/restaurants', ah(async (req, res) => {
  const result = await withPlatform(async (db) => {
    const { rows } = await db.query(
      `SELECT ${DETAIL_COLUMNS},
              (SELECT count(*) FROM branches b WHERE b.restaurant_id = r.id)::int AS branch_count,
              (SELECT count(*) FROM subscription_invoices i
                WHERE i.restaurant_id = r.id AND i.status IN ('pending', 'overdue'))::int AS unpaid_invoices,
              EXISTS (SELECT 1 FROM subscription_invoices i
                       WHERE i.restaurant_id = r.id AND i.status = 'overdue') AS has_overdue
         FROM restaurants r ORDER BY r.name`,
    );
    const totals = await monthlyTotalsByRestaurant(db, rows.map((r) => r.id));
    return rows.map((r) => {
      const t = totals.get(r.id);
      return { ...r, monthly_total_mxn: t.total_mxn, enabled_modules: t.lines.map((l) => l.module_code) };
    });
  });
  const grand = Math.round(result.reduce((s, r) => s + (r.status === 'suspended' ? 0 : r.monthly_total_mxn * 100), 0)) / 100;
  res.json({ restaurants: result, monthly_grand_total_mxn: grand });
}));

router.post('/restaurants', ah(async (req, res) => {
  const body = req.body || {};
  const f = restaurantFields(body, { creating: true });
  if (!f.status) f.status = 'trial';
  if (f.status === 'trial' && !f.trial_ends_at) {
    f.trial_ends_at = new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString();
  }
  if (f.status === 'active') f.activated_at = new Date().toISOString();
  Object.assign(f, f.status === 'suspended' ? { suspended_reason: 'manual' } : {});
  const moduleCodes = Array.isArray(body.modules) ? body.modules.map(String) : [];

  let admin = null;
  if (body.admin) {
    admin = {
      email: str(body.admin.email, { field: 'admin.email', required: true })?.toLowerCase(),
      name: str(body.admin.name, { field: 'admin.name', required: true, max: 120 }),
      password: typeof body.admin.password === 'string' ? body.admin.password : '',
    };
    if (!EMAIL_RE.test(admin.email)) throw badRequest('Correo del administrador invalido', 'INVALID_EMAIL');
    if (admin.password.length < 8) throw badRequest('La contrasena del administrador debe tener al menos 8 caracteres', 'WEAK_PASSWORD');
  }
  const branchName = str(body.branch_name, { field: 'branch_name', max: 120 }) || 'Matriz';

  const { id } = await withPlatform((db) => createRestaurant(db, {
    fields: f, moduleCodes, branchName, admin,
  }));

  const detail = await withPlatform((db) => getRestaurantDetail(db, id));
  res.status(201).json(detail);
}));

router.get('/restaurants/:id', ah(async (req, res) => {
  requireUuid(req.params.id);
  res.json(await withPlatform((db) => getRestaurantDetail(db, req.params.id)));
}));

router.patch('/restaurants/:id', ah(async (req, res) => {
  requireUuid(req.params.id);
  const f = restaurantFields(req.body || {}, { creating: false });
  if (f.name === null) throw badRequest('El nombre no puede quedar vacio', 'MISSING_FIELD');
  if (f.slug === null) throw badRequest('El slug no puede quedar vacio', 'MISSING_FIELD');
  const set = buildSet({ ...f, ...statusSideEffects(f.status) });
  if (!set) throw badRequest('No hay cambios', 'NO_CHANGES');
  const detail = await withPlatform(async (db) => {
    const { rowCount } = await db.query(
      `UPDATE restaurants SET ${set.sql}, updated_at = now()
              ${f.status === 'active' ? ', activated_at = coalesce(activated_at, now())' : ''}
        WHERE id = $${set.values.length + 1}`,
      [...set.values, req.params.id],
    );
    if (!rowCount) throw notFound('Restaurante no encontrado', 'RESTAURANT_NOT_FOUND');
    return getRestaurantDetail(db, req.params.id);
  });
  res.json(detail);
}));

// Suspender a mano (no se levanta sola al pagar) o reactivar a mano. Al
// reactivar, el cobro automatico no vuelve a suspender por adeudo antes de
// hoy + dias de gracia (para dar tiempo de pagar).
async function setStatus(req, res, status) {
  requireUuid(req.params.id);
  const detail = await withPlatform(async (db) => {
    const { grace_days: grace } = await getPlatformSettings(db);
    const { rowCount } = await db.query(
      status === 'suspended'
        ? `UPDATE restaurants SET status = $1, suspended_reason = 'manual', updated_at = now() WHERE id = $2`
        : `UPDATE restaurants SET status = $1, suspended_reason = NULL, activated_at = coalesce(activated_at, now()),
                  dunning_grace_until = $3, updated_at = now() WHERE id = $2`,
      status === 'suspended' ? [status, req.params.id] : [status, req.params.id, addDays(today(), grace)],
    );
    if (!rowCount) throw notFound('Restaurante no encontrado', 'RESTAURANT_NOT_FOUND');
    return getRestaurantDetail(db, req.params.id);
  });
  res.json(detail);
}

router.post('/restaurants/:id/suspend', ah((req, res) => setStatus(req, res, 'suspended')));
router.post('/restaurants/:id/reactivate', ah((req, res) => setStatus(req, res, 'active')));

// Borrado definitivo (cascada a sucursales, usuarios, modulos...). Exige
// ?confirm=<slug> para evitar accidentes.
router.delete('/restaurants/:id', ah(async (req, res) => {
  requireUuid(req.params.id);
  await withPlatform(async (db) => {
    const { rows } = await db.query('SELECT slug FROM restaurants WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw notFound('Restaurante no encontrado', 'RESTAURANT_NOT_FOUND');
    if (req.query.confirm !== rows[0].slug) {
      throw badRequest('Para borrar confirma escribiendo el slug del restaurante', 'CONFIRM_REQUIRED');
    }
    await db.query('DELETE FROM restaurants WHERE id = $1', [req.params.id]);
  });
  res.status(204).end();
}));

// Habilitar/deshabilitar un modulo, con precio personalizado opcional.
router.put('/restaurants/:id/modules/:code', ah(async (req, res) => {
  requireUuid(req.params.id);
  const body = req.body || {};
  const enabled = bool(body.enabled, 'enabled');
  const customPrice = money(body.custom_price_mxn, { field: 'custom_price_mxn', nullable: true });
  let discount;
  if (body.discount_pct !== undefined) {
    discount = Number(body.discount_pct);
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
      throw badRequest('El descuento debe estar entre 0 y 100', 'INVALID_FIELD');
    }
  }
  const endsAt = dateOrNull(body.ends_at, 'ends_at');

  const detail = await withPlatform(async (db) => {
    const exists = await db.query('SELECT 1 FROM restaurants WHERE id = $1', [req.params.id]);
    if (!exists.rowCount) throw notFound('Restaurante no encontrado', 'RESTAURANT_NOT_FOUND');
    const mod = await db.query('SELECT 1 FROM modules WHERE code = $1', [req.params.code]);
    if (!mod.rowCount) throw notFound('Modulo no encontrado', 'MODULE_NOT_FOUND');

    await db.query(
      `INSERT INTO restaurant_modules (restaurant_id, module_code) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.params.id, req.params.code],
    );
    const set = buildSet({
      enabled,
      custom_price_mxn: customPrice,
      discount_pct: discount,
      ends_at: endsAt,
    }, 3);
    if (set) {
      await db.query(
        `UPDATE restaurant_modules SET ${set.sql}, updated_at = now()
          WHERE restaurant_id = $1 AND module_code = $2`,
        [req.params.id, req.params.code, ...set.values],
      );
      // Fecha de alta la primera vez que se habilita.
      await db.query(
        `UPDATE restaurant_modules SET started_at = now()
          WHERE restaurant_id = $1 AND module_code = $2 AND enabled AND started_at IS NULL`,
        [req.params.id, req.params.code],
      );
    }
    return getRestaurantDetail(db, req.params.id);
  });
  res.json(detail);
}));

// Domicilios: el Panel es la autoridad del servicio de repartidores (flota).
// horom_enabled habilita que el restaurante use la flota; mode lo puede fijar
// el Panel o el propio restaurante (solo si esta habilitado). Deshabilitar
// la flota regresa al restaurante a repartidores propios.
router.put('/restaurants/:id/delivery', ah(async (req, res) => {
  requireUuid(req.params.id);
  const body = req.body || {};
  let mode = oneOf(body.mode, ['propio', 'horom'], 'mode');
  let enabled = bool(body.horom_enabled, 'horom_enabled');
  const feeType = oneOf(body.horom_fee_type, ['fixed', 'percent'], 'horom_fee_type');
  const feeValue = money(body.horom_fee_value, { field: 'horom_fee_value' });
  if (feeType === 'percent' && feeValue !== undefined && feeValue > 100) {
    throw badRequest('La comision porcentual no puede pasar de 100', 'INVALID_FIELD');
  }
  // Elegir el modo flota desde el Panel la habilita; deshabilitarla regresa a propio.
  if (mode === 'horom' && enabled === undefined) enabled = true;
  if (enabled === false) {
    if (mode === 'horom') throw badRequest('Para usar la flota debe estar habilitada', 'INVALID_FIELD');
    mode = 'propio';
  }
  const detail = await withPlatform(async (db) => {
    const exists = await db.query('SELECT 1 FROM restaurants WHERE id = $1', [req.params.id]);
    if (!exists.rowCount) throw notFound('Restaurante no encontrado', 'RESTAURANT_NOT_FOUND');
    const current = (await db.query('SELECT * FROM delivery_settings WHERE restaurant_id = $1', [req.params.id])).rows[0];
    const percentValue = feeValue ?? Number(current?.horom_fee_value ?? 0);
    if ((feeType ?? current?.horom_fee_type) === 'percent' && percentValue > 100) {
      throw badRequest('La comision porcentual no puede pasar de 100', 'INVALID_FIELD');
    }
    await db.query(
      `INSERT INTO delivery_settings (restaurant_id, mode, horom_enabled, horom_fee_type, horom_fee_value)
       VALUES ($1, coalesce($2, 'propio'), coalesce($3, false), coalesce($4, 'fixed'), coalesce($5, 0))
       ON CONFLICT (restaurant_id) DO UPDATE SET
         mode = coalesce($2, delivery_settings.mode),
         horom_enabled = coalesce($3, delivery_settings.horom_enabled),
         horom_fee_type = coalesce($4, delivery_settings.horom_fee_type),
         horom_fee_value = coalesce($5, delivery_settings.horom_fee_value),
         updated_at = now()`,
      [req.params.id, mode ?? null, enabled ?? null, feeType ?? null, feeValue ?? null],
    );
    return getRestaurantDetail(db, req.params.id);
  });
  res.json(detail);
}));

// Cobro de suscripciones: facturas, ligas de Clip y configuracion (fase 3).
router.use(platformBillingRouter);
// Flota de repartidores de la plataforma (fase 5).
router.use(platformFleetRouter);
router.use(platformMarketplaceRouter);

router.get('/restaurants/:id/charge', ah(async (req, res) => {
  requireUuid(req.params.id);
  const monthly = await withPlatform(async (db) => calculateMonthlyTotal(await listRestaurantModules(db, req.params.id)));
  res.json(monthly);
}));

export default router;
