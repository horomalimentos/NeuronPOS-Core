// Cobro de la suscripcion mensual de cada restaurante (Fase 3).
//
// - Una factura por restaurante y periodo (UNIQUE (restaurant_id, period)):
//   correr el ciclo varias veces no duplica nada.
// - Periodo: del dia de cobro (billing_day o el dia en que se activo) al dia
//   anterior del siguiente mes. Se cobra por adelantado y la fecha limite es
//   el inicio del periodo. Sin prorrateo.
// - Lineas: cada modulo vigente con su precio (especial o de catalogo) y su
//   descuento, calculado en centavos (billing.js). Fase 5: mas una linea
//   "Domicilios Horom (N entregas)" con las comisiones de la flota que aun no
//   se cobran (cada entrega se factura una sola vez: queda ligada a la factura).
// - Al terminar una prueba el restaurante pasa a 'active' y se genera su
//   primera factura.
// - Cobranza: vencida al pasar la fecha limite; suspendida (falta_pago) al
//   pasar la fecha limite + dias de gracia (platform_settings). Pagar la
//   reactiva sola si ya no debe nada vencido. Una suspension manual del dueno
//   nunca se levanta sola.
// - Cada factura con importe tiene una liga de pago de Clip (cuenta de la
//   plataforma). Una factura en 0 queda pagada "sin cargo".
import { withPlatform } from '../config/database.js';
import { env } from '../config/env.js';
import { HttpError, badRequest, notFound } from '../utils/http.js';
import {
  addDays, billingPeriod, buildInvoiceLines, effectiveBillingDay, localDate, suspensionDate,
} from './billing.js';
import { createClipClient, hasCheckoutCredentials, platformClipCredentials } from './clip/client.js';
import { reconcileLocalCheckout } from './clip/reconcile.js';
import { horomInvoiceLine, pendingInvoiceCharges } from './delivery/fleet.js';
import { notify } from './notifier.js';
import { toCents } from './posMath.js';
import { listRestaurantModules } from './restaurants.js';
import { platformWebhookUrl, restaurantSiteUrl } from './urls.js';

const conflict = (msg, code) => new HttpError(409, msg, code);
export const today = (now = new Date()) => localDate(now, env.billingTimezone);

export async function getPlatformSettings(db) {
  await db.query('INSERT INTO platform_settings (id) VALUES (true) ON CONFLICT DO NOTHING');
  return (await db.query('SELECT grace_days, updated_at FROM platform_settings WHERE id')).rows[0];
}

const SELECT_INVOICES = `
  SELECT i.id, i.restaurant_id, to_char(i.period, 'YYYY-MM-DD') AS period,
         to_char(i.period_end, 'YYYY-MM-DD') AS period_end, to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
         i.subtotal_mxn, i.discount_mxn, i.amount_mxn, i.currency, i.status, i.paid_at, i.paid_method,
         i.paid_reference, i.paid_note, i.overdue_at, i.last_sent_at, i.created_at, i.updated_at,
         r.name AS restaurant_name, r.slug AS restaurant_slug, r.status AS restaurant_status,
         c.id AS checkout_ref, c.payment_url, c.status AS link_status, c.expires_at AS link_expires_at,
         c.created_at AS link_created_at
    FROM subscription_invoices i
    JOIN restaurants r ON r.id = i.restaurant_id
    LEFT JOIN LATERAL (
      SELECT id, payment_url, status, expires_at, created_at FROM clip_checkouts
       WHERE invoice_id = i.id AND restaurant_id = i.restaurant_id
       ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 1
    ) c ON true`;

/** Vista de una factura: liga vigente solo si sigue pendiente y no vencio. */
export function invoiceView(row, graceDays, now = new Date()) {
  const unpaid = ['pending', 'overdue'].includes(row.status);
  const linkLive = unpaid && row.link_status === 'pending' && row.payment_url
    && (!row.link_expires_at || new Date(row.link_expires_at) > now);
  return {
    id: row.id,
    restaurant_id: row.restaurant_id,
    restaurant_name: row.restaurant_name,
    restaurant_slug: row.restaurant_slug,
    restaurant_status: row.restaurant_status,
    period: row.period,
    period_end: row.period_end,
    due_date: row.due_date,
    suspends_on: unpaid && graceDays !== undefined ? suspensionDate(row.due_date, graceDays) : null,
    subtotal_mxn: row.subtotal_mxn,
    discount_mxn: row.discount_mxn,
    amount_mxn: row.amount_mxn,
    currency: row.currency,
    status: row.status,
    paid_at: row.paid_at,
    paid_method: row.paid_method,
    paid_reference: row.paid_reference,
    paid_note: row.paid_note,
    last_sent_at: row.last_sent_at,
    created_at: row.created_at,
    payment_url: linkLive ? row.payment_url : null,
    payment_link_status: row.link_status || null,
    payment_link_expires_at: linkLive ? row.link_expires_at : null,
    ...(row.items ? { items: row.items } : {}),
  };
}

