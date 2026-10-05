// Panel NeuronPOS: cobro de suscripciones (Fase 3). Se monta dentro de
// routes/platform.js, detras de authenticatePlatform.
//
//   GET  /api/platform/invoices?status=&restaurant_id=   facturas (todas o de un restaurante)
//   GET  /api/platform/invoices/:id                      detalle con lineas
//   POST /api/platform/restaurants/:id/invoices          "generar cobro ahora"
//   POST /api/platform/invoices/:id/mark-paid            pago manual con nota (transferencia...)
//   POST /api/platform/invoices/:id/resend               reenviar la liga (crea otra si vencio)
//   POST /api/platform/billing/run                       correr el ciclo de cobro ya
//   GET/PUT /api/platform/settings                       dias de gracia y estado de Clip
import { Router } from 'express';
import { withPlatform } from '../config/database.js';
import { env } from '../config/env.js';
import { hasCheckoutCredentials, platformClipCredentials } from '../services/clip/client.js';
import { secretsAvailable } from '../services/secrets.js';
import {
  afterInvoicePaid, generateNow, getInvoice, getPlatformSettings, listInvoices, markInvoicePaid,
  resendInvoiceLink, runBillingCycle,
} from '../services/subscriptions.js';
import { platformWebhookUrl } from '../services/urls.js';
import { ah, badRequest, oneOf, requireUuid, str } from '../utils/http.js';

const router = Router();

const STATUSES = ['pending', 'overdue', 'paid', 'void', 'unpaid'];

router.get('/invoices', ah(async (req, res) => {
  const status = oneOf(req.query.status || undefined, STATUSES, 'status');
  const restaurantId = req.query.restaurant_id ? requireUuid(req.query.restaurant_id, 'restaurant_id') : undefined;
  const data = await withPlatform(async (db) => {
    const invoices = await listInvoices(db, { status, restaurantId, limit: 300 });
    const totals = (await db.query(
      `SELECT coalesce(sum(amount_mxn) FILTER (WHERE status IN ('pending', 'overdue')), 0) AS unpaid_mxn,
              coalesce(sum(amount_mxn) FILTER (WHERE status = 'overdue'), 0) AS overdue_mxn,
              coalesce(sum(amount_mxn) FILTER (WHERE status = 'paid' AND paid_at >= date_trunc('month', now())), 0) AS paid_this_month_mxn
         FROM subscription_invoices WHERE ($1::uuid IS NULL OR restaurant_id = $1)`,
      [restaurantId ?? null],
    )).rows[0];
    return { invoices, totals };
  });
  res.json(data);
}));

router.get('/invoices/:id', ah(async (req, res) => {
  requireUuid(req.params.id);
  const invoice = await withPlatform((db) => getInvoice(db, req.params.id));
  res.json({ invoice });
}));

router.post('/restaurants/:id/invoices', ah(async (req, res) => {
  requireUuid(req.params.id);
  const result = await generateNow(req.params.id);
  res.status(result.created ? 201 : 200).json(result);
}));

router.post('/invoices/:id/mark-paid', ah(async (req, res) => {
  requireUuid(req.params.id);
  const body = req.body || {};
  const note = str(body.note, { field: 'note', required: true, max: 500 });
  const reference = str(body.reference, { field: 'reference', max: 200 }) || null;
  const result = await withPlatform((db) => markInvoicePaid(db, req.params.id, {
    method: 'manual', note, reference, paidBy: req.platformAdmin.id,
  }));
  await afterInvoicePaid(req.params.id, result);
  const invoice = await withPlatform((db) => getInvoice(db, req.params.id));
  res.json({ invoice, reactivated: Boolean(result.reactivated), already_paid: Boolean(result.already) });
}));

router.post('/invoices/:id/resend', ah(async (req, res) => {
  requireUuid(req.params.id);
  const link = await resendInvoiceLink(req.params.id);
  const invoice = await withPlatform((db) => getInvoice(db, req.params.id));
  res.json({ invoice, payment_url: link.payment_url, new_link: link.created });
}));

router.post('/billing/run', ah(async (req, res) => {
  const result = await runBillingCycle();
  res.json({
    skipped: Boolean(result.skipped),
    trials_converted: result.converted?.length ?? 0,
    invoices_created: result.created?.length ?? 0,
    invoices_overdue: result.overdue?.length ?? 0,
    restaurants_suspended: result.suspended?.length ?? 0,
  });
}));

async function settingsView(db) {
  const s = await getPlatformSettings(db);
  const creds = platformClipCredentials();
  return {
    grace_days: s.grace_days,
    billing_auto: env.billingAuto,
    billing_timezone: env.billingTimezone,
    // Solo si estan configuradas; los valores nunca salen de aqui.
    clip: {
      configured: hasCheckoutCredentials(creds),
      webhook_secret_configured: Boolean(creds.webhookSecret),
      webhook_url: platformWebhookUrl(),
      restaurant_webhook_url_example: `${env.publicApiUrl}/api/webhooks/clip/r/<slug-del-restaurante>`,
    },
    secrets_key_configured: secretsAvailable(),
    updated_at: s.updated_at,
  };
}

router.get('/settings', ah(async (req, res) => {
  res.json({ settings: await withPlatform(settingsView) });
}));

router.put('/settings', ah(async (req, res) => {
  const body = req.body || {};
  const grace = Number(body.grace_days);
  if (body.grace_days === undefined) throw badRequest('No hay cambios', 'NO_CHANGES');
  if (!Number.isInteger(grace) || grace < 0 || grace > 60) {
    throw badRequest('Los dias de gracia deben ser un entero de 0 a 60', 'INVALID_FIELD');
  }
  const settings = await withPlatform(async (db) => {
    await getPlatformSettings(db);
    await db.query('UPDATE platform_settings SET grace_days = $1, updated_at = now() WHERE id', [grace]);
    return settingsView(db);
  });
  res.json({ settings });
}));

export default router;
