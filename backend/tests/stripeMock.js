// Stripe simulado para las pruebas: reemplaza el transporte HTTP del cliente
// (services/stripe/client.js). Nunca se llama a la API real.
//
// Cada sesion recuerda con que llave se creo: un GET con otra llave responde
// 404, igual que Stripe real con cuentas distintas.
import crypto from 'node:crypto';

export function createStripeMock() {
  const sessions = new Map();
  const calls = [];
  let seq = 0;
  const mock = {
    sessions,
    calls,
    created: () => calls.filter((c) => c.method === 'POST'),
    lastCreated: () => mock.created().at(-1),
    async transport({ method, url, headers, body }) {
      calls.push({ method, url, auth: headers.Authorization, body });
      if (method === 'POST' && url.endsWith('/v1/checkout/sessions')) {
        seq += 1;
        const id = `cs_test_${seq}`;
        const s = {
          id,
          object: 'checkout.session',
          url: `https://checkout.stripe.test/c/pay/${id}`,
          amount_total: body.line_items[0].price_data.unit_amount,
          currency: body.line_items[0].price_data.currency,
          status: 'open',
          payment_status: 'unpaid',
          payment_intent: null,
          expires_at: body.expires_at,
          metadata: body.metadata,
          auth: headers.Authorization,
        };
        sessions.set(id, s);
        const { auth, ...data } = s;
        return { status: 200, data };
      }
      const m = url.match(/\/v1\/checkout\/sessions\/([^/?]+)$/);
      if (method === 'GET' && m) {
        const s = sessions.get(decodeURIComponent(m[1]));
        if (!s || s.auth !== headers.Authorization) return { status: 404, data: { error: { message: 'No such checkout.session' } } };
        const { auth, ...data } = s;
        return { status: 200, data };
      }
      return { status: 404, data: { error: { message: 'ruta simulada desconocida' } } };
    },
    pay(id) {
      Object.assign(sessions.get(id), { status: 'complete', payment_status: 'paid', payment_intent: `pi_${id}` });
    },
    expire(id) {
      Object.assign(sessions.get(id), { status: 'expired' });
    },
  };
  return mock;
}

/** Header Stripe-Signature valido para un cuerpo crudo. */
export function stripeSignature(raw, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
}
