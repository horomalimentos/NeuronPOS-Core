// "Mi suscripcion" del restaurante (Fase 3): modulos contratados y
// mensualidad, facturas y pago con Clip (cuenta de la plataforma).
//
// Funciona aunque el restaurante este suspendido o con la prueba vencida:
// es justo lo que necesita para pagar. Solo admin y gerente.
import { Router } from 'express';
import { withPlatform, withTenant } from '../config/database.js';
import { authenticateUser, requireRole } from '../middleware/auth.js';
import { calculateMonthlyTotal } from '../services/billing.js';
import { reconcileLocalCheckout } from '../services/clip/reconcile.js';
import { listRestaurantModules } from '../services/restaurants.js';
import {
  billingSummary, ensureInvoiceCheckout, getInvoice, listInvoices, nextBillingDate,
} from '../services/subscriptions.js';
import { ah, requireUuid } from '../utils/http.js';

const router = Router();
router.use(authenticateUser, requireRole('admin', 'gerente'));

router.get('/', ah(async (req, res) => {
  const t = req.tenant;
  const data = await withTenant(t.id, async (db) => {
    const modules = await listRestaurantModules(db, t.id);
    const monthly = calculateMonthlyTotal(modules);
    return {
      monthly,
      invoices: await listInvoices(db, { restaurantId: t.id, limit: 24, withItems: true }),
      summary: await billingSummary(db, t),
    };
  });
  res.json({
    restaurant: {
      status: t.status,
      suspended_reason: t.suspended_reason,
      trial_ends_at: t.trial_ends_at,
      billing_day: t.billing_day,
      next_billing_date: nextBillingDate(t),
    },
    modules: data.monthly.lines,
    monthly_total_mxn: data.monthly.total_mxn,
    invoices: data.invoices,
    summary: data.summary,
  });
}));

/** Factura del restaurante (RLS + filtro explicito). */
async function ownInvoice(req) {
  requireUuid(req.params.id);
  return withTenant(req.tenant.id, (db) => getInvoice(db, req.params.id, { restaurantId: req.tenant.id }));
}

// "Pagar con Clip": liga vigente o una nueva.
router.post('/invoices/:id/pay', ah(async (req, res) => {
  const inv = await ownInvoice(req);
  const link = await ensureInvoiceCheckout(inv.id);
  res.json({ payment_url: link.payment_url, expires_at: link.expires_at });
}));

// Al regresar de Clip: concilia las ligas de la factura y regresa su estado.
router.post('/invoices/:id/verify', ah(async (req, res) => {
  const inv = await ownInvoice(req);
  const checkouts = await withPlatform(async (db) => (await db.query(
    `SELECT * FROM clip_checkouts WHERE invoice_id = $1 AND restaurant_id = $2 AND status = 'pending'`,
    [inv.id, req.tenant.id],
  )).rows);
  for (const c of checkouts) await reconcileLocalCheckout(c);
  const invoice = await withTenant(req.tenant.id, (db) => getInvoice(db, inv.id, { restaurantId: req.tenant.id }));
  const restaurant = (await withPlatform((db) => db.query('SELECT status FROM restaurants WHERE id = $1', [req.tenant.id]))).rows[0];
  res.json({ invoice, restaurant_status: restaurant.status });
}));

export default router;
