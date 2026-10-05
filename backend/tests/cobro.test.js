// Fase 3 de punta a punta contra Postgres, con Clip simulado (tests/clipMock.js).
//
// A) Suscripcion: generacion de facturas (precio especial, descuento,
//    idempotencia), liga de Clip con la cuenta de la plataforma, webhook con
//    firma, vencimiento y suspension tras la gracia, reactivacion al pagar
//    (Clip o manual), pruebas que terminan, reenviar liga y reconciliador.
// B) Pedidos pagados en linea con la cuenta de Clip de cada restaurante:
//    credenciales cifradas que nunca salen por la API, flujo pedido -> pago ->
//    aceptar -> cocina -> entregar, pago al recibir intacto, webhooks que no
//    cruzan restaurantes y cancelacion por falta de pago.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { basicAuth, createClipMock } from './clipMock.js';
import { PLATFORM_DOMAIN, SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

const DAY = 86400000;
const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));
const ALFA_CREDS = { clip_api_key: 'alfa-api-key-123', clip_secret_key: 'alfa-secret-456', clip_webhook_secret: 'alfa-whsec-789' };

describe('fase 3: cobro con Clip', { skip: SKIP_DB }, () => {
  let ctx; let owner; let clip; let subs; let jobs; let pay; let sign;
  let A; let B; let D; let T;
  // Se fija despues de crear los restaurantes (los modulos cuentan desde su alta).
  let now;
  const later = (days) => new Date(now.getTime() + days * DAY);
  const staff = (who, method, path, body) => ctx.request(method, path, { token: who.token ?? who, body });
  const panel = (method, path, body) => ctx.request(method, `/api/platform${path}`, { token: owner, body });
  const checkoutIdOf = (url) => url.split('/').pop();
  const webhook = (path, body, secret, { badSig = false } = {}) => {
    const raw = JSON.stringify(body);
    const headers = {};
    if (secret) headers['x-clip-signature'] = badSig ? sign(`${raw} `, secret) : sign(raw, secret);
    return ctx.request('POST', `/api/webhooks/clip${path}`, { body, headers });
  };
  const invoicesOf = async (r) => (await panel('GET', `/invoices?restaurant_id=${r.id}`)).body.invoices;
  const restaurantStatus = async (r) => (await panel('GET', `/restaurants/${r.id}`)).body.restaurant.status;

  before(async () => {
    ctx = await setupDb();
    const client = await import('../services/clip/client.js');
    ({ signClipBody: sign } = await import('../services/clip/status.js'));
    subs = await import('../services/subscriptions.js');
    jobs = await import('../services/clip/reconcile.js');
    pay = await import('../services/restaurantPayments.js');
    clip = createClipMock();
    client.setClipTransport((req) => clip.transport(req));

    owner = await ownerToken(ctx);
    for (const [code, price] of [['pos', 500], ['landing', 300], ['portal', 200]]) {
      const r = await panel('PUT', `/modules/${code}`, { monthly_price_mxn: price });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos', 'landing', 'portal'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['pos', 'portal'] });
    D = await createRestaurant(ctx, owner, 'delta', { modules: ['pos'] });
    T = await createRestaurant(ctx, owner, 'tri', { modules: ['pos'], status: 'trial' });
    // Precio especial y descuento para A: sitio web a 250 con 10 %.
    const m = await panel('PUT', `/restaurants/${A.id}/modules/landing`, { custom_price_mxn: 250, discount_pct: 10 });
    assert.equal(m.status, 200);
    await panel('PATCH', `/restaurants/${A.id}`, { contact_email: 'pagos@alfa.test' });
    now = new Date();
  });
  after(() => ctx?.close());

  // -------------------------------------------------------------------------
  describe('suscripcion de la plataforma', () => {
    test('configuracion: dias de gracia y Clip configurado sin mostrar secretos', async () => {
      const res = await panel('GET', '/settings');
      assert.equal(res.status, 200);
      assert.equal(res.body.settings.grace_days, 5);
      assert.equal(res.body.settings.clip.configured, true);
      assert.equal(res.body.settings.clip.webhook_secret_configured, true);
      assert.equal(res.body.settings.clip.webhook_url, 'https://api.neuronpos.test/api/webhooks/clip/plataforma');
      const json = JSON.stringify(res.body);
      for (const secret of ['plataforma-api-key', 'plataforma-secret-key', 'plataforma-webhook-secret']) {
        assert.ok(!json.includes(secret), `no debe mostrar ${secret}`);
      }
      assert.equal((await panel('PUT', '/settings', { grace_days: 99 })).status, 400);
      assert.equal((await panel('PUT', '/settings', { grace_days: 7 })).body.settings.grace_days, 7);
      assert.equal((await panel('PUT', '/settings', { grace_days: 5 })).body.settings.grace_days, 5);
      assert.equal((await staff(A, 'GET', '/api/platform/settings')).status, 403, 'un restaurante no entra al Panel');
    });

    test('genera la factura del periodo con precio especial y descuento; es idempotente', async () => {
      const run = await subs.runBillingCycle({ now });
      assert.equal(run.created.length, 3, 'A, B y D (activos); la prueba de T sigue vigente');
      assert.equal(run.links.length, 3);

      const [inv] = await invoicesOf(A);
      assert.equal(inv.status, 'pending');
      assert.equal(Number(inv.subtotal_mxn), 950);
      assert.equal(Number(inv.discount_mxn), 25);
      assert.equal(Number(inv.amount_mxn), 925);
      assert.equal(inv.due_date, inv.period);
      assert.equal(inv.suspends_on, subs.addDays(inv.due_date, 6));
      assert.match(inv.payment_url, /^https:\/\/pago\.clip\.test\//);

      const detail = (await panel('GET', `/invoices/${inv.id}`)).body.invoice;
      const items = Object.fromEntries(detail.items.map((i) => [i.module_code, i]));
      assert.deepEqual(Object.keys(items).sort(), ['landing', 'portal', 'pos']);
      assert.deepEqual(
        [items.landing.unit_price_mxn, items.landing.custom_price_mxn, items.landing.discount_mxn, items.landing.amount_mxn].map(Number),
        [250, 250, 25, 225],
      );
      assert.equal(Number(items.landing.catalog_price_mxn), 300);
      assert.equal(Number(items.pos.amount_mxn), 500);

      // La liga se creo con la cuenta de la PLATAFORMA y regresa al admin del restaurante.
      const call = clip.created().find((c) => c.body.metadata.invoice_id === inv.id);
      assert.equal(call.auth, basicAuth('plataforma-api-key', 'plataforma-secret-key'));
      assert.equal(call.body.amount, 925);
      assert.equal(call.body.webhook_url, 'https://api.neuronpos.test/api/webhooks/clip/plataforma');
      assert.equal(call.body.redirection_url.success, `https://alfa.${PLATFORM_DOMAIN}/admin/suscripcion?factura=${inv.id}&pago=ok`);

      // Otra corrida (o "generar cobro ahora") no duplica la factura ni la liga.
      const calls = clip.created().length;
      const again = await subs.runBillingCycle({ now });
      assert.equal(again.created.length, 0);
      const manual = await panel('POST', `/restaurants/${A.id}/invoices`);
      assert.equal(manual.status, 200);
      assert.equal(manual.body.created, false);
      assert.equal(manual.body.invoice.id, inv.id);
      assert.equal((await invoicesOf(A)).length, 1);
      assert.equal(clip.created().length, calls, 'reusa la liga vigente');
    });

    test('Mi suscripcion: modulos, total y facturas; solo admin/gerente y solo las suyas', async () => {
      const res = await staff(A, 'GET', '/api/subscription');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.monthly_total_mxn, 925);
      assert.deepEqual(res.body.modules.map((l) => l.module_code).sort(), ['landing', 'portal', 'pos']);
      assert.equal(res.body.invoices.length, 1);
      assert.equal(res.body.invoices[0].items.length, 3);
      assert.equal(res.body.summary.unpaid_count, 1);
      const me = await staff(A, 'GET', '/api/me');
      assert.equal(me.body.billing.next_invoice.id, res.body.invoices[0].id);

      const user = await staff(A, 'POST', '/api/users', { email: 'caja@alfa.test', name: 'Caja', role: 'cajero', password: 'clave-segura-9' });
      assert.equal(user.status, 201);
      const login = await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email: 'caja@alfa.test', password: 'clave-segura-9' } });
      assert.equal((await staff(login.body.token, 'GET', '/api/subscription')).status, 403);
      assert.equal((await staff(login.body.token, 'GET', '/api/me')).body.billing, null);

      // B no puede pagar ni ver la factura de A.
      const invA = res.body.invoices[0].id;
      assert.equal((await staff(B, 'POST', `/api/subscription/invoices/${invA}/pay`)).status, 404);
      assert.equal((await staff(B, 'POST', `/api/subscription/invoices/${invA}/verify`)).status, 404);
      const pago = await staff(A, 'POST', `/api/subscription/invoices/${invA}/pay`);
      assert.equal(pago.status, 200);
      assert.equal(pago.body.payment_url, res.body.invoices[0].payment_url);
    });

    test('webhook de la plataforma: firma invalida se rechaza; valida concilia con Clip y marca pagada', async () => {
      const [inv] = await invoicesOf(A);
      const id = checkoutIdOf(inv.payment_url);
      clip.pay(id);
      const body = { payment_request_id: id, resource_status: 'COMPLETED' };

      const bad = await webhook('/plataforma', body, 'plataforma-webhook-secret', { badSig: true });
      assert.equal(bad.status, 401);
      assert.equal(bad.body.code, 'INVALID_SIGNATURE');
      assert.equal((await webhook('/plataforma', body, null)).status, 401, 'sin firma tambien se rechaza');
      assert.equal((await invoicesOf(A))[0].status, 'pending');

      // El cuerpo no se cree: si Clip dice que sigue pendiente, no se marca.
      const [invB] = await invoicesOf(B);
      const okPending = await webhook('/plataforma', { payment_request_id: checkoutIdOf(invB.payment_url), status: 'PAID' }, 'plataforma-webhook-secret');
      assert.equal(okPending.status, 200);
      assert.equal((await invoicesOf(B))[0].status, 'pending', 'Clip sigue pendiente: el webhook no basta');

      const ok = await webhook('/plataforma', body, 'plataforma-webhook-secret');
      assert.equal(ok.status, 200);
      const paid = (await invoicesOf(A))[0];
      assert.equal(paid.status, 'paid');
      assert.equal(paid.paid_method, 'clip');
      assert.equal(paid.paid_reference, `tx_${id}`);
      assert.equal(paid.payment_url, null);
      // Reintento del webhook: idempotente.
      assert.equal((await webhook('/plataforma', body, 'plataforma-webhook-secret')).status, 200);
      assert.equal((await invoicesOf(A))[0].status, 'paid');
    });

    test('Clip con otro monto no marca la factura', async () => {
      const [invD] = await invoicesOf(D);
      const id = checkoutIdOf(invD.payment_url);
      clip.pay(id);
      clip.tamper(id, 1);
      await webhook('/plataforma', { payment_request_id: id }, 'plataforma-webhook-secret');
      assert.equal((await invoicesOf(D))[0].status, 'pending');
      clip.tamper(id, 500);
      clip.checkouts.get(id).status = 'CHECKOUT_CREATED';
    });

    test('vencida tras la fecha limite; suspendida tras la gracia; pagar con Clip la reactiva', async () => {
      const r3 = await subs.runBillingCycle({ now: later(3) });
      assert.deepEqual(r3.suspended, [], 'dentro de la gracia no se suspende');
      assert.equal((await invoicesOf(B))[0].status, 'overdue');
      assert.equal(await restaurantStatus(B), 'active');
      assert.equal((await staff(B, 'GET', '/api/me')).body.billing.overdue, true);

      const r6 = await subs.runBillingCycle({ now: later(6) });
      assert.deepEqual(r6.suspended.sort(), [B.id, D.id].sort());
      assert.equal(r6.created.length, 0);
      assert.equal(await restaurantStatus(A), 'active', 'A ya pago');
      assert.equal(await restaurantStatus(B), 'suspended');

      // Suspendido: nada funciona salvo "Mi suscripcion" (y /api/me para el aviso).
      const menu = await staff(B, 'GET', '/api/pos/menu');
      assert.equal(menu.status, 402);
      assert.equal(menu.body.code, 'RESTAURANT_SUSPENDED');
      assert.match(menu.body.error, /Mi suscripción/);
      assert.equal((await staff(B, 'GET', '/api/branches')).status, 402);
      assert.equal((await staff(B, 'GET', '/api/users')).status, 402);
      const me = await staff(B, 'GET', '/api/me');
      assert.equal(me.status, 200);
      assert.equal(me.body.billing.suspended_for_nonpayment, true);
      const mine = await staff(B, 'GET', '/api/subscription');
      assert.equal(mine.status, 200);
      const inv = mine.body.invoices[0];
      assert.equal(inv.status, 'overdue');

      // Paga con Clip y regresa: la verificacion concilia y reactiva al instante.
      const link = await staff(B, 'POST', `/api/subscription/invoices/${inv.id}/pay`);
      assert.equal(link.status, 200);
      clip.pay(checkoutIdOf(link.body.payment_url));
      const v = await staff(B, 'POST', `/api/subscription/invoices/${inv.id}/verify`);
      assert.equal(v.status, 200);
      assert.equal(v.body.invoice.status, 'paid');
      assert.equal(v.body.restaurant_status, 'active');
      assert.equal((await staff(B, 'GET', '/api/pos/menu')).status, 200);
      assert.equal((await staff(B, 'GET', '/api/branches')).status, 200);
    });

    test('marcar pagado manualmente (con nota) reactiva; una suspension manual no se levanta sola', async () => {
      const [inv] = await invoicesOf(D);
      assert.equal(await restaurantStatus(D), 'suspended');
      assert.equal((await panel('POST', `/invoices/${inv.id}/mark-paid`, {})).status, 400, 'la nota es obligatoria');
      const res = await panel('POST', `/invoices/${inv.id}/mark-paid`, { note: 'Transferencia SPEI', reference: 'SPEI-123' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.invoice.status, 'paid');
      assert.equal(res.body.invoice.paid_method, 'manual');
      assert.equal(res.body.invoice.paid_note, 'Transferencia SPEI');
      assert.equal(res.body.reactivated, true);
      assert.equal(await restaurantStatus(D), 'active');
      const link = await ctx.withPlatform(async (db) => (await db.query(
        'SELECT status FROM clip_checkouts WHERE invoice_id = $1', [inv.id],
      )).rows[0]);
      assert.equal(link.status, 'cancelled', 'la liga pendiente ya no se cobra');

      await panel('POST', `/restaurants/${D.id}/suspend`);
      const again = await panel('POST', `/invoices/${inv.id}/mark-paid`, { note: 'otra vez' });
      assert.equal(again.body.already_paid, true);
      assert.equal(await restaurantStatus(D), 'suspended', 'la suspension manual no se levanta al pagar');
      await panel('POST', `/restaurants/${D.id}/reactivate`);
    });

    test('prueba: al terminar se genera la primera factura y sin pagar tras la gracia se suspende', async () => {
      assert.equal((await subs.runBillingCycle({ now })).created.length, 0);
      const early = await panel('POST', `/restaurants/${T.id}/invoices`);
      assert.equal(early.status, 409);
      assert.equal(early.body.code, 'TRIAL_ACTIVE');

      const end = new Date(now.getTime() - 3600000);
      await panel('PATCH', `/restaurants/${T.id}`, { trial_ends_at: end.toISOString() });
      const run = await subs.runBillingCycle({ now });
      assert.deepEqual(run.converted, [T.id]);
      assert.equal(run.created.length, 1);
      assert.equal(await restaurantStatus(T), 'active');
      const [inv] = await invoicesOf(T);
      assert.equal(Number(inv.amount_mxn), 500);
      assert.equal(inv.period, subs.today(end));

      const r6 = await subs.runBillingCycle({ now: later(6) });
      assert.deepEqual(r6.suspended, [T.id]);
      assert.equal(await restaurantStatus(T), 'suspended');
    });

    test('reenviar liga: misma liga si sigue vigente; nueva si vencio', async () => {
      const [inv] = await invoicesOf(T);
      const first = await panel('POST', `/invoices/${inv.id}/resend`);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.new_link, false);
      assert.equal(first.body.payment_url, inv.payment_url);
      assert.ok(first.body.invoice.last_sent_at);

      clip.expire(checkoutIdOf(inv.payment_url));
      await ctx.withPlatform((db) => db.query(
        "UPDATE clip_checkouts SET expires_at = now() - interval '1 minute' WHERE invoice_id = $1", [inv.id],
      ));
      const second = await panel('POST', `/invoices/${inv.id}/resend`);
      assert.equal(second.body.new_link, true);
      assert.notEqual(second.body.payment_url, inv.payment_url);
    });

    test('el reconciliador cobra ligas pagadas sin webhook y reactiva', async () => {
      const [inv] = await invoicesOf(T);
      clip.pay(checkoutIdOf(inv.payment_url));
      await jobs.reconcilePendingCheckouts();
      assert.equal((await invoicesOf(T))[0].status, 'paid');
      assert.equal(await restaurantStatus(T), 'active');
    });

    test('lista global de facturas para el Panel', async () => {
      const all = await panel('GET', '/invoices');
      assert.equal(all.status, 200);
      assert.equal(all.body.invoices.length, 4);
      assert.ok(all.body.invoices.every((i) => i.restaurant_name));
      assert.equal((await panel('GET', '/invoices?status=unpaid')).body.invoices.length, 0);
      assert.equal((await panel('GET', '/invoices?status=nada')).status, 400);
      const detail = await panel('GET', `/restaurants/${A.id}`);
      assert.equal(detail.body.invoices[0].status, 'paid');
    });
  });

  // -------------------------------------------------------------------------
  describe('pagos en linea de pedidos (Clip del restaurante)', () => {
    let branchA; let taco; let cajero;
    const hostA = `alfa.${PLATFORM_DOMAIN}`;
    const hostB = `beta.${PLATFORM_DOMAIN}`;
    const portal = (host, method, path, body) => ctx.request(method, `/api/portal${path}`, { host, body });
    const order = (provider = 'clip', extra = {}) => portal(hostA, 'POST', '/orders', {
      branch_id: branchA.id, order_type: 'para_llevar', items: [{ menu_item_id: taco.id, quantity: 2 }],
      customer: { name: 'Clienta', phone: '656 123 4567' }, payment: { provider, method: 'efectivo' }, ...extra,
    });
    const linkOf = async (orderId) => ctx.withTenant(A.id, async (db) => (await db.query(
      'SELECT * FROM clip_checkouts WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1', [orderId],
    )).rows[0]);
    const posList = async () => (await staff(A, 'GET', `/api/pos/online-orders?branch_id=${branchA.id}&status=activas`)).body;

    before(async () => {
      branchA = (await staff(A, 'GET', '/api/branches')).body.branches[0];
      const cat = (await staff(A, 'POST', '/api/pos/categories', { name: 'Tacos' })).body.category;
      taco = (await staff(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco', price: 100 })).body.item;
      assert.equal((await staff(A, 'PUT', `/api/branches/${branchA.id}/hours`, { hours: ALL_DAY })).status, 200);
      assert.equal((await staff(A, 'PATCH', '/api/online/settings', { enabled: true })).status, 200);
      const branchB = (await staff(B, 'GET', '/api/branches')).body.branches[0];
      await staff(B, 'PUT', `/api/branches/${branchB.id}/hours`, { hours: ALL_DAY });
      await staff(B, 'PATCH', '/api/online/settings', { enabled: true });
      const u = await staff(A, 'POST', '/api/users', { email: 'gerente@alfa.test', name: 'Gerente', role: 'gerente', password: 'clave-segura-9' });
      assert.equal(u.status, 201);
      cajero = (await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email: 'gerente@alfa.test', password: 'clave-segura-9' } })).body.token;
    });

    test('credenciales de Clip: se guardan cifradas y nunca salen por la API', async () => {
      const off = await staff(A, 'GET', '/api/online/payments');
      assert.equal(off.status, 200);
      assert.equal(off.body.payments.clip.configured, false);
      assert.equal((await staff(A, 'PUT', '/api/online/payments', { online_payment_enabled: true })).status, 400, 'sin credenciales no se enciende');
      assert.equal((await staff(A, 'PUT', '/api/online/payments', { clip_api_key: 'solo-la-api-key' })).body.code, 'CLIP_CREDENTIALS_INCOMPLETE');
      assert.equal((await staff(cajero, 'PUT', '/api/online/payments', ALFA_CREDS)).status, 403, 'solo el admin');

      const saved = await staff(A, 'PUT', '/api/online/payments', { ...ALFA_CREDS, online_payment_enabled: true });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.payments.clip.configured, true);
      assert.equal(saved.body.payments.clip.webhook_secret_configured, true);
      assert.equal(saved.body.payments.clip.webhook_url, `https://api.neuronpos.test/api/webhooks/clip/r/${A.id}`);
      assert.equal(saved.body.payments.available, true);

      const responses = [
        saved.body,
        (await staff(A, 'GET', '/api/online/payments')).body,
        (await staff(cajero, 'GET', '/api/online/payments')).body,
        (await staff(A, 'GET', '/api/online/settings')).body,
        (await staff(A, 'GET', '/api/me')).body,
        (await staff(A, 'GET', '/api/subscription')).body,
        (await portal(hostA, 'GET', '/config')).body,
        (await ctx.request('GET', '/api/public/site', { host: hostA })).body,
        (await panel('GET', `/restaurants/${A.id}`)).body,
        (await panel('GET', '/restaurants')).body,
      ];
      for (const body of responses) {
        const json = JSON.stringify(body);
        for (const secret of Object.values(ALFA_CREDS)) assert.ok(!json.includes(secret), `se filtro ${secret}: ${json.slice(0, 200)}`);
        assert.ok(!json.includes('v1:'), 'tampoco el valor cifrado');
      }

      // En la BD solo hay texto cifrado, amarrado al restaurante.
      const row = await ctx.withPlatform(async (db) => (await db.query(
        'SELECT * FROM restaurant_payment_settings WHERE restaurant_id = $1', [A.id],
      )).rows[0]);
      assert.match(row.clip_api_key_enc, /^v1:/);
      assert.ok(!row.clip_api_key_enc.includes(ALFA_CREDS.clip_api_key));
      const creds = await pay.loadRestaurantClipCredentials(A.id);
      assert.equal(creds.apiKey, ALFA_CREDS.clip_api_key);
      // Copiado a otro restaurante no se puede descifrar (AAD = restaurante).
      await ctx.withPlatform((db) => db.query(
        `INSERT INTO restaurant_payment_settings (restaurant_id, clip_api_key_enc, clip_secret_key_enc)
         VALUES ($1, $2, $3)`,
        [B.id, row.clip_api_key_enc, row.clip_secret_key_enc],
      ));
      await assert.rejects(() => pay.loadRestaurantClipCredentials(B.id));
      await ctx.withPlatform((db) => db.query('DELETE FROM restaurant_payment_settings WHERE restaurant_id = $1', [B.id]));
      // RLS: B no ve la fila de A.
      const seen = await ctx.withTenant(B.id, async (db) => (await db.query('SELECT count(*)::int AS n FROM restaurant_payment_settings')).rows[0].n);
      assert.equal(seen, 0);
    });

    test('checkout: el portal ofrece Clip solo si el restaurante lo configuro', async () => {
      const cfgA = (await portal(hostA, 'GET', '/config')).body;
      assert.deepEqual(cfgA.payment_options.map((o) => o.code), ['contra_entrega', 'clip']);
      const cfgB = (await portal(hostB, 'GET', '/config')).body;
      assert.deepEqual(cfgB.payment_options.map((o) => o.code), ['contra_entrega']);
      const branchB = cfgB.branches[0];
      const noClip = await portal(hostB, 'POST', '/orders', {
        branch_id: branchB.id, order_type: 'para_llevar', items: [], payment: { provider: 'clip' },
        customer: { name: 'X', phone: '6561234567' },
      });
      assert.equal(noClip.status, 400);
    });

    test('pedido pagado en linea: espera el pago, Clip confirma y sigue el flujo normal hasta entregarse', async () => {
      const res = await order();
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.payment.action, 'redirect');
      assert.match(res.body.payment.url, /^https:\/\/pago\.clip\.test\//);
      const o = res.body.order;
      assert.equal(o.status, 'esperando_pago');
      assert.equal(o.online_payment_status, 'pendiente');
      assert.ok(o.payment_due_at);
      assert.equal(Number(o.total), 200);

      // La liga se creo con la cuenta de Clip DEL RESTAURANTE.
      const call = clip.lastCreated();
      assert.equal(call.auth, basicAuth(ALFA_CREDS.clip_api_key, ALFA_CREDS.clip_secret_key));
      assert.equal(call.body.amount, 200);
      assert.equal(call.body.webhook_url, `https://api.neuronpos.test/api/webhooks/clip/r/${A.id}`);
      assert.equal(call.body.redirection_url.success, `https://alfa.${PLATFORM_DOMAIN}/pago/resultado?pedido=${o.token}&r=ok`);

      // Mientras no paga, el POS no lo ve ni lo puede aceptar.
      const list = await posList();
      assert.ok(!list.orders.some((x) => x.id === o.id));
      assert.equal(list.pending_count, 0);
      const early = await staff(A, 'POST', `/api/pos/online-orders/${o.id}/accept`, {});
      assert.equal(early.body.code, 'ONLINE_PAYMENT_PENDING');

      const id = checkoutIdOf(res.body.payment.url);
      clip.pay(id);
      // Firma invalida con el secreto de A: rechazada.
      const bad = await webhook(`/r/alfa`, { payment_request_id: id }, ALFA_CREDS.clip_webhook_secret, { badSig: true });
      assert.equal(bad.status, 401);
      assert.equal((await linkOf(o.id)).status, 'pending');

      const ok = await webhook(`/r/${A.id}`, { payment_request_id: id }, ALFA_CREDS.clip_webhook_secret);
      assert.equal(ok.status, 200);
      assert.equal((await webhook('/r/alfa', { payment_request_id: id }, ALFA_CREDS.clip_webhook_secret)).status, 200, 'reintento idempotente');

      const detail = (await staff(A, 'GET', `/api/pos/orders/${o.id}`)).body.order;
      assert.equal(detail.online_payment_status, 'pagado');
      assert.equal(Number(detail.paid_amount), 200);
      assert.equal(detail.payments.length, 1, 'un solo pago aunque el webhook se repita');
      assert.equal(detail.payments[0].method_kind, 'en_linea');
      assert.equal(detail.payments[0].cash_session_id, null);
      assert.equal(detail.status, 'abierta', 'no es automatico: espera a que lo acepten');

      // Ahora si llega al POS: aceptar -> cocina -> listo -> entregar (sin caja).
      const visible = await posList();
      assert.ok(visible.orders.some((x) => x.id === o.id && x.online_payment_status === 'pagado'));
      assert.equal(visible.pending_count, 1);
      assert.equal((await staff(A, 'POST', `/api/pos/online-orders/${o.id}/accept`, {})).status, 200);
      const kitchen = (await staff(A, 'GET', `/api/pos/kitchen?branch_id=${branchA.id}`)).body.orders;
      assert.ok(kitchen.some((k) => k.id === o.id));
      assert.equal((await staff(A, 'POST', `/api/pos/orders/${o.id}/ready`)).status, 200);
      const methods = (await staff(A, 'GET', '/api/pos/payment-methods')).body.payment_methods;
      const online = methods.find((m) => m.kind === 'en_linea');
      const session = await staff(A, 'POST', '/api/pos/cash-sessions/open', { branch_id: branchA.id, opening_cash: 0 });
      const cobro = await staff(A, 'POST', `/api/pos/orders/${o.id}/payments`, {
        cash_session_id: session.body.session.id, payments: [{ payment_method_id: online.id, amount: 1 }],
      });
      assert.equal(cobro.body.code, 'ONLINE_METHOD_NOT_ALLOWED', 'la caja no registra pagos de Clip');
      const delivered = await staff(A, 'POST', `/api/pos/online-orders/${o.id}/deliver`);
      assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
      assert.equal(delivered.body.order.status, 'pagada');
      const track = (await portal(hostA, 'GET', `/track/${o.token}`)).body.order;
      assert.equal(track.status, 'entregado');
      assert.equal(track.paid, true);

      // El pago en linea no entra al corte de caja.
      const cut = (await staff(A, 'GET', `/api/pos/cash-sessions/${session.body.session.id}`)).body.cut;
      assert.ok(!cut.methods.some((m) => m.kind === 'en_linea'));
      assert.equal(Number(cut.total_sales), 0);
    });

    test('un webhook de un restaurante (o de la plataforma) no marca pedidos de otro', async () => {
      const res = await order();
      const id = checkoutIdOf(res.body.payment.url);
      clip.pay(id);
      const viaB = await webhook('/r/beta', { payment_request_id: id }, null);
      assert.equal(viaB.status, 200);
      const viaPlatform = await webhook('/plataforma', { payment_request_id: id }, 'plataforma-webhook-secret');
      assert.equal(viaPlatform.status, 200);
      assert.equal((await linkOf(res.body.order.id)).status, 'pending');
      const still = (await portal(hostA, 'GET', `/track/${res.body.order.token}`)).body.order;
      assert.equal(still.online_payment_status, 'pendiente');
      // Tampoco una factura de suscripcion por el webhook de un restaurante.
      const [invA] = await invoicesOf(A);
      const invLink = await ctx.withPlatform(async (db) => (await db.query(
        'SELECT checkout_id FROM clip_checkouts WHERE invoice_id = $1', [invA.id],
      )).rows[0]);
      assert.equal((await webhook(`/r/${A.id}`, { payment_request_id: invLink.checkout_id }, ALFA_CREDS.clip_webhook_secret)).status, 200);
      const events = await ctx.withTenant(B.id, async (db) => (await db.query(
        'SELECT restaurant_id, matched FROM clip_webhook_events',
      )).rows);
      assert.ok(events.length >= 1 && events.every((e) => e.restaurant_id === B.id && !e.matched), 'B solo ve sus eventos');
      assert.equal((await ctx.request('POST', '/api/webhooks/clip/r/no-existe', { body: {} })).status, 404);

      // Al regresar de Clip, la pagina de resultado concilia (sin webhook).
      const v = await portal(hostA, 'POST', `/track/${res.body.order.token}/verify-payment`);
      assert.equal(v.status, 200);
      assert.equal(v.body.order.online_payment_status, 'pagado');
      assert.equal(v.body.order.status, 'recibido');
    });

    test('aceptacion automatica: al confirmarse el pago entra directo a cocina', async () => {
      await staff(A, 'PATCH', '/api/online/settings', { auto_accept: true });
      const res = await order();
      assert.equal(res.body.order.status, 'esperando_pago', 'sin pago no se acepta aunque sea automatico');
      clip.pay(checkoutIdOf(res.body.payment.url));
      await jobs.reconcilePendingCheckouts();
      const track = (await portal(hostA, 'GET', `/track/${res.body.order.token}`)).body.order;
      assert.equal(track.status, 'preparando');
      await staff(A, 'PATCH', '/api/online/settings', { auto_accept: false });
    });

    test('sin pagar a tiempo se cancela; si Clip confirmo antes, se cobra en lugar de cancelar', async () => {
      const unpaid = await order();
      const paidLate = await order();
      clip.pay(checkoutIdOf(paidLate.body.payment.url)); // pagado pero sin webhook
      const result = await pay.expireUnpaidOrders({ now: new Date(Date.now() + 31 * 60000) });
      assert.deepEqual(result.cancelled, [unpaid.body.order.id]);

      const t1 = (await portal(hostA, 'GET', `/track/${unpaid.body.order.token}`)).body.order;
      assert.equal(t1.status, 'cancelado');
      assert.equal(t1.online_payment_status, 'cancelado');
      assert.match(t1.cancel_reason, /pago en línea/);
      assert.equal((await linkOf(unpaid.body.order.id)).status, 'expired');
      const retry = await portal(hostA, 'POST', `/track/${unpaid.body.order.token}/pay`);
      assert.equal(retry.body.code, 'PAYMENT_WINDOW_CLOSED');
      const t2 = (await portal(hostA, 'GET', `/track/${paidLate.body.order.token}`)).body.order;
      assert.equal(t2.online_payment_status, 'pagado');

      // Si el cliente paga una liga ya vencida: se registra como pago tardio, el pedido sigue cancelado.
      const id = checkoutIdOf(unpaid.body.payment.url);
      clip.pay(id);
      await webhook(`/r/${A.id}`, { payment_request_id: id }, ALFA_CREDS.clip_webhook_secret);
      const link = await linkOf(unpaid.body.order.id);
      assert.equal(link.status, 'completed');
      assert.equal(link.late_payment, true);
      const o = (await staff(A, 'GET', `/api/pos/orders/${unpaid.body.order.id}`)).body.order;
      assert.equal(o.status, 'cancelada');
      assert.equal(o.payments.length, 0);
    });

    test('el cliente puede abandonar el pago (cancelar) y retomar la liga mientras siga vigente', async () => {
      const res = await order();
      const again = await portal(hostA, 'POST', `/track/${res.body.order.token}/pay`);
      assert.equal(again.status, 200);
      assert.equal(again.body.payment.url, res.body.payment.url);
      const c = await portal(hostA, 'POST', `/track/${res.body.order.token}/cancel`);
      assert.equal(c.status, 200);
      assert.equal(c.body.order.status, 'cancelado');
      assert.equal((await linkOf(res.body.order.id)).status, 'cancelled');
    });

    test('si Clip falla al crear la liga no queda un pedido huerfano', async () => {
      const before = (await staff(A, 'GET', `/api/pos/orders?branch_id=${branchA.id}&status=todas`)).body.orders.length;
      clip.failCreate = true;
      const res = await order();
      clip.failCreate = false;
      assert.equal(res.status, 502);
      assert.equal(res.body.code, 'CLIP_ERROR');
      const after = (await staff(A, 'GET', `/api/pos/orders?branch_id=${branchA.id}&status=todas`)).body.orders.length;
      assert.equal(after, before);
    });

    test('pago al recibir sigue funcionando igual', async () => {
      const res = await order('contra_entrega');
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.payment.action, 'none');
      assert.equal(res.body.order.status, 'recibido');
      assert.equal(res.body.order.online_payment_status, null);
      assert.equal(res.body.order.payment_preference, 'efectivo');
      const list = await posList();
      assert.ok(list.orders.some((x) => x.id === res.body.order.id));
      const deliver = await staff(A, 'POST', `/api/pos/online-orders/${res.body.order.id}/deliver`);
      assert.equal(deliver.status, 400, 'sin pago en linea se cobra en caja');
    });

    test('quitar las credenciales apaga el pago en linea', async () => {
      const res = await staff(A, 'PUT', '/api/online/payments', { remove_clip: true });
      assert.equal(res.status, 200);
      assert.equal(res.body.payments.clip.configured, false);
      assert.equal(res.body.payments.online_payment_enabled, false);
      const cfg = (await portal(hostA, 'GET', '/config')).body;
      assert.deepEqual(cfg.payment_options.map((o) => o.code), ['contra_entrega']);
    });
  });
});
