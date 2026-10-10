// Correo transaccional por SMTP (nodemailer).
//
// - Sin SMTP_HOST el correo no sale: se anota en el log (en desarrollo con el
//   texto completo, para poder seguir las ligas; en produccion solo el asunto,
//   porque el texto puede traer ligas con token).
// - Los correos de un restaurante salen con su nombre como remitente (misma
//   direccion de MAIL_FROM) y Reply-To al correo de contacto del restaurante.
// - Las pruebas reemplazan el envio con setMailTransport.
import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

let transport = null;
let override = null;

/** Pruebas: fn(message) recibe cada correo en lugar de mandarlo. null = normal. */
export function setMailTransport(fn) {
  override = fn;
}

export const mailConfigured = () => Boolean(env.smtpHost);

function smtp() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpSecure,
      auth: env.smtpUser ? { user: env.smtpUser, pass: env.smtpPass } : undefined,
      // Sin envios colgados si el servidor de correo no responde.
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    });
  }
  return transport;
}

/** Direccion de MAIL_FROM sin el nombre. */
function fromAddress() {
  const m = env.mailFrom.match(/<([^>]+)>/);
  return (m ? m[1] : env.mailFrom).trim();
}

// Nombre de remitente sin caracteres que rompan el encabezado.
const cleanName = (name) => String(name || '').replace(/[\r\n"<>]/g, '').slice(0, 80).trim();

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * HTML sencillo a partir del texto: parrafos y, si hay, un boton.
 * button = { label, url }.
 */
export function simpleHtml({ title, text, button, footer }) {
  const paras = String(text || '').split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
  const btn = button
    ? `<p style="margin:22px 0"><a href="${escapeHtml(button.url)}" style="background:#e85d2a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:bold;display:inline-block">${escapeHtml(button.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f5f5f4;font-family:Arial,Helvetica,sans-serif;color:#1c1917">
<div style="max-width:520px;margin:24px auto;background:#fff;border-radius:16px;padding:28px">
${title ? `<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>` : ''}${paras}${btn}
${footer ? `<p style="margin:24px 0 0;font-size:12px;color:#78716c">${escapeHtml(footer)}</p>` : ''}
</div></body></html>`;
}

/**
 * Manda un correo. Nunca lanza: regresa { sent, error? }.
 * message = { to, subject, text, html?, fromName?, replyTo? }
 */
export async function sendEmail({ to, subject, text, html, fromName, replyTo }) {
  if (!to) return { sent: false, error: 'sin destinatario' };
  const message = {
    from: fromName ? { name: cleanName(fromName), address: fromAddress() } : env.mailFrom,
    to,
    subject: String(subject || '').replace(/[\r\n]+/g, ' ').slice(0, 200),
    text,
    html,
    replyTo: replyTo || undefined,
  };
  try {
    if (override) {
      await override(message);
      return { sent: true };
    }
    if (!mailConfigured()) {
      if (!env.isTest) {
        console.log(`[correo] (sin SMTP) ${to}: ${message.subject}${env.isProduction ? '' : `\n${text}`}`);
      }
      return { sent: false, error: 'SMTP no configurado' };
    }
    await smtp().sendMail(message);
    return { sent: true };
  } catch (err) {
    console.error(`[correo] no se pudo mandar "${message.subject}" a ${to}:`, err.message);
    return { sent: false, error: err.message };
  }
}
