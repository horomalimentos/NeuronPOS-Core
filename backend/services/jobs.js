// Jobs en segundo plano (los arranca server.js; las pruebas los llaman
// directamente con un "now" controlado).
//
//   - Cobro de suscripciones (cada hora): facturas del periodo, pruebas
//     vencidas, vencimientos y suspensiones. Solo con BILLING_AUTO=true.
//   - Conciliacion con Clip (cada 5 min): ligas pendientes, por si un
//     webhook no llego.
//   - Pedidos sin pagar (cada minuto): cancela los que pasaron su tiempo.
//   - Pedidos programados (cada minuto): entran a cocina antes de su hora.
//   - Notificaciones push (cada 30 s): respaldo del LISTEN; limpieza cada hora.
//   - Avisos por WhatsApp de pedidos del bot (cada 10 s); limpieza cada hora.
//   - Restaurantes con POS propio (Horom): menu cada 10 min, reenvio de
//     pedidos de Nayo cada 10 s y su estado (listo/cancelado) cada 20 s.
//   - Empleado del mes (cada hora): desde el dia 1 cierra el mes anterior de
//     los restaurantes con cierre automatico (idempotente).
//
// Con un solo proceso (pm2, instances: 1) no se encima nada; el ciclo de
// cobro ademas toma un advisory lock de Postgres.
import { env } from '../config/env.js';
import { reconcilePendingCheckouts } from './clip/reconcile.js';
import { cleanupPush, dispatchPushOutbox, startPushListener } from './push.js';
import { cleanupNayoPush, dispatchNayoPush, insistNayoPush, startNayoPushListener } from './nayoPush.js';
import { releaseScheduledOrders } from './scheduledOrders.js';
import { reconcilePendingMarketplaceCheckouts } from './marketplaceMoney.js';
import { expireUnpaidOrders } from './restaurantPayments.js';
import { forwardExternalOrders, pollExternalOrders, syncExternalMenus } from './externalPos.js';
import { runRecognitionCycle } from './rh/recognition.js';
import { runBillingCycle } from './subscriptions.js';
import { cleanupWhatsApp, dispatchWhatsAppOutbox } from './whatsapp/notify.js';

function every(name, ms, fn) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      console.error(`[job ${name}]`, err.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, ms);
  timer.unref();
  setTimeout(tick, 5000).unref();
  return timer;
}

export function startJobs() {
  if (!env.jobsEnabled) return [];
  const timers = [
    every('pagos-vencidos', 60 * 1000, () => expireUnpaidOrders()),
    every('conciliar-clip', 5 * 60 * 1000, () => reconcilePendingCheckouts()),
    every('delivery-clip', 2 * 60 * 1000, () => reconcilePendingMarketplaceCheckouts()),
    every('empleado-del-mes', 60 * 60 * 1000, () => runRecognitionCycle()),
    every('pedidos-programados', 60 * 1000, () => releaseScheduledOrders()),
    every('push', 30 * 1000, () => dispatchPushOutbox()),
    every('push-limpieza', 60 * 60 * 1000, () => cleanupPush()),
    every('nayo-push', 30 * 1000, () => dispatchNayoPush()),
    every('nayo-push-insistir', 5 * 1000, () => insistNayoPush()),
    every('nayo-push-limpieza', 60 * 60 * 1000, () => cleanupNayoPush()),
    every('whatsapp', 10 * 1000, () => dispatchWhatsAppOutbox()),
    every('whatsapp-limpieza', 60 * 60 * 1000, () => cleanupWhatsApp()),
    every('pos-externo-menu', 10 * 60 * 1000, () => syncExternalMenus()),
    every('pos-externo-pedidos', 10 * 1000, () => forwardExternalOrders()),
    every('pos-externo-estado', 20 * 1000, () => pollExternalOrders()),
  ];
  startPushListener();
  startNayoPushListener();
  if (env.billingAuto) timers.push(every('cobro', 60 * 60 * 1000, () => runBillingCycle()));
  console.log(`Jobs activos: pedidos sin pagar, conciliacion con Clip (restaurantes y Delivery), pedidos programados, notificaciones push, avisos por WhatsApp, empleado del mes${env.billingAuto ? ', cobro de suscripciones' : ''}.`);
  return timers;
}
