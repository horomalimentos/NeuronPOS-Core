// Avisos por WhatsApp de los pedidos hechos por WhatsApp: pago recibido,
// aceptado, listo, en camino, rechazado o cancelado. Los encola el trigger
// de la migracion 021 y se mandan aqui (job cada pocos segundos). Solo se
// manda dentro de la ventana de 24 h de WhatsApp (desde el ultimo mensaje
// del cliente); fuera de ella Meta exige plantillas aprobadas.
import { withPlatform, withTenant } from '../../config/database.js';
import { checkRestaurantAccess } from '../access.js';
import { isModuleActive } from '../billing.js';
import { composeMessage } from '../push.js';
import { restaurantSiteUrl } from '../urls.js';
import { logOutbound, transmit } from './client.js';
import * as M from './messages.js';

const WINDOW_MS = 24 * 60 * 60 * 1000;

function textFor(ev, o, site) {
  if (ev.kind === 'pagado') {
    return `Recibimos tu pago del pedido *#${o.folio}*. Te aviso por aquí cuando lo acepten.\n\nSíguelo aquí: ${site}/pedido/${o.public_token}`;
  }
  const msg = composeMessage(ev, o);
  return msg ? `*${msg.title}*\n${msg.body}\n\nSíguelo aquí: ${site}${msg.link}` : null;
}

export async function dispatchWhatsAppOutbox({ now = new Date(), limit = 100 } = {}) {
  const jobs = await withPlatform(async (db) => {
    const events = (await db.query(
      `UPDATE whatsapp_outbox SET sent_at = now()
        WHERE id IN (SELECT id FROM whatsapp_outbox WHERE sent_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [limit],
    )).rows.sort((a, b) => Number(a.id) - Number(b.id));
    const out = [];
    for (const ev of events) {
      const r = (await db.query(
        `SELECT r.*, rm.enabled, rm.started_at, rm.ends_at, s.enabled AS wa_enabled, s.notify_status,
                s.phone_number_id, s.access_token_enc, s.restaurant_id AS settings_rid
           FROM restaurants r
           JOIN whatsapp_settings s ON s.restaurant_id = r.id
           LEFT JOIN restaurant_modules rm ON rm.restaurant_id = r.id AND rm.module_code = 'whatsapp'
          WHERE r.id = $1`,
        [ev.restaurant_id],
      )).rows[0];
      if (!r || !r.wa_enabled || !r.notify_status || checkRestaurantAccess(r, now) || !isModuleActive(r, now)) continue;
      const o = (await db.query(
        `SELECT o.id, o.folio, o.order_type, o.public_token, o.customer_phone, o.customer_name, o.customer_address,
                o.total, o.estimated_ready_at, o.scheduled_for, o.cancel_reason, b.name AS branch_name, b.timezone
           FROM orders o JOIN branches b ON b.id = o.branch_id AND b.restaurant_id = o.restaurant_id
          WHERE o.id = $1 AND o.restaurant_id = $2`,
        [ev.order_id, ev.restaurant_id],
      )).rows[0];
      const digits = String(o?.customer_phone || '').replace(/\D/g, '');
      if (!digits) continue;
      const conv = (await db.query(
        'SELECT * FROM whatsapp_conversations WHERE restaurant_id = $1 AND wa_id = $2',
        [ev.restaurant_id, digits],
      )).rows[0];
      if (!conv?.last_inbound_at || now - new Date(conv.last_inbound_at) > WINDOW_MS) continue;
      const body = textFor(ev, { ...o, restaurant_name: r.name }, restaurantSiteUrl(r));
      if (!body) continue;
      out.push({
        settings: { restaurant_id: r.id, phone_number_id: r.phone_number_id, access_token_enc: r.access_token_enc },
        conv,
        message: M.text(body),
      });
    }
    return out;
  });
  let sent = 0;
  for (const job of jobs) {
    const result = await transmit(job.settings, job.conv.wa_id, job.message);
    if (result.ok) sent += 1;
    await withTenant(job.conv.restaurant_id, (db) => logOutbound(db, job.conv, job.message, result));
  }
  return sent;
}

export async function cleanupWhatsApp() {
  await withPlatform((db) => db.query("DELETE FROM whatsapp_outbox WHERE sent_at < now() - interval '3 days'"));
}