export async function loadInvoiceItems(db, invoiceIds) {
  if (!invoiceIds.length) return new Map();
  const rows = (await db.query(
    `SELECT invoice_id, module_code, name, catalog_price_mxn, custom_price_mxn, unit_price_mxn,
            discount_pct, discount_mxn, amount_mxn
       FROM subscription_invoice_items WHERE invoice_id = ANY($1::uuid[]) ORDER BY sort_order, name`,
    [invoiceIds],
  )).rows;
  const map = new Map(invoiceIds.map((id) => [id, []]));
  for (const { invoice_id: id, ...item } of rows) map.get(id)?.push(item);
  return map;
}

/**
 * Lista facturas (db de withPlatform o withTenant; RLS limita al restaurante).
 * filters: { restaurantId, status: 'unpaid' | estado, limit, withItems }
 */
export async function listInvoices(db, { restaurantId, status, limit = 100, withItems = false, ids } = {}) {
  const where = [];
  const values = [];
  if (restaurantId) { values.push(restaurantId); where.push(`i.restaurant_id = $${values.length}`); }
  if (ids) { values.push(ids); where.push(`i.id = ANY($${values.length}::uuid[])`); }
  if (status === 'unpaid') where.push(`i.status IN ('pending', 'overdue')`);
  else if (status) { values.push(status); where.push(`i.status = $${values.length}`); }
  values.push(Math.min(500, limit));
  const rows = (await db.query(
    `${SELECT_INVOICES} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY i.period DESC, r.name LIMIT $${values.length}`,
    values,
  )).rows;
  const { grace_days: grace } = await getPlatformSettings(db);
  if (withItems) {
    const items = await loadInvoiceItems(db, rows.map((r) => r.id));
    for (const r of rows) r.items = items.get(r.id);
  }
  return rows.map((r) => invoiceView(r, grace));
}

export async function getInvoice(db, id, { restaurantId } = {}) {
  const [inv] = await listInvoices(db, { ids: [id], restaurantId, withItems: true, limit: 1 });
  if (!inv) throw notFound('Factura no encontrada', 'INVOICE_NOT_FOUND');
  return inv;
}

// ---------------------------------------------------------------------------
// Generacion
// ---------------------------------------------------------------------------

/**
 * Genera (si falta) la factura del periodo vigente de un restaurante.
 * restaurant: fila completa de restaurants. Idempotente por periodo; tampoco
 * crea una factura que se traslape con otra (p. ej. al cambiar el dia de cobro).
 */
