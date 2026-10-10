// Correos a clientes y personal de un restaurante (salen con el nombre del
// restaurante y Reply-To a su correo de contacto). Ninguno lanza: un correo
// fallido no rompe la operacion (ver services/mailer.js).
import { withPlatform, withTenant } from '../config/database.js';
import { RESET_TTL_MINUTES } from './passwordReset.js';
import { sendEmail, simpleHtml } from './mailer.js';
import { restaurantSiteUrl } from './urls.js';

const money = (v) => `$${Number(v || 0).toFixed(2)}`;

async function contactEmail(restaurantId) {
  try {
    return (await withPlatform((db) => db.query('SELECT contact_email FROM restaurants WHERE id = $1', [restaurantId]))).rows[0]?.contact_email || null;
  } catch {
    return null;
  }
}

async function send(tenant, { to, subject, title, text, button }) {
  return sendEmail({
    to,
    subject,
    text: button ? `${text}\n\n${button.label}: ${button.url}` : text,
    html: simpleHtml({ title, text, button, footer: `${tenant.name} · ${restaurantSiteUrl(tenant)}` }),
    fromName: tenant.name,
    replyTo: await contactEmail(tenant.id),
  });
}

/** Liga para cambiar la contrasena. El token va en el fragmento (#): no llega a logs ni Referer. */
export function sendCustomerReset(tenant, account, token) {
  const url = `${restaurantSiteUrl(tenant)}/cuenta/restablecer#token=${token}`;
  return send(tenant, {
    to: account.email,
    subject: `Cambia tu contraseña de ${tenant.name}`,
    title: 'Cambia tu contraseña',
    text: `Hola ${account.name}, pediste cambiar la contraseña de tu cuenta en ${tenant.name}.\n\nLa liga sirve una sola vez y vence en ${RESET_TTL_MINUTES} minutos. Si no fuiste tú, ignora este correo: tu contraseña no cambia.`,
    button: { label: 'Cambiar contraseña', url },
  });
}

export function sendStaffReset(tenant, account, token) {
  const url = `${restaurantSiteUrl(tenant)}/admin/restablecer#token=${token}`;
  return send(tenant, {
    to: account.email,
    subject: `Cambia tu contraseña de ${tenant.name} (personal)`,
    title: 'Cambia tu contraseña',
    text: `Hola ${account.name}, pediste cambiar tu contraseña para entrar al sistema de ${tenant.name}.\n\nLa liga sirve una sola vez y vence en ${RESET_TTL_MINUTES} minutos. Si no fuiste tú, ignora este correo y avisa al administrador.`,
    button: { label: 'Cambiar contraseña', url },
  });
}

export function sendWelcome(tenant, customer) {
  return send(tenant, {
    to: customer.email,
    subject: `Bienvenido a ${tenant.name}`,
    title: `¡Hola, ${customer.name}!`,
    text: `Tu cuenta en ${tenant.name} está lista. Desde ella haces pedidos, sigues su estado y guardas tus direcciones.`,
    button: { label: 'Hacer un pedido', url: `${restaurantSiteUrl(tenant)}/pedir` },
  });
}

/** Confirmacion al cliente con cuenta (los invitados no dejan correo). */
const scheduledLabel = (d, tz) => new Date(d).toLocaleString('es-MX', {
  weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZone: tz || 'America/Mexico_City',
});

export function sendOrderReceived(tenant, order, email) {
  return send(tenant, {
    to: email,
    subject: `Recibimos tu pedido #${order.folio}`,
    title: `Pedido #${order.folio} recibido`,
    text: `Total: ${money(order.total)}.${order.scheduled_for ? `\n\nProgramado para: ${scheduledLabel(order.scheduled_for, order.timezone)}.` : ''}\n\nTe avisamos en la página de seguimiento cuando lo acepten y cuando esté listo.`,
    button: { label: 'Ver mi pedido', url: `${restaurantSiteUrl(tenant)}/pedido/${order.public_token}` },
  });
}

