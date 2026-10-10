// Monedero del cliente (modulo 'monedero'): ajustes, ajustes manuales de
// saldo con motivo y resumen. Las fichas de clientes estan en /api/loyalty;
// el cobro en caja es un pago en POST /api/pos/orders/:id/payments.
import { Router } from 'express';
import { withTenant } from '../config/database.js';
import { authenticateUser, requireRole } from '../middleware/auth.js';
import { requireModule } from '../middleware/requireModule.js';
import { applyWallet, loadWalletSettings } from '../services/wallet.js';
import {
  ah, badRequest, bool, buildSet, money, requireUuid, str,
} from '../utils/http.js';
import { ROLES } from './pos/common.js';

const router = Router();
router.use(authenticateUser, requireModule('monedero'));
const staff = requireRole(...ROLES.orders);
const manage = requireRole(...ROLES.manage);

router.get('/settings', staff, ah(async (req, res) => {
  res.json({ settings: await withTenant(req.tenant.id, (db) => loadWalletSettings(db, req.tenant.id)) });
}));

function readSuggested(v) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 6) throw badRequest('Montos sugeridos: hasta 6', 'INVALID_FIELD');
  const list = [...new Set(v.map(Number))].sort((a, b) => a - b);
  if (list.some((n) => !Number.isInteger(n) || n <= 0 || n > 100000)) {
    throw badRequest('Los montos sugeridos deben ser pesos enteros', 'INVALID_FIELD');
  }
  return list;
}

router.patch('/settings', manage, ah(async (req, res) => {
  const b = req.body || {};
  const f = {
    topups_enabled: bool(b.topups_enabled, 'topups_enabled'),
    min_topup: money(b.min_topup, { field: 'min_topup' }),
    max_topup: money(b.max_topup, { field: 'max_topup' }),
    suggested_amounts: readSuggested(b.suggested_amounts),
    max_balance: money(b.max_balance, { field: 'max_balance' }),
    web_enabled: bool(b.web_enabled, 'web_enabled'),
    require_code: bool(b.require_code, 'require_code'),
  };
  const settings = await withTenant(req.tenant.id, async (db) => {
    const next = { ...(await loadWalletSettings(db, req.tenant.id)), ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) };
    if (next.min_topup < 10) throw badRequest('La recarga mínima debe ser de al menos $10', 'INVALID_FIELD');
    if (next.max_topup <= next.min_topup) throw badRequest('La recarga máxima debe ser mayor que la mínima', 'INVALID_FIELD');
    if (next.max_balance < next.max_topup) throw badRequest('El saldo máximo no puede ser menor que la recarga máxima', 'INVALID_FIELD');
    await db.query('INSERT INTO wallet_settings (restaurant_id) VALUES ($1) ON CONFLICT DO NOTHING', [req.tenant.id]);
    const set = buildSet(f, 2);
    if (set) await db.query(`UPDATE wallet_settings SET ${set.sql}, updated_at = now() WHERE restaurant_id = $1`, [req.tenant.id, ...set.values]);
    return loadWalletSettings(db, req.tenant.id);
  });
  res.json({ settings });
}));

// Ajuste manual (+/-) con motivo: cortesias, compensaciones, correcciones.
router.post('/customers/:id/adjust', manage, ah(async (req, res) => {
  requireUuid(req.params.id);
  const b = req.body || {};
  const amount = Math.round(Number(b.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100000) {
    throw badRequest('Indica el monto a sumar o restar (distinto de cero)', 'INVALID_FIELD');
  }
  const reason = str(b.reason, { field: 'reason', required: true, max: 200 });
  const balance = await withTenant(req.tenant.id, (db) => applyWallet(db, req.tenant.id, {
    customerId: req.params.id, kind: 'adjust', amount, reason, userId: req.user.id,
  }));
  res.json({ balance });
}));

router.get('/stats', manage, ah(async (req, res) => {
  const stats = await withTenant(req.tenant.id, async (db) => {
    const [c] = (await db.query(
      `SELECT coalesce(sum(wallet_balance), 0) AS outstanding, count(*) FILTER (WHERE wallet_balance > 0)::int AS with_balance
         FROM customers WHERE restaurant_id = $1`,
      [req.tenant.id],
    )).rows;
    const [t] = (await db.query(
      `SELECT coalesce(sum(amount) FILTER (WHERE kind = 'topup'), 0) AS loaded,
              coalesce(-sum(amount) FILTER (WHERE kind = 'purchase'), 0) AS spent,
              coalesce(sum(amount) FILTER (WHERE kind = 'refund'), 0) AS refunded
         FROM wallet_transactions WHERE restaurant_id = $1 AND created_at >= now() - interval '30 days'`,
      [req.tenant.id],
    )).rows;
    return {
      outstanding: Number(c.outstanding),
      with_balance: c.with_balance,
      last_30_days: { loaded: Number(t.loaded), spent: Number(t.spent), refunded: Number(t.refunded) },
    };
  });
  res.json({ stats });
}));

export default router;
