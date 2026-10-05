// Clip simulado para las pruebas: reemplaza el transporte HTTP del cliente
// (services/clip/client.js). Nunca se llama a la API real.
//
// Cada checkout recuerda con que credenciales (header Authorization) se
// creo: un GET con las credenciales de otra cuenta responde 404, igual que
// Clip real con cuentas distintas.
export const basicAuth = (apiKey, secretKey) => `Basic ${Buffer.from(`${apiKey}:${secretKey}`).toString('base64')}`;

export function createClipMock() {
  const checkouts = new Map();
  const calls = [];
  let seq = 0;
  const mock = {
    checkouts,
    calls,
    failCreate: false,
    created: () => calls.filter((c) => c.method === 'POST'),
    lastCreated: () => mock.created().at(-1),
    async transport({ method, url, headers, body }) {
      calls.push({ method, url, auth: headers.Authorization, body });
      if (method === 'POST' && url.endsWith('/v2/checkout')) {
        if (mock.failCreate) return { status: 500, data: { message: 'falla simulada' } };
        seq += 1;
        const id = `chk_${seq}_${Math.random().toString(36).slice(2, 8)}`;
        checkouts.set(id, {
          auth: headers.Authorization, id, amount: body.amount, currency: body.currency, status: 'CHECKOUT_CREATED', body,
        });
        return {
          status: 200,
          data: {
            payment_request_id: id,
            payment_request_url: `https://pago.clip.test/${id}`,
            expires_at: new Date(Date.now() + 3 * 86400000).toISOString(),
          },
        };
      }
      const m = url.match(/\/v2\/checkout\/([^/?]+)$/);
      if (method === 'GET' && m) {
        const c = checkouts.get(decodeURIComponent(m[1]));
        if (!c || c.auth !== headers.Authorization) return { status: 404, data: { message: 'Not found' } };
        return {
          status: 200,
          data: {
            payment_request_id: c.id, amount: c.amount, currency: c.currency, status: c.status,
            ...(c.status === 'CHECKOUT_COMPLETED' ? { transaction_id: `tx_${c.id}` } : {}),
          },
        };
      }
      return { status: 404, data: null };
    },
    pay(id) { checkouts.get(id).status = 'CHECKOUT_COMPLETED'; },
    expire(id) { checkouts.get(id).status = 'CHECKOUT_EXPIRED'; },
    /** Cambia lo que Clip reporta como monto (para probar la validacion). */
    tamper(id, amount) { checkouts.get(id).amount = amount; },
  };
  return mock;
}
