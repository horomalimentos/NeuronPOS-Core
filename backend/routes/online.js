// Configuracion de pedidos en linea (modulo portal): interruptor general,
// pedido minimo, tiempo de preparacion, aceptacion automatica y, por
// sucursal, si recibe pedidos, si entrega a domicilio y el costo de envio.
// Lectura y escritura: admin y gerente.
import { Router } from 'express';
import { withTenant } from '../config/database.js';
import { authenticateUser, requireRole } from '../middleware/auth.js';
import { loadModuleRow, requireModule } from '../middleware/requireModule.js';
import { checkModuleAccess } from '../services/access.js';
import { getOnlineSettings, loadBranches, publicBranch } from '../services/online.js';
import { getPaymentSettings, publicPaymentSettings, updatePaymentSettings } from '../services/restaurantPayments.js';
import { ah, badRequest, bool, buildSet, money, notFound, requireUuid } from '../utils/http.js';
import { int } from './pos/common.js';

const router = Router();
router.use(authenticateUser, requireModule('portal'), requireRole('admin', 'gerente'));

async function snapshot(req, db) {
  const settings = await getOnlineSettings(db, req.tenant.id);
  const branches = (await loadBranches(db, req.tenant.id, { onlyActive: false })).map((b) => ({
    ...publicBranch(b),
    active: b.active,
    online_enabled: b.online_enabled,
    delivery_enabled: b.delivery_enabled,
    delivery_fee: b.delivery_fee,
  }));
  return { settings, branches };
}

router.get('/settings', ah(async (req, res) => {
  const data = await withTenant(req.tenant.id, (db) => snapshot(req, db));
  // Para avisar en pantalla si faltan modulos que el portal necesita.
  const [pos, domicilios] = await Promise.all([loadModuleRow(req.tenant.id, 'pos'), loadModuleRow(req.tenant.id, 'domicilios')]);
  res.json({
    ...data,
    modules: {
      pos: !checkModuleAccess(req.tenant, 'pos', pos),
      domicilios: !checkModuleAccess(req.tenant, 'domicilios', domicilios),
    },
  });
}));

router.patch('/settings', ah(async (req, res) => {
  const body = req.body || {};
  const set = buildSet({
    enabled: bool(body.enabled, 'enabled'),
    min_order: money(body.min_order, { field: 'min_order' }),
    prep_time_minutes: int(body.prep_time_minutes, { field: 'prep_time_minutes', min: 1, max: 600 }),
    auto_accept: bool(body.auto_accept, 'auto_accept'),
    allow_pickup: bool(body.allow_pickup, 'allow_pickup'),
    allow_delivery: bool(body.allow_delivery, 'allow_delivery'),
    order_email_alerts: bool(body.order_email_alerts, 'order_email_alerts'),
  }, 2);
  if (!set) throw badRequest('No hay cambios', 'NO_CHANGES');
  const data = await withTenant(req.tenant.id, async (db) => {
    await getOnlineSettings(db, req.tenant.id);
    await db.query(`UPDATE online_settings SET ${set.sql}, updated_at = now() WHERE restaurant_id = $1`, [req.tenant.id, ...set.values]);
    return snapshot(req, db);
  });
  res.json(data);
}));

router.put('/branches/:id', ah(async (req, res) => {
  requireUuid(req.params.id);
  const body = req.body || {};
  const f = {
    online_enabled: bool(body.online_enabled, 'online_enabled'),
    delivery_enabled: bool(body.delivery_enabled, 'delivery_enabled'),
    delivery_fee: money(body.delivery_fee, { field: 'delivery_fee' }),
  };
  if (Object.values(f).every((v) => v === undefined)) throw badRequest('No hay cambios', 'NO_CHANGES');
  const data = await withTenant(req.tenant.id, async (db) => {
    const exists = await db.query('SELECT 1 FROM branches WHERE id = $1 AND restaurant_id = $2', [req.params.id, req.tenant.id]);
    if (!exists.rowCount) throw notFound('Sucursal no encontrada', 'BRANCH_NOT_FOUND');
    await db.query(
      `INSERT INTO branch_online_settings (restaurant_id, branch_id, online_enabled, delivery_enabled, delivery_fee)
       VALUES ($1, $2, coalesce($3, true), coalesce($4, true), coalesce($5, 0))
       ON CONFLICT (branch_id) DO UPDATE SET
         online_enabled = coalesce($3, branch_online_settings.online_enabled),
         delivery_enabled = coalesce($4, branch_online_settings.delivery_enabled),
         delivery_fee = coalesce($5, branch_online_settings.delivery_fee),
         updated_at = now()`,
      [req.tenant.id, req.params.id, f.online_enabled ?? null, f.delivery_enabled ?? null, f.delivery_fee ?? null],
    );
    return snapshot(req, db);
  });
  res.json(data);
}));

// ---------------------------------------------------------------------------
// Pago en linea con Clip (fase 3): credenciales de la cuenta de Clip del
// restaurante. Se guardan cifradas y nunca se regresan: solo "configurado".
// Ver: admin y gerente. Cambiar: solo admin.
// ---------------------------------------------------------------------------

router.get('/payments', ah(async (req, res) => {
  const row = await withTenant(req.tenant.id, (db) => getPaymentSettings(db, req.tenant.id));
  res.json({ payments: publicPaymentSettings(row, req.tenant) });
}));

router.put('/payments', requireRole('admin'), ah(async (req, res) => {
  const row = await withTenant(req.tenant.id, (db) => updatePaymentSettings(db, req.tenant.id, req.body || {}));
  res.json({ payments: publicPaymentSettings(row, req.tenant) });
}));

export default router;
