// Formas de pago de los pedidos en linea.
//
// Hoy solo existe "contra_entrega": el cliente paga al recoger o al recibir
// (efectivo o tarjeta) y el cajero lo cobra en el POS con el flujo normal de
// pagos (routes/pos/orders.js), dentro de un turno de caja.
//
// Para conectar una pasarela despues (Mercado Pago, Stripe, Conekta...) se
// registra otro proveedor con la misma forma:
//
//   {
//     code: 'mercadopago',
//     name: 'Pago en línea',
//     // Valida lo que manda el cliente; regresa los campos para la orden.
//     validate(input, { total }) -> { payment_preference, pay_with },
//     // Despues de crear la orden (dentro de la transaccion). Una pasarela
//     // crearia aqui el cobro y regresaria { action: 'redirect', url }; la
//     // orden quedaria pendiente hasta que su webhook confirme el pago.
//     async start({ db, restaurantId, order }) -> { action: 'none' | 'redirect', url? },
//   }
//
// y se habilita en ONLINE_PROVIDERS. El webhook registraria el pago en
// order_payments (con un metodo de pago "en linea" y sin turno de caja, lo
// que requerira ajustar ese esquema cuando llegue).
import { HttpError } from '../utils/http.js';

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
  async start() {
    return { action: 'none' };
  },
};

export const ONLINE_PROVIDERS = { [payOnDelivery.code]: payOnDelivery };
export const DEFAULT_PROVIDER = payOnDelivery.code;

export function getPaymentProvider(code = DEFAULT_PROVIDER) {
  const p = ONLINE_PROVIDERS[code];
  if (!p) throw invalid('Forma de pago no disponible');
  return p;
}

/** Lo que el portal muestra en el checkout. */
export const publicPaymentOptions = () => Object.values(ONLINE_PROVIDERS)
  .map((p) => ({ code: p.code, name: p.name, methods: p.methods }));
