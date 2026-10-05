// Jobs en segundo plano (los arranca server.js; las pruebas los llaman
// directamente con un "now" controlado).
//
//   - Cobro de suscripciones (cada hora): facturas del periodo, pruebas
//     vencidas, vencimientos y suspensiones. Solo con BILLING_AUTO=true.
//   - Conciliacion con Clip (cada 5 min): ligas pendientes, por si un
//     webhook no llego.
//   - Pedidos sin pagar (cada minuto): cancela los que pasaron su tiempo.
//
// Con un solo proceso (pm2, instances: 1) no se encima nada; el ciclo de
// cobro ademas toma un advisory lock de Postgres.
import { env } from '../config/env.js';
import { reconcilePendingCheckouts } from './clip/reconcile.js';
import { expireUnpaidOrders } from './restaurantPayments.js';
import { runBillingCycle } from './subscriptions.js';

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
  ];
  if (env.billingAuto) timers.push(every('cobro', 60 * 60 * 1000, () => runBillingCycle()));
  console.log(`Jobs activos: pedidos sin pagar, conciliacion con Clip${env.billingAuto ? ', cobro de suscripciones' : ''}.`);
  return timers;
}
