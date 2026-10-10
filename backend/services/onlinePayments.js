// Formas de pago de los pedidos en linea.
//
// - "contra_entrega": el cliente paga al recoger o al recibir (efectivo o
//   tarjeta) y el cajero lo cobra en el POS con el flujo normal de pagos
//   (routes/pos/orders.js), dentro de un turno de caja.
// - "clip" (fase 3): pago en linea con la cuenta de Clip del restaurante. El
//   pedido queda esperando el pago (no llega al POS) y el cliente va a la liga
//   de Clip; el webhook o el reconciliador registran el pago
//   (services/restaurantPayments.js). Solo se ofrece si el restaurante
//   configuro sus credenciales y encendio "pago en linea".
// - "monedero": todo el pedido con el saldo del monedero del cliente (modulo
//   'monedero'; necesita sesion). Se cobra al crear el pedido, que nace pagado.
//
// Cada proveedor tiene la misma forma:
//   {
//     code, name, online (true = se paga antes de preparar),
//     validate(input, { total }) -> { payment_preference, pay_with },
//     async start({ db, tenant, order, creds, customer }) -> { action: 'none' | 'redirect', url? },
//   }
import { HttpError } from '../utils/http.js';
import { acceptOnlineOrder, getOnlineSettings } from './online.js';
import { createOrderCheckout } from './restaurantPayments.js';
import { payWebOrderWithWallet } from './wallet.js';

const invalid = (msg) => new HttpError(400, msg, 'INVALID_PAYMENT');

const payOnDelivery = {
  code: 'contra_entrega',
  name: 'Pago al recibir',
  methods: [
    { code: 'efectivo', name: 'Efectivo' },
    { code: 'tarjeta', name: 'Tarjeta (terminal al entregar)' },
  ],
  validate(input = {}, { total }) {
    const method = input.method ?? 'efectivo';
    if (!['efectivo', 'tarjeta'].includes(method)) throw invalid('Elige pagar en efectivo o con tarjeta');
    let payWith = null;
    if (method === 'efectivo' && input.pay_with !== undefined && input.pay_with !== null && input.pay_with !== '') {
      const n = Number(input.pay_with);
      if (!Number.isFinite(n) || n < 0 || n > 999999) throw invalid('El monto con el que pagas no es valido');
      payWith = Math.round(n * 100) / 100;
      if (payWith < Number(total)) throw invalid('El monto con el que pagas debe cubrir el total');
    }
    return { payment_preference: method, pay_with: payWith };
  },
  online: false,
  async start() {
    return { action: 'none' };
  },
};

const clipOnline = {
  code: 'clip',
  name: 'Pagar en línea con Clip',
  online: true,
  methods: [{ code: 'tarjeta', name: 'Tarjeta de crédito o débito' }],
  validate() {
    return { payment_preference: null, pay_with: null };
  },
  async start({ db, tenant, order, creds }) {
    return createOrderCheckout(db, tenant, order, creds);
  },
};

const walletPay = {
  code: 'monedero',
  name: 'Pagar con mi monedero',
  online: true,
  needsCustomer: true,
  methods: [{ code: 'monedero', name: 'Saldo del monedero' }],
  validate() {
    return { payment_preference: null, pay_with: null };
  },
  async start({ db, tenant, order, customer }) {
    await payWebOrderWithWallet(db, tenant.id, order, customer.id);
    const settings = await getOnlineSettings(db, tenant.id);
    if (settings.auto_accept) await acceptOnlineOrder(db, tenant.id, order.id, { prepMinutes: settings.prep_time_minutes });
    return { action: 'none', paid: true };
  },
};

export const ONLINE_PROVIDERS = {
  [payOnDelivery.code]: payOnDelivery, [clipOnline.code]: clipOnline, [walletPay.code]: walletPay,
};
export const DEFAULT_PROVIDER = payOnDelivery.code;

/**
 * clipAvailable: el restaurante tiene Clip configurado y "pago en linea"
 * encendido. walletAvailable: modulo monedero vigente con pago en linea.
 */
export function getPaymentProvider(code = DEFAULT_PROVIDER, { clipAvailable = false, walletAvailable = false } = {}) {
  const p = ONLINE_PROVIDERS[code];
  if (!p || (p.code === 'clip' && !clipAvailable) || (p.code === 'monedero' && !walletAvailable)) {
    throw invalid('Forma de pago no disponible');
  }
  return p;
}

/** Lo que el portal muestra en el checkout. */
export const publicPaymentOptions = ({ clipAvailable = false, walletAvailable = false } = {}) => Object.values(ONLINE_PROVIDERS)
  .filter((p) => (p.code !== 'clip' || clipAvailable) && (p.code !== 'monedero' || walletAvailable))
  .map((p) => ({ code: p.code, name: p.name, online: p.online, methods: p.methods, needs_customer: Boolean(p.needsCustomer) }));
