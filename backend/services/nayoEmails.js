// Correos de Nayo a sus clientes: salen como "Nayo" (NAYO_MAIL_FROM) con ligas
// a elnayo.com (NAYO_SITE_URL). Ninguno lanza: un correo fallido no rompe el
// registro ni el pedido (ver services/mailer.js).
import { env } from '../config/env.js';
import { sendEmail, simpleHtml } from './mailer.js';
import { RESET_TTL_MINUTES } from './passwordReset.js';

const money = (v) => `$${Number(v || 0).toFixed(2)}`;

function send({ to, subject, title, text, button }) {
  return sendEmail({
    to,
    from: env.nayoMailFrom,
    subject,
    text: button ? `${text}\n\n${button.label}: ${button.url}` : text,
    html: simpleHtml({ title, text, button, footer: `Nayo · ${env.nayoSiteUrl.replace(/^https?:\/\//, '')}` }),
  });
}

export function sendNayoWelcome(customer) {
  return send({
    to: customer.email,
    subject: 'Bienvenido a Nayo',
    title: `¡Hola, ${customer.name}!`,
    text: 'Tu cuenta de Nayo está lista. Con ella pides a los restaurantes cerca de ti y sigues tu pedido hasta tu puerta.',
    button: { label: 'Ver restaurantes', url: env.nayoSiteUrl },
  });
}

/** Codigo para verificar el correo al crear la cuenta. */
export function sendNayoVerifyCode(customer, code, minutes) {
  return send({
    to: customer.email,
    subject: `${code} es tu código de Nayo`,
    title: 'Confirma tu correo',
    text: `Hola ${customer.name}, tu código para confirmar tu correo en Nayo es:\n\n${code}\n\nVence en ${minutes} minutos. Si no fuiste tú, ignora este correo.`,
  });
}

/** Liga para cambiar la contrasena. El token va en el fragmento (#): no llega a logs ni Referer. */
export function sendNayoReset(customer, token) {
  return send({
    to: customer.email,
    subject: 'Cambia tu contraseña de Nayo',
    title: 'Cambia tu contraseña',
    text: `Hola ${customer.name}, pediste cambiar la contraseña de tu cuenta de Nayo.\n\nLa liga sirve una sola vez y vence en ${RESET_TTL_MINUTES} minutos. Si no fuiste tú, ignora este correo: tu contraseña no cambia.`,
    button: { label: 'Cambiar contraseña', url: `${env.nayoSiteUrl}/restablecer#token=${token}` },
  });
}

export function sendNayoOrderReceived(customer, order) {
  return send({
    to: customer.email,
    subject: `Tu pedido de ${order.restaurant.name} en Nayo`,
    title: 'Recibimos tu pedido',
    text: `Hola ${customer.name}, tu pedido de ${order.restaurant.name} por ${money(order.total)} ya está en el restaurante. Te avisamos en la página de seguimiento cuando lo acepten y cuando vaya en camino.`,
    button: { label: 'Seguir mi pedido', url: `${env.nayoSiteUrl}/pedido/${order.token}` },
  });
}