export async function generateInvoice(db, restaurant, { now = new Date() } = {}) {
  const day = effectiveBillingDay(restaurant, env.billingTimezone);
  const period = billingPeriod(today(now), day);
  const overlap = (await db.query(
    `SELECT id FROM subscription_invoices
      WHERE restaurant_id = $1 AND status <> 'void' AND period <= $3 AND period_end >= $2
      ORDER BY period LIMIT 1`,
    [restaurant.id, period.start, period.end],
  )).rows[0];
  if (overlap) return { id: overlap.id, created: false };

  const modules = await listRestaurantModules(db, restaurant.id);
  const bill = buildInvoiceLines(modules, now);
  // Fase 5: comisiones de la flota (domicilios Horom) aun sin cobrar.
  const charges = await pendingInvoiceCharges(db, restaurant.id, now);
  if (charges.count) {
    const line = horomInvoiceLine(charges);
    bill.lines.push(line);
    bill.subtotal_mxn = (toCents(bill.subtotal_mxn) + toCents(line.amount_mxn)) / 100;
    bill.total_mxn = (toCents(bill.total_mxn) + toCents(line.amount_mxn)) / 100;
  }
  const free = bill.total_mxn === 0;
  const inserted = (await db.query(
    `INSERT INTO subscription_invoices (restaurant_id, period, period_end, due_date, subtotal_mxn, discount_mxn,
                                        amount_mxn, status, detail, paid_at, paid_method)
     VALUES ($1, $2, $3, $2, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (restaurant_id, period) DO NOTHING RETURNING id`,
    [restaurant.id, period.start, period.end, bill.subtotal_mxn, bill.discount_mxn, bill.total_mxn,
      free ? 'paid' : 'pending', JSON.stringify(bill.lines), free ? now : null, free ? 'sin_cargo' : null],
  )).rows[0];
  if (!inserted) {
    const existing = (await db.query(
      'SELECT id FROM subscription_invoices WHERE restaurant_id = $1 AND period = $2',
      [restaurant.id, period.start],
    )).rows[0];
    return { id: existing.id, created: false };
  }
  for (const [i, l] of bill.lines.entries()) {
    await db.query(
      `INSERT INTO subscription_invoice_items (restaurant_id, invoice_id, module_code, name, catalog_price_mxn,
                                               custom_price_mxn, unit_price_mxn, discount_pct, discount_mxn, amount_mxn, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [restaurant.id, inserted.id, l.module_code, l.name, l.catalog_price_mxn, l.custom_price_mxn,
        l.unit_price_mxn, l.discount_pct, l.discount_mxn, l.amount_mxn, i],
    );
  }
  if (charges.count) {
    await db.query(
      'UPDATE delivery_requests SET commission_invoice_id = $2, updated_at = now() WHERE id = ANY($1::uuid[])',
      [charges.ids, inserted.id],
    );
  }
  return { id: inserted.id, created: true, amount_mxn: bill.total_mxn };
}

/** Prueba vencida -> activo (desde el fin de la prueba). */
async function convertEndedTrials(db, now, restaurantId = null) {
  return (await db.query(
    `UPDATE restaurants SET status = 'active', activated_at = trial_ends_at, updated_at = now()
      WHERE status = 'trial' AND trial_ends_at IS NOT NULL AND trial_ends_at <= $1
        AND ($2::uuid IS NULL OR id = $2)
      RETURNING id`,
    [now, restaurantId],
  )).rows.map((r) => r.id);
}

/**
 * Ciclo de cobro (lo corre el job cada hora y el Panel con "Correr cobro").
 * Regresa lo que hizo. Las ligas de Clip y los avisos se crean despues de
 * confirmar la transaccion.
 */
export async function runBillingCycle({ now = new Date() } = {}) {
  const day = today(now);
  const result = await withPlatform(async (db) => {
    const lock = await db.query("SELECT pg_try_advisory_xact_lock(hashtext('neuronpos:cobro')) AS ok");
    if (!lock.rows[0].ok) return null;
    const { grace_days: grace } = await getPlatformSettings(db);

    const converted = await convertEndedTrials(db, now);

    const created = [];
    const active = (await db.query("SELECT * FROM restaurants WHERE status = 'active' ORDER BY name")).rows;
    for (const r of active) {
      const g = await generateInvoice(db, r, { now });
      if (g.created) created.push(g.id);
    }

    const overdue = (await db.query(
      `UPDATE subscription_invoices SET status = 'overdue', overdue_at = now(), updated_at = now()
        WHERE status = 'pending' AND due_date < $1 RETURNING id`,
      [day],
    )).rows.map((r) => r.id);

    const suspended = (await db.query(
      `UPDATE restaurants r SET status = 'suspended', suspended_reason = 'falta_pago', updated_at = now()
        WHERE r.status = 'active'
          AND (r.dunning_grace_until IS NULL OR r.dunning_grace_until < $1)
          AND EXISTS (SELECT 1 FROM subscription_invoices i
                       WHERE i.restaurant_id = r.id AND i.status IN ('pending', 'overdue')
                         AND i.due_date + $2::int < $1)
        RETURNING r.id`,
      [day, grace],
    )).rows.map((r) => r.id);

    return { converted, created, overdue, suspended, grace };
  });
  if (!result) return { skipped: true };

  const links = [];
  for (const id of result.created) {
    const inv = await withPlatform((db) => getInvoice(db, id));
    let url = null;
    if (inv.status !== 'paid') {
      try {
        url = (await ensureInvoiceCheckout(id, { now })).payment_url;
        links.push(id);
      } catch (err) {
        console.error(`[cobro] no se pudo crear la liga de la factura ${id}:`, err.message);
      }
    }
    await notifyInvoice('factura_generada', id, { url });
  }
  for (const id of result.overdue) await notifyInvoice('factura_vencida', id);
  for (const rid of result.suspended) await notifyRestaurant('restaurante_suspendido', rid);
  return { ...result, links };
}

async function contactOf(db, restaurantId) {
  return (await db.query('SELECT id, name, contact_email FROM restaurants WHERE id = $1', [restaurantId])).rows[0];
}

async function notifyInvoice(type, invoiceId, extra = {}) {
  const { inv, r } = await withPlatform(async (db) => {
    const i = await getInvoice(db, invoiceId);
    return { inv: i, r: await contactOf(db, i.restaurant_id) };
  });
  await notify(type, {
    to: r.contact_email,
    restaurant: r.name,
    period: `${inv.period} al ${inv.period_end}`,
    amount: inv.amount_mxn,
    due_date: inv.due_date,
    suspends_on: inv.suspends_on,
    url: extra.url ?? inv.payment_url,
  });
}

async function notifyRestaurant(type, restaurantId) {
  const r = await withPlatform((db) => contactOf(db, restaurantId));
  if (r) await notify(type, { to: r.contact_email, restaurant: r.name });
}

/**
 * "Generar cobro ahora" (Panel): genera la factura del periodo vigente y su
 * liga. Si la prueba ya termino, primero activa el restaurante.
 */
export async function generateNow(restaurantId, { now = new Date() } = {}) {
  const gen = await withPlatform(async (db) => {
    const r = (await db.query('SELECT * FROM restaurants WHERE id = $1 FOR UPDATE', [restaurantId])).rows[0];
    if (!r) throw notFound('Restaurante no encontrado', 'RESTAURANT_NOT_FOUND');
    if (r.status === 'trial') {
      if (!r.trial_ends_at || new Date(r.trial_ends_at) > now) {
        throw conflict('El restaurante sigue en prueba: el primer cobro se genera al terminar la prueba', 'TRIAL_ACTIVE');
      }
      await convertEndedTrials(db, now, r.id);
      Object.assign(r, (await db.query('SELECT * FROM restaurants WHERE id = $1', [r.id])).rows[0]);
    }
    if (!r.activated_at) {
      await db.query('UPDATE restaurants SET activated_at = now() WHERE id = $1 AND activated_at IS NULL', [r.id]);
      r.activated_at = now;
    }
    return generateInvoice(db, r, { now });
  });
  let linkError = null;
  const inv = await withPlatform((db) => getInvoice(db, gen.id));
  if (['pending', 'overdue'].includes(inv.status)) {
    try {
      await ensureInvoiceCheckout(gen.id, { now });
    } catch (err) {
      linkError = err.message;
    }
  }
  if (gen.created) await notifyInvoice('factura_generada', gen.id);
  return { invoice: await withPlatform((db) => getInvoice(db, gen.id)), created: gen.created, link_error: linkError };
}

// ---------------------------------------------------------------------------
// Ligas de pago (Clip de la plataforma)
// ---------------------------------------------------------------------------

/**
 * Regresa la liga vigente de la factura o crea una nueva en Clip. Antes de
 * crear otra, concilia las que ya vencieron (quiza se pagaron).
 *
 * DECISION (igual que el NeuronPOS original): la llamada a Clip se hace con
 * la factura bloqueada (FOR UPDATE) dentro de la transaccion, para que dos
 * clics no creen dos ligas. El indice unico de "una liga pendiente por
 * factura" es la red de seguridad.
 */
export async function ensureInvoiceCheckout(invoiceId, { now = new Date() } = {}) {
  const creds = platformClipCredentials();
  if (!hasCheckoutCredentials(creds)) {
    throw conflict('La cuenta de Clip de la plataforma no esta configurada (CLIP_API_KEY / CLIP_SECRET_KEY)', 'CLIP_NOT_CONFIGURED');
  }
  const stale = await withPlatform(async (db) => (await db.query(
    `SELECT * FROM clip_checkouts WHERE invoice_id = $1 AND status = 'pending'
        AND expires_at IS NOT NULL AND expires_at <= $2`,
    [invoiceId, new Date(now.getTime() + 5 * 60000)],
  )).rows);
  for (const c of stale) await reconcileLocalCheckout(c);

  return withPlatform(async (db) => {
    const inv = (await db.query(
      `SELECT i.*, to_char(i.period, 'YYYY-MM-DD') AS period_txt, r.slug, r.name AS restaurant_name, r.custom_domain
         FROM subscription_invoices i JOIN restaurants r ON r.id = i.restaurant_id
        WHERE i.id = $1 FOR UPDATE OF i`,
      [invoiceId],
    )).rows[0];
    if (!inv) throw notFound('Factura no encontrada', 'INVOICE_NOT_FOUND');
    if (inv.status === 'paid') throw conflict('La factura ya esta pagada', 'INVOICE_PAID');
    if (inv.status === 'void') throw badRequest('La factura esta cancelada', 'INVOICE_VOID');

    const current = (await db.query(
      `SELECT * FROM clip_checkouts WHERE invoice_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      [invoiceId],
    )).rows[0];
    if (current && (!current.expires_at || new Date(current.expires_at) > new Date(now.getTime() + 5 * 60000))) {
      return { checkout_id: current.id, payment_url: current.payment_url, expires_at: current.expires_at, created: false };
    }
    if (current) {
      await db.query("UPDATE clip_checkouts SET status = 'expired', updated_at = now() WHERE id = $1", [current.id]);
    }

    const back = `${restaurantSiteUrl(inv)}/admin/suscripcion?factura=${inv.id}`;
    const link = await createClipClient(creds).createCheckout({
      amount: Number(inv.amount_mxn),
      description: `NeuronPOS ${inv.restaurant_name} - mensualidad ${inv.period_txt}`,
      redirect: { success: `${back}&pago=ok`, error: `${back}&pago=error`, default: `${back}&pago=cancelado` },
      webhookUrl: platformWebhookUrl(),
      metadata: { tipo: 'suscripcion', invoice_id: inv.id, restaurant_id: inv.restaurant_id },
    });
    const row = (await db.query(
      `INSERT INTO clip_checkouts (restaurant_id, purpose, invoice_id, checkout_id, payment_url, amount, currency,
                                   expires_at, response_data)
       VALUES ($1, 'suscripcion', $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [inv.restaurant_id, inv.id, link.checkout_id, link.payment_url, inv.amount_mxn, inv.currency,
        link.expires_at, JSON.stringify(link.raw)],
    )).rows[0];
    return { checkout_id: row.id, payment_url: row.payment_url, expires_at: row.expires_at, created: true };
  });
}

/** "Reenviar liga": asegura una liga vigente y la manda al contacto del restaurante. */
export async function resendInvoiceLink(invoiceId, { now = new Date() } = {}) {
  const link = await ensureInvoiceCheckout(invoiceId, { now });
  await withPlatform((db) => db.query(
    'UPDATE subscription_invoices SET last_sent_at = now(), updated_at = now() WHERE id = $1',
    [invoiceId],
  ));
  await notifyInvoice('liga_de_pago', invoiceId, { url: link.payment_url });
  return link;
}

// ---------------------------------------------------------------------------
// Pago y reactivacion
// ---------------------------------------------------------------------------

/**
 * Reactiva un restaurante suspendido por falta de pago si ya no debe nada
 * fuera de la gracia. Regresa true si lo reactivo.
 */
async function maybeReactivate(db, restaurantId, now) {
  const r = (await db.query('SELECT status, suspended_reason FROM restaurants WHERE id = $1 FOR UPDATE', [restaurantId])).rows[0];
  if (!r || r.status !== 'suspended' || r.suspended_reason !== 'falta_pago') return false;
  const { grace_days: grace } = await getPlatformSettings(db);
  const owes = (await db.query(
    `SELECT 1 FROM subscription_invoices
      WHERE restaurant_id = $1 AND status IN ('pending', 'overdue') AND due_date + $2::int < $3 LIMIT 1`,
    [restaurantId, grace, today(now)],
  )).rowCount;
  if (owes) return false;
  await db.query(
    `UPDATE restaurants SET status = 'active', suspended_reason = NULL, activated_at = coalesce(activated_at, now()),
            updated_at = now() WHERE id = $1`,
    [restaurantId],
  );
  return true;
}

/**
 * Marca una factura como pagada (db de withPlatform). Idempotente.
 * Regresa { paid, already, reactivated, restaurant_id }.
 */
export async function markInvoicePaid(db, invoiceId, {
  method, reference = null, note = null, paidBy = null, now = new Date(),
}) {
  const inv = (await db.query('SELECT * FROM subscription_invoices WHERE id = $1 FOR UPDATE', [invoiceId])).rows[0];
  if (!inv) throw notFound('Factura no encontrada', 'INVOICE_NOT_FOUND');
  if (inv.status === 'paid') return { paid: true, already: true, restaurant_id: inv.restaurant_id };
  if (inv.status === 'void') throw badRequest('La factura esta cancelada', 'INVOICE_VOID');
  await db.query(
    `UPDATE subscription_invoices SET status = 'paid', paid_at = $2, paid_method = $3, paid_reference = $4,
            paid_note = $5, paid_by = $6, updated_at = now()
      WHERE id = $1`,
    [invoiceId, now, method, reference, note, paidBy],
  );
  if (method !== 'clip') {
    // Las ligas pendientes ya no se concilian solas; si alguien paga una, su
    // webhook la marca como pago tardio.
    await db.query(
      "UPDATE clip_checkouts SET status = 'cancelled', updated_at = now() WHERE invoice_id = $1 AND status = 'pending'",
      [invoiceId],
    );
  }
  const reactivated = await maybeReactivate(db, inv.restaurant_id, now);
  return { paid: true, already: false, reactivated, restaurant_id: inv.restaurant_id };
}

/** Aviso despues de confirmar el pago (fuera de la transaccion). */
export async function afterInvoicePaid(invoiceId, result) {
  if (!result || result.already) return;
  await notifyInvoice('factura_pagada', invoiceId);
  if (result.reactivated) await notifyRestaurant('restaurante_reactivado', result.restaurant_id);
}

/** Lo que reconcile.js aplica cuando Clip confirma el pago de una factura. */
export async function applyInvoiceCheckout(db, checkout, data, now = new Date()) {
  const inv = (await db.query('SELECT status FROM subscription_invoices WHERE id = $1', [checkout.invoice_id])).rows[0];
  if (!inv) return { late: true };
  // Ya pagada por otra via (manual u otra liga): el pago llega de mas.
  if (inv.status === 'paid' || inv.status === 'void') return { late: true };
  const reference = String(data?.transaction_id || data?.receipt_no || checkout.checkout_id).slice(0, 200);
  const result = await markInvoicePaid(db, checkout.invoice_id, { method: 'clip', reference, now });
  return { late: false, after: () => afterInvoicePaid(checkout.invoice_id, result) };
}

/** Resumen para el banner del restaurante (/api/me) y "Mi suscripcion". */
export async function billingSummary(db, restaurant, { now = new Date() } = {}) {
  const { grace_days: grace } = await getPlatformSettings(db);
  const unpaid = await listInvoices(db, { restaurantId: restaurant.id, status: 'unpaid', limit: 12 });
  const d = today(now);
  const oldest = unpaid.length ? unpaid[unpaid.length - 1] : null;
  return {
    grace_days: grace,
    unpaid_count: unpaid.length,
    unpaid_total_mxn: unpaid.reduce((s, i) => s + Math.round(Number(i.amount_mxn) * 100), 0) / 100,
    overdue: unpaid.some((i) => i.status === 'overdue' || i.due_date < d),
    next_invoice: oldest ? {
      id: oldest.id, amount_mxn: oldest.amount_mxn, due_date: oldest.due_date, status: oldest.status,
      suspends_on: oldest.suspends_on, payment_url: oldest.payment_url,
    } : null,
    suspended_for_nonpayment: restaurant.status === 'suspended' && restaurant.suspended_reason === 'falta_pago',
  };
}

/** Fecha del siguiente cobro de un restaurante activo (para "Mi suscripcion"). */
export function nextBillingDate(restaurant, now = new Date()) {
  if (restaurant.status === 'trial') return restaurant.trial_ends_at ? localDate(restaurant.trial_ends_at, env.billingTimezone) : null;
  const day = effectiveBillingDay(restaurant, env.billingTimezone);
  return billingPeriod(today(now), day).next;
}

export { addDays };
