// Stripe con la cuenta de CADA restaurante contra Postgres, con Stripe
// simulado. Cubre: las llaves se validan, se guardan cifradas y nunca salen
// por la API; con Stripe el pedido en linea del portal y la recarga del
// monedero se cobran con la llave del restaurante; el webhook del
// restaurante exige su firma y solo dispara la consulta server-to-server; un
// restaurante no concilia las ligas de otro; quitar Stripe deja Clip o apaga
// el pago en linea.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORM_DOMAIN, SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';
import { createStripeMock, stripeSignature } from './stripeMock.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));
const KEYS = { stripe_secret_key: 'sk_test_alfa_123456', stripe_webhook_secret: 'whsec_alfa_789012' };

describe('Stripe de cada restaurante', { skip: SKIP_DB }, () => {
  let ctx; let owner; let stripe; let A; let B; let branch; let taco;
  const hostA = `alfa.${PLATFORM_DOMAIN}`;
  const staff = (who, method, path, body) => ctx.request(method, path, { token: who.token, body });
  const portal = (method, path, body, token) => ctx.request(method, `/api/portal${path}`, { host: hostA, body, token });
  const event = (id) => ({ id: `evt_${id}`, type: 'checkout.session.completed', data: { object: { id, object: 'checkout.session' } } });
  const webhook = (ref, body, secret, { bad = false } = {}) => {
    const raw = JSON.stringify(body);
    return ctx.request('POST', `/api/webhooks/stripe/r/${ref}`, {
      body, headers: { 'stripe-signature': stripeSignature(bad ? `${raw} ` : raw, secret) },
    });
  };

  before(async () => {
    ctx = await setupDb();
    stripe = createStripeMock();
    (await import('../services/stripe/client.js')).setStripeTransport((req) => stripe.transport(req));
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos', 'portal', 'monedero'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['pos', 'portal'] });
    branch = (await staff(A, 'GET', '/api/branches')).body.branches[0];
    const cat = (await staff(A, 'POST', '/api/pos/categories', { name: 'Tacos' })).body.category;
    taco = (await staff(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco', price: 100 })).body.item;
    await staff(A, 'PUT', `/api/branches/${branch.id}/hours`, { hours: ALL_DAY });
    await staff(A, 'PATCH', '/api/online/settings', { enabled: true });
  });
  after(() => ctx?.close());

  test('llaves de Stripe: se validan, se guardan cifradas y nunca salen por la API', async () => {
    assert.equal((await staff(A, 'PUT', '/api/online/payments', { stripe_secret_key: 'pk_test_publica123' })).body.code, 'INVALID_FIELD');
    assert.equal((await staff(A, 'PUT', '/api/online/payments', { stripe_webhook_secret: 'secreto-sin-prefijo' })).body.code, 'INVALID_FIELD');
    const res = await staff(A, 'PUT', '/api/online/payments', { ...KEYS, online_payment_enabled: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const p = res.body.payments;
    assert.equal(p.provider, 'stripe');
    assert.deepEqual(p.stripe, {
      configured: true, webhook_secret_configured: true, webhook_url: `https://api.neuronpos.test/api/webhooks/stripe/r/${A.id}`,
    });
    assert.equal(p.available, true);
    assert.ok(!JSON.stringify(res.body).includes(KEYS.stripe_secret_key));
    const row = (await ctx.withTenant(A.id, (db) => db.query('SELECT stripe_secret_key_enc FROM restaurant_payment_settings WHERE restaurant_id = $1', [A.id]))).rows[0];
    assert.match(row.stripe_secret_key_enc, /^v1:/);
    const cfg = (await portal('GET', '/config')).body;
    const online = cfg.payment_options.find((o) => o.code === 'clip');
    assert.equal(online.name, 'Pagar en línea con tarjeta');
  });

  test('pedido en linea con Stripe: la liga vence con el tiempo para pagar y el webhook firmado lo paga', async () => {
    const res = await portal('POST', '/orders', {
      branch_id: branch.id, order_type: 'para_llevar', items: [{ menu_item_id: taco.id, quantity: 2 }],
      customer: { name: 'Clienta', phone: '656 123 4567' }, payment: { provider: 'clip' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.payment.url, /^https:\/\/checkout\.stripe\.test\//);
    const o = res.body.order;
    const call = stripe.lastCreated();
    assert.equal(call.auth, `Bearer ${KEYS.stripe_secret_key}`);
    assert.equal(call.body.line_items[0].price_data.unit_amount, 20000);
    assert.equal(call.body.success_url, `https://alfa.${PLATFORM_DOMAIN}/pago/resultado?pedido=${o.token}&r=ok`);
    // El tiempo para pagar por defecto es menor a 30 min: Stripe usa su minimo.
    const ttl = call.body.expires_at - Date.now() / 1000;
    assert.ok(ttl > 29 * 60 && ttl <= 30 * 60 + 5, `ttl ${ttl}`);

    const id = res.body.payment.url.split('/').pop();
    stripe.pay(id);
    // B no puede conciliar las ligas de A ni con la firma de A.
    const otro = await webhook(B.id, event(id), KEYS.stripe_webhook_secret);
    assert.equal(otro.status, 200);
    assert.equal((await staff(A, 'GET', `/api/pos/orders/${o.id}`)).body.order.online_payment_status, 'pendiente');
    assert.equal((await webhook('alfa', event(id), KEYS.stripe_webhook_secret, { bad: true })).status, 401);
    assert.equal((await webhook('alfa', event(id), KEYS.stripe_webhook_secret)).status, 200);
    await webhook(A.id, event(id), KEYS.stripe_webhook_secret);
    const detail = (await staff(A, 'GET', `/api/pos/orders/${o.id}`)).body.order;
    assert.equal(detail.online_payment_status, 'pagado');
    assert.equal(detail.payments.length, 1);
    assert.equal(detail.payments[0].reference, `pi_${id}`);
  });

  test('recarga del monedero con el Stripe del restaurante', async () => {
    const w = await staff(A, 'PATCH', '/api/wallet/settings', { topups_enabled: true, web_enabled: true });
    assert.ok([200, 201].includes(w.status), JSON.stringify(w.body));
    const reg = await portal('POST', '/auth/register', { name: 'Clienta', email: 'clienta@alfa.test', phone: '6561234567', password: 'clave-cliente-1' });
    assert.ok([200, 201].includes(reg.status), JSON.stringify(reg.body));
    const topup = await portal('POST', '/me/wallet/topup', { amount: 200 }, reg.body.token);
    assert.equal(topup.status, 201, JSON.stringify(topup.body));
    assert.match(topup.body.payment.url, /^https:\/\/checkout\.stripe\.test\//);
    const id = topup.body.payment.url.split('/').pop();
    stripe.pay(id);
    const v = await portal('POST', '/me/wallet/verify', {}, reg.body.token);
    assert.equal(v.body.balance, 200);
  });

  test('quitar Stripe sin Clip apaga el pago en linea', async () => {
    const res = await staff(A, 'PUT', '/api/online/payments', { remove_stripe: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.payments.stripe.configured, false);
    assert.equal(res.body.payments.provider, null);
    assert.equal(res.body.payments.online_payment_enabled, false);
  });
});
