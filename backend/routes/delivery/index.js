// Modulo de domicilios (fase 5). Todas las rutas requieren usuario del
// restaurante y el modulo 'domicilios' contratado (402 si no).
//
//   - Configuracion: modo propio / flota (el Panel habilita la flota y fija
//     la comision; el restaurante solo elige el modo y ve las condiciones).
//   - Reparto (caja): pedidos a domicilio listos, asignar repartidor propio
//     o pedir repartidor a la flota, estados y mapa en vivo.
//   - App del repartidor propio (/repartidor): sus pedidos, estados, cobro en
//     la puerta, turno y ubicacion.
//   - Corte del repartidor: su efectivo entra al turno de caja abierto.
import { Router } from 'express';
import { withTenant } from '../../config/database.js';
import { authenticateUser, requireRole } from '../../middleware/auth.js';
import { requireModule } from '../../middleware/requireModule.js';
import { pendingLedger } from '../../services/delivery/fleet.js';
import { getDeliveryConfig } from '../../services/delivery/tenant.js';
import { HttpError, ah, badRequest, oneOf } from '../../utils/http.js';
import { isManager } from '../pos/common.js';
import cutsRouter from './cuts.js';
import dispatchRouter from './dispatch.js';
import driverRouter from './driver.js';

const router = Router();
router.use(authenticateUser, requireModule('domicilios'));

router.get('/settings', ah(async (req, res) => {
  const s = await withTenant(req.tenant.id, (db) => getDeliveryConfig(db, req.tenant.id));
  res.json({
    settings: {
      mode: s.mode,
      horom_enabled: s.horom_enabled,
      // Las condiciones de la flota solo las ven admin y gerente.
      ...(isManager(req.user) ? { horom_fee_type: s.horom_fee_type, horom_fee_value: s.horom_fee_value } : {}),
      updated_at: s.updated_at,
    },
  });
}));

// El restaurante solo elige el modo; la flota requiere que NeuronPOS la habilite.
router.put('/settings', requireRole('admin'), ah(async (req, res) => {
  const mode = oneOf((req.body || {}).mode, ['propio', 'horom'], 'mode');
  if (!mode) throw badRequest('Elige el modo de reparto', 'MISSING_FIELD');
  const s = await withTenant(req.tenant.id, async (db) => {
    const current = await getDeliveryConfig(db, req.tenant.id);
    if (mode === 'horom' && !current.horom_enabled) {
      throw new HttpError(403, 'NeuronPOS no ha habilitado el servicio de repartidores para tu restaurante', 'HOROM_NOT_ENABLED');
    }
    const active = (await db.query(
      `SELECT (SELECT count(*) FROM order_deliveries WHERE restaurant_id = $1 AND status IN ('asignado', 'recogido', 'en_camino'))
            + (SELECT count(*) FROM delivery_requests WHERE restaurant_id = $1 AND status IN ('solicitado', 'asignado', 'recogido', 'en_camino'))
              AS n`,
      [req.tenant.id],
    )).rows[0].n;
    if (Number(active) > 0 && mode !== current.mode) {
      throw new HttpError(409, 'Termina los repartos en curso antes de cambiar de modo', 'DELIVERIES_IN_PROGRESS');
    }
    const { rowCount } = await db.query(
      'UPDATE delivery_settings SET mode = $2, updated_at = now() WHERE restaurant_id = $1',
      [req.tenant.id, mode],
    );
    // Sin fila solo puede ser 'propio' (la flota exige que el Panel la habilite).
    if (!rowCount) await db.query('INSERT INTO delivery_settings (restaurant_id, mode) VALUES ($1, $2)', [req.tenant.id, mode]);
    return getDeliveryConfig(db, req.tenant.id);
  });
  res.json({ settings: s });
}));

// Liquidaciones de la flota al restaurante (solo lectura).
router.get('/horom/ledger', requireRole('admin', 'gerente'), ah(async (req, res) => {
  const data = await withTenant(req.tenant.id, async (db) => {
    const ledger = await pendingLedger(db, req.tenant.id);
    const settlements = (await db.query(
      `SELECT id, cash_amount, commission_amount, net_amount, deliveries_count, method, reference, notes, created_at
         FROM fleet_settlements WHERE restaurant_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.tenant.id],
    )).rows;
    const { cash, commissions, payout, ...summary } = ledger;
    return { summary: { ...summary, payout_now: payout.net_amount }, settlements };
  });
  res.json(data);
}));

router.use(dispatchRouter);
router.use(cutsRouter);
router.use('/driver', driverRouter);

export default router;
