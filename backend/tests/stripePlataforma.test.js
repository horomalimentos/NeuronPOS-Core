// Stripe con la cuenta de la plataforma contra Postgres, con Stripe y Clip
// simulados. Cubre: con Stripe configurado las ligas nuevas de mensualidad y
// de Nayo se crean con Stripe; el webhook firmado solo dispara la consulta
// server-to-server; una firma invalida se rechaza; la factura queda pagada
// "Stripe" y el pedido de Nayo llega al restaurante; una liga de Clip creada
// antes de cambiar a Stripe se sigue conciliando con Clip.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createClipMock } from './clipMock.js';
import { SKIP_DB, createRestaurant, ownerToken, setupDb, nayoShopper } from './helpers.js';
import { createStripeMock, stripeSignature } from './stripeMock.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));
const CENTRO = { latitude: 31.7389, longitude: -106.4870 };
const CERCA = { latitude: 31.7569, longitude: -106.4870 };
const WHSEC = 'whsec_pruebas';

describe('Stripe de la plataforma', { skip: SKIP_DB }, () => {
  let ctx; let owner; let stripe; let clip; let env; let subs; let A; let B;
  const api = (token, method, path, body) => ctx.request(method, path, { token, body });
  const panel = (method, path, body) => api(owner, method, `/api/platform${path}`, body);
  const invoicesOf = async (r) => (await panel('GET', `/invoices?restaurant_id=${r.id}`)).body.invoices;
  const event = (id, type = 'checkout.session.completed') => ({ id: `evt_${id}`, type, data: { object: { id, object: 'checkout.session' } } });
  const webhook = (body, { secret = WHSEC, bad = false } = {}) => {
    const raw = JSON.stringify(body);
    return ctx.request('POST', '/api/webhooks/stripe/plataforma', {
      body, headers: { 'stripe-signature': stripeSignature(bad ? `${raw} ` : raw, secret) },
    });
  };

  before(async () => {
    ctx = await setupDb();
    ({ env } = await import('../config/env.js'));
    subs = await import('../services/subscriptions.js');
    stripe = createStripeMock();
    (await import('../services/stripe/client.js')).setStripeTransport((req) => stripe.transport(req));
    clip = createClipMock();
    (await import('../services/clip/client.js')).setClipTransport((req) => clip.transport(req));
    owner = await ownerToken(ctx);
    await panel('PUT', '/modules/pos', { monthly_price_mxn: 499.5 });
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['pos'] });
    await subs.runBillingCycle({ now: new Date() });
  });
  after(() => {
    if (env) Object.assign(env, { stripeSecretKey: '', stripeWebhookSecret: '' });
    return ctx?.close();
  });

  test('una liga de Clip creada antes de Stripe se sigue conciliando con Clip', async () => {
    const [inv] = await invoicesOf(B);
    assert.match(inv.payment_url, /clip/);
    Object.assign(env, { stripeSecretKey: 'sk_test_plataforma', stripeWebhookSecret: WHSEC });
    clip.pay(inv.payment_url.split('/').pop());
    const v = await api(B.token, 'POST', `/api/subscription/invoices/${inv.id}/verify`);
    assert.equal(v.body.invoice.status, 'paid');
    assert.equal(v.body.invoice.paid_method, 'clip');
  });

  test('Panel: Stripe configurado y elegido, sin mostrar las llaves', async () => {
    const s = (await panel('GET', '/settings')).body.settings;
    assert.equal(s.provider, 'stripe');
    assert.deepEqual(s.stripe, {
      configured: true, test_mode: true, webhook_secret_configured: true,
      webhook_url: 'https://api.neuronpos.test/api/webhooks/stripe/plataforma',
    });
    assert.ok(!JSON.stringify(s).includes('sk_test_plataforma'));
    assert.ok(!JSON.stringify(s).includes(WHSEC));
  });

  test('mensualidad: liga de Stripe en centavos MXN; el webhook firmado la marca pagada con Stripe', async () => {
    const [inv] = await invoicesOf(A);
    // La liga de Clip del ciclo vence: se fuerza una nueva con Stripe.
    await ctx.withPlatform((db) => db.query("UPDATE clip_checkouts SET expires_at = now() WHERE invoice_id = $1", [inv.id]));
    const pay = await api(A.token, 'POST', `/api/subscription/invoices/${inv.id}/pay`);
    assert.equal(pay.status, 200, JSON.stringify(pay.body));
    assert.match(pay.body.payment_url, /^https:\/\/checkout\.stripe\.test\//);
    const req = stripe.lastCreated();
    assert.equal(req.auth, 'Bearer sk_test_plataforma');
    assert.equal(req.body.line_items[0].price_data.unit_amount, 49950);
    assert.match(req.body.success_url, /\/admin\/suscripcion\?factura=.+&pago=ok$/);
    const id = pay.body.payment_url.split('/').pop();

    // Firma invalida: 401 y no se consulta nada.
    assert.equal((await webhook(event(id), { bad: true })).status, 401);
    // Sin pagar: el evento no basta.
    assert.equal((await webhook(event(id))).status, 200);
    assert.equal((await invoicesOf(A))[0].status, 'pending');

    stripe.pay(id);
    await webhook(event(id));
    await webhook(event(id)); // dos veces: se aplica una
    const paid = (await invoicesOf(A))[0];
    assert.equal(paid.status, 'paid');
    assert.equal(paid.paid_method, 'stripe');
    assert.equal(paid.paid_reference, `pi_${id}`);
    const ev = (await ctx.withPlatform((db) => db.query(
      'SELECT matched, signature_valid FROM clip_webhook_events WHERE checkout_id = $1 ORDER BY id', [id],
    ))).rows;
    assert.deepEqual(ev.map((e) => [e.signature_valid, e.matched]), [[false, false], [true, true], [true, true], [true, true]]);
  });

  test('Nayo: pedido con tarjeta por Stripe (vence en 30 min) llega al restaurante al pagarse', async () => {
    const pub = (method, path, body) => ctx.request(method, `/api/marketplace${path}`, { body });
    const r = await pub('POST', '/restaurants', {
      name: 'Tacos Pepa', phone: '6561112222', address: 'Av. Juarez 100', location: CENTRO,
      admin: { name: 'Pepa', email: 'pepa@tacos.test', password: 'clave-segura-1' },
    });
    const login = await ctx.request('POST', '/api/auth/login', { slug: r.body.restaurant.slug, body: { email: 'pepa@tacos.test', password: 'clave-segura-1' } });
    const R = login.body.token;
    const branchId = (await api(R, 'GET', '/api/marketplace/listings')).body.listings[0].branch_id;
    const cat = (await api(R, 'POST', '/api/pos/categories', { name: 'Tacos' })).body.category;
    const taco = (await api(R, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco', price: 25 })).body.item;
    await api(R, 'PUT', `/api/branches/${branchId}/hours`, { hours: ALL_DAY });
    await api(R, 'PUT', `/api/marketplace/listings/${branchId}`, { published: true });
    await panel('POST', `/marketplace/listings/${branchId}/approval`, { status: 'aprobado' });
    const d = await pub('POST', '/drivers', {
      name: 'Juan', email: 'juan@moto.test', password: 'clave-segura-7', phone: '6560000000', vehicle: 'Moto', base: CERCA, radius_km: 4,
    });
    await panel('POST', `/marketplace/drivers/${d.body.driver.id}/review`, { status: 'aprobado' });
    await api(d.body.token, 'POST', '/api/fleet/duty', { on_duty: true });

    assert.equal((await pub('GET', '/info')).body.card_payments, true);
    const shopper = await nayoShopper(ctx, {
      name: 'Maria Lopez', email: 'maria@cliente.test', phone: '6561234567', password: 'clave-cliente-1',
    });
    const res = await ctx.request('POST', '/api/marketplace/orders', { token: shopper, body: {
      branch_id: branchId, items: [{ menu_item_id: taco.id, quantity: 4 }], location: CERCA, payment_method: 'tarjeta',
      customer: { name: 'Maria Lopez', phone: '656 123 4567' }, address: { address: 'Calle Uno 123, Centro' },
    } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const o = res.body.order;
    assert.equal(o.status, 'pago_pendiente');
    assert.match(o.payment_url, /^https:\/\/checkout\.stripe\.test\//);
    const req = stripe.lastCreated();
    assert.match(req.body.success_url, /\/nayo\/pedido\/.+\?pago=ok$/);
    const ttl = req.body.expires_at - Date.now() / 1000;
    assert.ok(ttl > 29 * 60 && ttl <= 30 * 60, `vence en 30 min (${ttl})`);

    const id = o.payment_url.split('/').pop();
    stripe.pay(id);
    assert.equal((await webhook(event(id))).status, 200);
    assert.equal((await pub('GET', `/orders/${o.token}`)).body.order.status, 'aceptado');
    const chk = (await ctx.withPlatform((db) => db.query('SELECT provider, clip_reference FROM marketplace_checkouts WHERE checkout_id = $1', [id]))).rows[0];
    assert.deepEqual(chk, { provider: 'stripe', clip_reference: `pi_${id}` });
  });
});
