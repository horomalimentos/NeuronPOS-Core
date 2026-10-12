// Pruebas unitarias del cliente de Stripe: liga de pago, estados y firma del
// webhook. Nunca se llama a la API real (transporte simulado).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import {
  createStripeClient, formEncode, normalizeStripeStatus, setStripeTransport, verifyStripeSignature,
} from '../services/stripe/client.js';

afterEach(() => setStripeTransport());

test('aplana objetos con la notacion de Stripe', () => {
  const s = formEncode({ a: 1, b: { c: 'x', d: [{ e: 2 }] }, f: undefined }).toString();
  assert.equal(decodeURIComponent(s), 'a=1&b[c]=x&b[d][0][e]=2');
});

test('crea la liga en centavos MXN con la llave secreta y regresa id y url', async () => {
  let req;
  setStripeTransport(async (r) => {
    req = r;
    return { status: 200, data: { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1', expires_at: 1900000000 } };
  });
  const link = await createStripeClient({ secretKey: 'sk_test_x' }).createCheckout({
    amount: 199.9, description: 'Mensualidad', redirect: { success: 'https://a/ok', cancel: 'https://a/no' }, metadata: { invoice: '7' },
  });
  assert.equal(req.headers.Authorization, 'Bearer sk_test_x');
  assert.equal(req.body.line_items[0].price_data.unit_amount, 19990);
  assert.equal(req.body.line_items[0].price_data.currency, 'mxn');
  assert.equal(link.checkout_id, 'cs_test_1');
  assert.equal(link.payment_url, 'https://checkout.stripe.com/c/pay/cs_test_1');
});

test('sin llave o con error de Stripe lanza StripeError', async () => {
  assert.throws(() => createStripeClient({}), { code: 'STRIPE_NOT_CONFIGURED' });
  setStripeTransport(async () => ({ status: 401, data: { error: { message: 'Invalid API Key' } } }));
  await assert.rejects(
    createStripeClient({ secretKey: 'sk_bad' }).createCheckout({ amount: 10, description: 'x', redirect: {} }),
    { code: 'STRIPE_AUTH_FAILED' },
  );
});

test('en pruebas nunca usa la API real', async () => {
  const was = env.isTest;
  env.isTest = true;
  try {
    await assert.rejects(createStripeClient({ secretKey: 'sk' }).createCheckout({ amount: 10, description: 'x', redirect: {} }),
      { code: 'STRIPE_DISABLED_IN_TESTS' });
  } finally {
    env.isTest = was;
  }
});

test('normaliza el estado de la sesion', () => {
  assert.equal(normalizeStripeStatus({ status: 'complete', payment_status: 'paid' }), 'completed');
  assert.equal(normalizeStripeStatus({ status: 'open', payment_status: 'unpaid' }), 'pending');
  assert.equal(normalizeStripeStatus({ status: 'expired', payment_status: 'unpaid' }), 'expired');
  assert.equal(normalizeStripeStatus(null), 'pending');
});

test('firma del webhook: t y v1 con HMAC-SHA256 y tolerancia de 5 minutos', () => {
  const secret = 'whsec_abc';
  const body = Buffer.from('{"id":"evt_1"}');
  const now = Date.now();
  const t = Math.floor(now / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  assert.equal(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, { now }), true);
  assert.equal(verifyStripeSignature(body, `t=${t},v1=deadbeef,v1=${sig}`, secret, { now }), true);
  assert.equal(verifyStripeSignature(body, `t=${t},v1=${sig}`, 'whsec_otro', { now }), false);
  assert.equal(verifyStripeSignature(Buffer.from('{}'), `t=${t},v1=${sig}`, secret, { now }), false);
  assert.equal(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, { now: now + 600000 }), false);
  assert.equal(verifyStripeSignature(body, undefined, secret), false);
});
