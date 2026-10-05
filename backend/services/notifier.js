// Avisos a restaurantes (facturas, ligas de pago, suspension...).
//
// Todavia no hay correo configurado: el notificador por defecto solo escribe
// en el log. Para mandar correos (o WhatsApp) se instala otro con
// setNotifier({ async send(message) {...} }) sin tocar el resto del codigo.
//
// message = { type, to, subject, text, data }
import { env } from '../config/env.js';

const logNotifier = {
  async send(message) {
    if (env.isTest) return;
    console.log(`[aviso] ${message.type} -> ${message.to || '(sin correo de contacto)'}: ${message.subject}`);
  },
};

let current = logNotifier;

export function setNotifier(notifier) {
  current = notifier || logNotifier;
}

const money = (v) => `$${Number(v || 0).toFixed(2)} MXN`;

const TEMPLATES = {
  factura_generada: (d) => ({
    subject: `Tu mensualidad de NeuronPOS (${d.period}) por ${money(d.amount)}`,
    text: `Hola ${d.restaurant}, ya está disponible tu cobro de ${money(d.amount)}. Fecha límite: ${d.due_date}.${d.url ? ` Paga aquí: ${d.url}` : ''}`,
  }),
  liga_de_pago: (d) => ({
    subject: `Liga de pago de tu mensualidad (${d.period})`,
    text: `Hola ${d.restaurant}, puedes pagar ${money(d.amount)} aquí: ${d.url}`,
  }),
  factura_vencida: (d) => ({
    subject: 'Tu mensualidad de NeuronPOS está vencida',
    text: `Hola ${d.restaurant}, tu pago de ${money(d.amount)} venció el ${d.due_date}. Si no se paga, el servicio se suspende el ${d.suspends_on}.`,
  }),
  factura_pagada: (d) => ({
    subject: 'Recibimos tu pago, gracias',
    text: `Hola ${d.restaurant}, recibimos tu pago de ${money(d.amount)} (${d.period}).`,
  }),
  restaurante_suspendido: (d) => ({
    subject: 'Tu servicio de NeuronPOS está suspendido',
    text: `Hola ${d.restaurant}, suspendimos el servicio por falta de pago. Entra a Mi suscripción para pagar y reactivarlo al instante.`,
  }),
  restaurante_reactivado: (d) => ({
    subject: 'Tu servicio de NeuronPOS está activo de nuevo',
    text: `Hola ${d.restaurant}, recibimos tu pago y tu servicio ya está activo.`,
  }),
  pago_tardio: (d) => ({
    subject: 'Pago en línea recibido de un pedido cancelado',
    text: `El pedido #${d.folio} se canceló por falta de pago, pero Clip confirmó el pago después (${money(d.amount)}). Reembolsa desde tu panel de Clip.`,
  }),
};

/** Nunca lanza: un aviso fallido no debe romper el cobro. */
export async function notify(type, { to = null, ...data } = {}) {
  const tpl = TEMPLATES[type];
  const { subject, text } = tpl ? tpl(data) : { subject: type, text: '' };
  try {
    await current.send({ type, to, subject, text, data });
  } catch (err) {
    console.error(`[aviso] no se pudo enviar ${type}:`, err.message);
  }
}
