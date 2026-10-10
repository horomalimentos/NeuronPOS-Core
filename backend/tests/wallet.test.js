// Monedero del cliente: recarga con Clip (webhook/conciliacion, una sola
// vez, montos y tope), pago en linea con saldo (y devolucion al rechazar o
// cancelar), pago en caja con codigo (compartido con los puntos), corte de
// caja, ajustes manuales y aislamiento entre restaurantes.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createClipMock } from './clipMock.js';
import { PLATFORM_DOMAIN, SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));
const CREDS = { clip_api_key: 'alfa-api-key-123', clip_secret_key: 'alfa-secret-456' };

describe('monedero del cliente', { skip: SKIP_DB }, () => {
  let ctx; let owner; let clip; let A; let B; let branch; let cajero; let session; let methods; let taco;
  let ana; let anaToken;
  const host = `alfa.${PLATFORM_DOMAIN}`;
  const api = (who, method, p, body) => ctx.request(method, p, { token: who.token ?? who, body });
  const portal = (method, p, body, token = anaToken) => ctx.request(method, `/api/portal${p}`, { host, body, token });
  const cash = () => methods.find((m) => m.kind === 'efectivo').id;
  const newOrder = async (qty = 1) => (await api(cajero, 'POST', '/api/pos/orders', {
    branch_id: branch.id, order_type: 'para_llevar', items: [{ menu_item_id: taco.id, quantity: qty }],
  })).body.order;
  const pay = (o, payments) => api(cajero, 'POST', `/api/pos/orders/${o.id}/payments`, { cash_session_id: session.id, payments });
  const code = async () => (await portal('GET', '/me/pos-code')).body.code.code;
  const balance = async () => (await portal('GET', '/me/wallet')).body.balance;
  const webOrder = (payment, qty = 1) => portal('POST', '/orders', {
    branch_id: branch.id, order_type: 'para_llevar', items: [{ menu_item_id: taco.id, quantity: qty }], payment,
  });

  async function topup(amount) {
    const r = await portal('POST', '/me/wallet/topup', { amount });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.payment.url.split('/').pop();
    clip.pay(id);
    return id;
  }

  before(async () => {
    ctx = await setupDb();
    const client = await import('../services/clip/client.js');
    clip = createClipMock();
    client.setClipTransport((req) => clip.transport(req));
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos', 'portal', 'monedero'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['pos', 'portal'] });
    branch = (await api(A, 'GET', '/api/branches')).body.branches[0];
    await api(A, 'POST', '/api/users', { email: 'cajero@alfa.test', name: 'Caja', role: 'cajero', password: 'clave-segura-9', branch_ids: [branch.id] });
    cajero = (await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email: 'cajero@alfa.test', password: 'clave-segura-9' } })).body;
    methods = (await api(A, 'GET', '/api/pos/payment-methods')).body.payment_methods;
    const cat = (await api(A, 'POST', '/api/pos/categories', { name: 'Tacos' })).body.category;
    taco = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco', price: 100 })).body.item;
    session = (await api(cajero, 'POST', '/api/pos/cash-sessions/open', { branch_id: branch.id })).body.session;
    await api(A, 'PUT', `/api/branches/${branch.id}/hours`, { hours: ALL_DAY });
    await api(A, 'PATCH', '/api/online/settings', { enabled: true });
    const reg = await portal('POST', '/auth/register', { name: 'Ana', email: 'ana@correo.mx', phone: '6561234567', password: 'clave-ana-12' }, undefined);
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    anaToken = reg.body.token;
    ana = reg.body.customer;
  });
  after(() => ctx?.close());

  test('sin el modulo responde 402; sin lealtad igual hay fichas de clientes', async () => {
    assert.equal((await api(B, 'GET', '/api/wallet/settings')).status, 402);
    assert.equal((await api(B, 'GET', '/api/loyalty/customers')).status, 402);
    const list = await api(cajero, 'GET', '/api/loyalty/customers');
    assert.equal(list.status, 200);
    assert.equal(list.body.customers[0].wallet_balance, 0);
    // Lo exclusivo de la lealtad sigue cerrado.
    assert.equal((await api(A, 'GET', '/api/loyalty/stats')).status, 402);
    const w = await portal('GET', '/me/wallet');
    assert.equal(w.body.enabled, true);
    assert.equal(w.body.settings.topups_available, false, 'sin Clip no hay recargas');
    assert.equal((await portal('POST', '/me/wallet/topup', { amount: 100 })).body.code, 'TOPUPS_UNAVAILABLE');
    const pc = await portal('GET', '/me/pos-code');
    assert.equal(pc.body.needed, true);
    assert.match(pc.body.code.code, /^\d{6}$/);
  });

  test('recarga con Clip: limites, se acredita una vez y valida el monto', async () => {
    assert.equal((await api(A, 'PUT', '/api/online/payments', { ...CREDS, online_payment_enabled: true })).status, 200);
    assert.equal((await portal('GET', '/me/wallet')).body.settings.topups_available, true);
    assert.equal((await portal('POST', '/me/wallet/topup', { amount: 20 })).body.code, 'BELOW_MIN_TOPUP');
    assert.equal((await portal('POST', '/me/wallet/topup', { amount: 6000 })).body.code, 'ABOVE_MAX_TOPUP');

    const id = await topup(300);
    // Pagado en Clip, pero aun no conciliado.
    assert.equal(await balance(), 0);
    const v = await portal('POST', '/me/wallet/verify', {});
    assert.equal(v.body.balance, 300);
    assert.equal(v.body.transactions[0].kind, 'topup');
    // El webhook despues no la acredita otra vez.
    const wh = await ctx.request('POST', `/api/webhooks/clip/r/${A.id}`, { body: { payment_request_id: id } });
    assert.equal(wh.status, 200);
    assert.equal(await balance(), 300);

    // Si Clip reporta otro monto no se acredita.
    const r = await portal('POST', '/me/wallet/topup', { amount: 100 });
    const id2 = r.body.payment.url.split('/').pop();
    clip.pay(id2);
    clip.tamper(id2, 1);
    await portal('POST', '/me/wallet/verify', {});
    assert.equal(await balance(), 300);

    // Tope de saldo.
    await api(A, 'PATCH', '/api/wallet/settings', { max_balance: 5000 });
    assert.equal((await portal('POST', '/me/wallet/topup', { amount: 4900 })).body.code, 'ABOVE_MAX_BALANCE');
  });

  test('pedido en linea con monedero: nace pagado; sin saldo no se crea', async () => {
    const guest = await ctx.request('POST', '/api/portal/orders', {
      host,
      body: {
        branch_id: branch.id, order_type: 'para_llevar', items: [{ menu_item_id: taco.id, quantity: 1 }],
        customer: { name: 'X', phone: '6560000000' }, payment: { provider: 'monedero' },
      },
    });
    assert.equal(guest.body.code, 'LOGIN_REQUIRED');
    const big = await webOrder({ provider: 'monedero' }, 4); // $400 > $300
    assert.equal(big.body.code, 'INSUFFICIENT_BALANCE');
    assert.equal((await portal('GET', '/orders')).body.orders.length, 0, 'el pedido sin saldo no queda');

    const r = await webOrder({ provider: 'monedero' }, 1);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.payment.paid, true);
    assert.equal(await balance(), 200);
    const o = (await api(cajero, 'GET', `/api/pos/orders/${r.body.order.id}`)).body.order;
    assert.equal(Number(o.paid_amount), 100);
    assert.equal(o.online_payment_status, 'pagado');
    assert.equal(o.payments[0].method_kind, 'monedero');

    // El restaurante lo rechaza: el dinero regresa al monedero.
    const rej = await api(cajero, 'POST', `/api/pos/online-orders/${o.id}/reject`, { reason: 'Sin gas' });
    assert.equal(rej.status, 200, JSON.stringify(rej.body));
    assert.equal(await balance(), 300);
    const w = (await portal('GET', '/me/wallet')).body;
    assert.deepEqual(w.transactions.slice(0, 2).map((t) => [t.kind, Number(t.amount)]), [['refund', 100], ['purchase', -100]]);

    // El cliente lo cancela antes de que lo acepten: tambien regresa.
    const r2 = await webOrder({ provider: 'monedero' }, 1);
    assert.equal(await balance(), 200);
    const token = r2.body.order.public_token || r2.body.order.token;
    const c = await portal('POST', `/track/${token}/cancel`, {});
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(await balance(), 300);

    // Apagado en ajustes: ya no se ofrece.
    await api(A, 'PATCH', '/api/wallet/settings', { web_enabled: false });
    assert.ok(!(await portal('GET', '/config')).body.payment_options.some((p) => p.code === 'monedero'));
    assert.equal((await webOrder({ provider: 'monedero' })).body.code, 'INVALID_PAYMENT');
    await api(A, 'PATCH', '/api/wallet/settings', { web_enabled: true });
    assert.ok((await portal('GET', '/config')).body.payment_options.some((p) => p.code === 'monedero'));
  });

  test('pago en caja con codigo; mixto con efectivo; no se elige a mano', async () => {
    const o = await newOrder(2); // $200
    const bad = await pay(o, [{ wallet: { customer_id: ana.id, amount: 50, code: '000000' } }, { payment_method_id: cash(), amount: 150 }]);
    assert.equal(bad.body.code, 'INVALID_CUSTOMER_CODE');
    const much = await pay(o, [{ wallet: { customer_id: ana.id, amount: 400, code: await code() } }]);
    assert.equal(much.body.code, 'INSUFFICIENT_BALANCE');
    const r = await pay(o, [{ wallet: { customer_id: ana.id, amount: 120, code: await code() } }, { payment_method_id: cash(), amount: 80 }]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.order.status, 'pagada');
    assert.equal(r.body.order.customer_id, ana.id);
    assert.equal(await balance(), 180);
    const wm = (await api(A, 'GET', '/api/pos/payment-methods')).body.payment_methods.find((m) => m.kind === 'monedero');
    const o2 = await newOrder();
    assert.equal((await pay(o2, [{ payment_method_id: wm.id, amount: 10 }])).body.code, 'WALLET_METHOD_NOT_ALLOWED');
    // Sobrepago con monedero no se permite.
    const over = await pay(o2, [{ wallet: { customer_id: ana.id, amount: 150, code: await code() } }]);
    assert.equal(over.body.code, 'OVERPAYMENT');
  });

  test('puntos y monedero en el mismo cobro piden el codigo una vez', async () => {
    await api(owner, 'PUT', `/api/platform/restaurants/${A.id}/modules/lealtad`, { enabled: true });
    await api(A, 'POST', `/api/loyalty/customers/${ana.id}/points`, { points: 500, reason: 'Bienvenida' });
    await portal('POST', '/me/pos-code/reset', {});
    const o = await newOrder(); // $100
    const c = await code();
    const r = await pay(o, [
      { loyalty: { customer_id: ana.id, points: 100, code: c } }, // $4
      { wallet: { customer_id: ana.id, amount: 96, code: c } },
    ]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await balance(), 84);
  });

  test('el corte muestra el monedero aparte y no pide contarlo', async () => {
    const preview = (await api(cajero, 'GET', `/api/pos/cash-sessions/${session.id}`)).body;
    const cut = preview.cut || preview.session?.cut || preview;
    const line = cut.methods.find((m) => m.kind === 'monedero');
    assert.equal(line.sales, 216); // 120 + 96 (el pedido en linea no es del turno)
    const counts = cut.methods.filter((m) => !['puntos', 'monedero'].includes(m.kind))
      .map((m) => ({ payment_method_id: m.payment_method_id, counted: m.expected }));
    const close = await api(cajero, 'POST', `/api/pos/cash-sessions/${session.id}/close`, { counts });
    assert.equal(close.status, 200, JSON.stringify(close.body));
    assert.equal(close.body.cut.total_difference, 0);
  });

  test('ajustes manuales con motivo (solo admin/gerente), detalle y resumen', async () => {
    assert.equal((await api(cajero, 'POST', `/api/wallet/customers/${ana.id}/adjust`, { amount: 10, reason: 'x' })).status, 403);
    assert.equal((await api(A, 'POST', `/api/wallet/customers/${ana.id}/adjust`, { amount: 10 })).body.code, 'MISSING_FIELD');
    const adj = await api(A, 'POST', `/api/wallet/customers/${ana.id}/adjust`, { amount: 16, reason: 'Compensación' });
    assert.equal(adj.status, 200, JSON.stringify(adj.body));
    assert.equal(adj.body.balance, 100);
    assert.equal((await api(A, 'POST', `/api/wallet/customers/${ana.id}/adjust`, { amount: -1000, reason: 'x' })).body.code, 'INSUFFICIENT_BALANCE');
    const d = (await api(A, 'GET', `/api/loyalty/customers/${ana.id}`)).body;
    assert.equal(d.customer.wallet_balance, 100);
    assert.equal(d.customer.wallet_loaded, 300);
    assert.equal(d.wallet_transactions[0].kind, 'adjust');
    assert.equal(d.wallet_transactions[0].created_by_name, 'Admin alfa');
    const st = (await api(A, 'GET', '/api/wallet/stats')).body.stats;
    assert.equal(st.outstanding, 100);
    assert.equal(st.last_30_days.loaded, 300);
    assert.equal(st.last_30_days.refunded, 200);
    const bad = await api(A, 'PATCH', '/api/wallet/settings', { min_topup: 600, max_topup: 500 });
    assert.equal(bad.status, 400);
  });

  test('otro restaurante no ve ni cobra el monedero', async () => {
    await api(owner, 'PUT', `/api/platform/restaurants/${B.id}/modules/monedero`, { enabled: true });
    assert.equal((await api(B, 'POST', `/api/wallet/customers/${ana.id}/adjust`, { amount: 10, reason: 'x' })).body.code, 'CUSTOMER_NOT_FOUND');
    assert.equal((await api(B, 'GET', `/api/loyalty/customers/${ana.id}`)).status, 404);
  });
});