export function sendOrderRejected(tenant, order, email, reason) {
  return send(tenant, {
    to: email,
    subject: `Tu pedido #${order.folio} no pudo aceptarse`,
    title: `Pedido #${order.folio} rechazado`,
    text: `Motivo: ${reason}.${order.payment_provider === 'monedero' ? '\n\nLo que pagaste con tu monedero ya regresó a tu saldo.' : ''}${order.payment_provider === 'clip' && order.online_payment_status === 'pagado' ? '\n\nEl restaurante te contactará para el reembolso de tu pago con tarjeta.' : ''}`,
    button: { label: 'Ver mi pedido', url: `${restaurantSiteUrl(tenant)}/pedido/${order.public_token}` },
  });
}

/** Aviso a los administradores activos de un pedido en linea nuevo (si lo activaron). */
export async function alertNewOnlineOrder(tenant, order) {
  const admins = await withTenant(tenant.id, async (db) => {
    const s = (await db.query('SELECT order_email_alerts FROM online_settings WHERE restaurant_id = $1', [tenant.id])).rows[0];
    if (!s?.order_email_alerts) return [];
    return (await db.query(
      "SELECT email FROM users WHERE restaurant_id = $1 AND role IN ('admin', 'gerente') AND active", [tenant.id],
    )).rows;
  });
  for (const a of admins) {
    await send(tenant, {
      to: a.email,
      subject: `Pedido en línea #${order.folio} por ${money(order.total)}`,
      title: `Nuevo pedido #${order.folio}`,
      text: `${order.customer_name || 'Cliente'}${order.customer_phone ? ` (${order.customer_phone})` : ''} pidió ${order.order_type === 'domicilio' ? 'a domicilio' : 'para recoger'} por ${money(order.total)}.\n\nAcéptalo o recházalo en Vender › En línea.`,
    });
  }
}

/** Aviso a administradores y gerentes activos de una queja nueva. */
export async function alertNewComplaint(tenant, complaint, order) {
  const admins = await withTenant(tenant.id, async (db) => (await db.query(
    "SELECT email FROM users WHERE restaurant_id = $1 AND role IN ('admin', 'gerente') AND active", [tenant.id],
  )).rows);
  const items = (complaint.items || []).map((i) => `${i.quantity} × ${i.name}`).join(', ');
  for (const a of admins) {
    await send(tenant, {
      to: a.email,
      subject: `Queja del pedido #${order.folio}`,
      title: `Queja del pedido #${order.folio}`,
      text: `${order.customer_name || 'Un cliente'}${order.customer_phone ? ` (${order.customer_phone})` : ''} reportó un problema${items ? ` con: ${items}` : ''}.\n\n"${complaint.reason}"\n\nRevísala en Calificaciones y quejas.`,
      button: { label: 'Ver la queja', url: `${restaurantSiteUrl(tenant)}/admin/quejas` },
    });
  }
}

/** Resultado de la queja al cliente. */
export function sendComplaintResolved(tenant, c) {
  const approved = c.status === 'aprobada';
  const comp = c.compensation_type === 'monedero'
    ? `\n\nTe abonamos ${money(c.compensation_amount)} a tu monedero.`
    : c.compensation_type === 'puntos' ? `\n\nTe regalamos ${c.compensation_points} puntos.` : '';
  return send(tenant, {
    to: c.contact_email,
    subject: `Tu queja del pedido #${c.folio}`,
    title: approved ? 'Gracias por avisarnos' : `Revisamos tu queja del pedido #${c.folio}`,
    text: approved
      ? `Revisamos tu queja del pedido #${c.folio} y tienes razón. Lamentamos lo que pasó y ya lo estamos corrigiendo.${comp}`
      : `Revisamos tu queja del pedido #${c.folio}.\n\nRespuesta: ${c.review_notes}`,
    button: { label: 'Ver mi pedido', url: `${restaurantSiteUrl(tenant)}/pedido/${c.public_token}` },
  });
}
