// Clientes y lealtad: alta en caja, puntos al cobrar (POS y pedido en linea),
// canje como pago con el codigo del cliente (ventana, reuso y bloqueo),
// corte de caja, ajustes, portal y aislamiento entre restaurantes.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORM_DOMAIN, SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));

describe('clientes y lealtad', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B; let branch; let cajero; let mesero; let session; let methods; let taco;
  let ana; let anaToken;
  const host = `alfa.${PLATFORM_DOMAIN}`;
  const api = (who, method, p, body) => ctx.request(method, p, { token: who.token ?? who, body });
  const portal = (method, p, body, token) => ctx.request(method, `/api/portal${p}`, { host, body, token });
  const cash = () => methods.find((m) => m.kind === 'efectivo').id;
  const newOrder = async (qty = 1) => (await api(cajero, 'POST', '/api/pos/orders', {
    branch_id: branch.id, order_type: 'para_llevar', items: [{ menu_item_id: taco.id, quantity: qty }],
  })).body.order;
  const pay = (o, payments) => api(cajero, 'POST', `/api/pos/orders/${o.id}/payments`, { cash_session_id: session.id, payments });
  const code = async () => (await portal('GET', '/me/loyalty', undefined, anaToken)).body.code.code;

  async function addUser(role) {
    const email = `${role}@alfa.test`;
    await api(A, 'POST', '/api/users', { email, name: role, role, password: 'clave-segura-9', branch_ids: [branch.id] });
    return (await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email, password: 'clave-segura-9' } })).body;
  }

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos', 'portal', 'lealtad'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['pos'] });
    branch = (await api(A, 'GET', '/api/branches')).body.branches[0];
    cajero = await addUser('cajero');
    mesero = await addUser('mesero');
    methods = (await api(A, 'GET', '/api/pos/payment-methods')).body.payment_methods;
    const cat = (await api(A, 'POST', '/api/pos/categories', { name: 'Tacos' })).body.category;
    taco = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco', price: 100 })).body.item;
    session = (await api(cajero, 'POST', '/api/pos/cash-sessions/open', { branch_id: branch.id })).body.session;
    await api(A, 'PUT', `/api/branches/${branch.id}/hours`, { hours: ALL_DAY });
    await api(A, 'PATCH', '/api/online/settings', { enabled: true });
  });
  after(() => ctx?.close());

  test('sin el modulo responde 402; cocina no entra', async () => {
    assert.equal((await api(B, 'GET', '/api/loyalty/customers')).status, 402);
    const cocina = await addUser('cocina');
    assert.equal((await api(cocina, 'GET', '/api/loyalty/customers')).status, 403);
  });

  test('alta en caja por telefono (sin repetir) y busqueda', async () => {
    const r = await api(mesero, 'POST', '/api/loyalty/customers', { name: 'Ana López', phone: '656 123 4567', email: 'ana@correo.mx' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ana = r.body.customer;
    assert.equal(ana.has_account, false);
    assert.equal(ana.points_balance, 0);
    const again = await api(cajero, 'POST', '/api/loyalty/customers', { name: 'Otra', phone: '+52 656-123-4567' });
    assert.equal(again.status, 200);
    assert.equal(again.body.existing, true);
    assert.equal(again.body.customer.id, ana.id);
    assert.equal((await api(cajero, 'GET', '/api/loyalty/customers?q=1234567')).body.customers[0].id, ana.id);
    assert.equal((await api(cajero, 'GET', `/api/loyalty/customers?q=${encodeURIComponent('lópez')}`)).body.customers.length, 1);
  });

  test('gana puntos al cobrar una orden con cliente, una sola vez', async () => {
    const o = await newOrder(2);
    assert.equal((await api(cajero, 'POST', `/api/loyalty/orders/${o.id}/customer`, { customer_id: ana.id })).status, 200);
    const p = await pay(o, [{ payment_method_id: cash(), amount: 200, tip: 20, received: 300 }]);
    assert.equal(p.status, 201, JSON.stringify(p.body));
    assert.equal(p.body.order.customer_id, ana.id);
    let d = (await api(A, 'GET', `/api/loyalty/customers/${ana.id}`)).body;
    assert.equal(d.customer.points_balance, 200); // 1 punto por peso, sin propina
    assert.equal(d.customer.orders, 1);
    assert.equal(d.orders[0].points_earned, 200);
    // Orden sin cliente: no da puntos.
    const o2 = await newOrder();
    await pay(o2, [{ payment_method_id: cash(), amount: 100 }]);
    d = (await api(A, 'GET', `/api/loyalty/customers/${ana.id}`)).body;
    assert.equal(d.customer.points_balance, 200);
  });

  test('al registrarse en el sitio con su correo conserva la ficha y ve su codigo', async () => {
    const reg = await portal('POST', '/auth/register', { name: 'Ana', email: 'ANA@correo.mx', phone: '6561234567', password: 'clave-ana-12' });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal(reg.body.customer.id, ana.id);
    anaToken = reg.body.token;
    const l = await portal('GET', '/me/loyalty', undefined, anaToken);
    assert.equal(l.body.enabled, true);
    assert.equal(l.body.balance, 200);
    assert.equal(l.body.value, 8); // 200 x 0.04
    assert.match(l.body.code.code, /^\d{6}$/);
    assert.ok(l.body.code.seconds_left > 0 && l.body.code.seconds_left <= 300);
  });

  test('canje en caja: minimo, codigo, pago con puntos y sin puntos sobre ellos', async () => {
    const o = await newOrder(); // $100
    const low = await pay(o, [{ loyalty: { customer_id: ana.id, points: 10, code: await code() } }]);
    assert.equal(low.body.code, 'BELOW_MIN_POINTS');
    const bad = await pay(o, [{ loyalty: { customer_id: ana.id, points: 100, code: '000000' } }]);
    assert.equal(bad.body.code, 'INVALID_CUSTOMER_CODE');
    // Elegir a mano el metodo de puntos no se permite.
    const pm = (await api(A, 'GET', '/api/pos/payment-methods')).body.payment_methods;
    assert.ok(!pm.some((m) => m.kind === 'puntos'), 'el metodo se crea con el primer canje');

    const c = await code();
    const r = await pay(o, [
      { loyalty: { customer_id: ana.id, points: 100, code: c } }, // $4
      { payment_method_id: cash(), amount: 96 },
    ]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.order.status, 'pagada');
    assert.equal(r.body.order.customer_id, ana.id);
    const points = r.body.order.payments.find((p) => p.method_kind === 'puntos');
    assert.equal(Number(points.amount), 4);
    // 200 - 100 + floor(100 - 4) = 196
    const d = (await api(A, 'GET', `/api/loyalty/customers/${ana.id}`)).body;
    assert.equal(d.customer.points_balance, 196);
    assert.equal(d.customer.points_redeemed, 100);
    assert.deepEqual(d.transactions.slice(0, 2).map((t) => [t.kind, t.points]), [['earn', 96], ['redeem', -100]]);

    // El mismo codigo no sirve dos veces.
    const o2 = await newOrder();
    const reuse = await pay(o2, [{ loyalty: { customer_id: ana.id, points: 50, code: c } }]);
    assert.equal(reuse.body.code, 'INVALID_CUSTOMER_CODE');
    const pmAfter = (await api(A, 'GET', '/api/pos/payment-methods')).body.payment_methods.find((m) => m.kind === 'puntos');
    const manual = await pay(o2, [{ payment_method_id: pmAfter.id, amount: 10 }]);
    assert.equal(manual.body.code, 'POINTS_METHOD_NOT_ALLOWED');
    const tooMany = await pay(o2, [{ loyalty: { customer_id: ana.id, points: 5000, code: await code() } }]);
    assert.equal(tooMany.body.code, 'INSUFFICIENT_POINTS');
  });

  test('cinco codigos erroneos bloquean hasta renovarlo', async () => {
    await portal('POST', '/me/loyalty/reset-code', {}, anaToken); // borra el error del reuso anterior
    const o = await newOrder();
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await pay(o, [{ loyalty: { customer_id: ana.id, points: 25, code: '111111' } }])).body.code, 'INVALID_CUSTOMER_CODE');
    }
    const locked = await pay(o, [{ loyalty: { customer_id: ana.id, points: 25, code: await code().catch(() => '123456') } }]);
    assert.equal(locked.status, 423);
    const l = await portal('GET', '/me/loyalty', undefined, anaToken);
    assert.equal(l.body.code_locked, true);
    assert.equal(l.body.code, null);
    const reset = await portal('POST', '/me/loyalty/reset-code', {}, anaToken);
    assert.match(reset.body.code.code, /^\d{6}$/);
    const ok = await pay(o, [{ loyalty: { customer_id: ana.id, points: 25, code: reset.body.code.code } }, { payment_method_id: cash(), amount: 99 }]);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  });

  test('el corte muestra los puntos aparte y no pide contarlos', async () => {
    const preview = (await api(cajero, 'GET', `/api/pos/cash-sessions/${session.id}`)).body;
    const cut = preview.cut || preview.session?.cut || preview;
    const line = (cut.methods || []).find((m) => m.kind === 'puntos');
    assert.ok(line, JSON.stringify(Object.keys(preview)));
    assert.equal(line.sales, 5); // $4 + $1
    const counts = cut.methods.filter((m) => m.kind !== 'puntos').map((m) => ({ payment_method_id: m.payment_method_id, counted: m.expected }));
    const close = await api(cajero, 'POST', `/api/pos/cash-sessions/${session.id}/close`, { counts });
    assert.equal(close.status, 200, JSON.stringify(close.body));
    assert.equal(close.body.cut.total_difference, 0);
    session = (await api(cajero, 'POST', '/api/pos/cash-sessions/open', { branch_id: branch.id })).body.session;
  });

  test('pedido en linea con cuenta: gana puntos al cobrarse; se puede desactivar', async () => {
    const before = (await portal('GET', '/me/loyalty', undefined, anaToken)).body.balance;
    const order = await portal('POST', '/orders', {
      branch_id: branch.id, order_type: 'para_llevar', items: [{ menu_item_id: taco.id, quantity: 1 }], payment: { method: 'efectivo' },
    }, anaToken);
    assert.equal(order.status, 201, JSON.stringify(order.body));
    const id = order.body.order.id;
    await api(cajero, 'POST', `/api/pos/online-orders/${id}/accept`);
    const o = (await api(cajero, 'GET', `/api/pos/orders/${id}`)).body.order;
    assert.equal((await pay(o, [{ payment_method_id: cash(), amount: Number(o.total) }])).status, 201);
    assert.equal((await portal('GET', '/me/loyalty', undefined, anaToken)).body.balance, before + 100);

    await api(A, 'PATCH', '/api/loyalty/settings', { earn_enabled: false });
    const o2 = await newOrder();
    await api(cajero, 'POST', `/api/loyalty/orders/${o2.id}/customer`, { customer_id: ana.id });
    await pay(o2, [{ payment_method_id: cash(), amount: 100 }]);
    assert.equal((await portal('GET', '/me/loyalty', undefined, anaToken)).body.balance, before + 100);
    await api(A, 'PATCH', '/api/loyalty/settings', { earn_enabled: true });
  });

  test('ajustes del programa y ajuste manual de puntos (solo admin/gerente)', async () => {
    const s = await api(A, 'PATCH', '/api/loyalty/settings', { program_name: 'Amigos', peso_per_point: 0.1, min_redeem_points: 10 });
    assert.equal(s.body.settings.program_name, 'Amigos');
    assert.equal(s.body.settings.peso_per_point, 0.1);
    assert.equal((await api(cajero, 'PATCH', '/api/loyalty/settings', { earn_enabled: false })).status, 403);
    assert.equal((await api(cajero, 'POST', `/api/loyalty/customers/${ana.id}/points`, { points: 10, reason: 'x' })).status, 403);
    const before = (await api(A, 'GET', `/api/loyalty/customers/${ana.id}`)).body.customer.points_balance;
    const adj = await api(A, 'POST', `/api/loyalty/customers/${ana.id}/points`, { points: -5, reason: 'Corrección' });
    assert.equal(adj.status, 200, JSON.stringify(adj.body));
    assert.equal(adj.body.customer.points_balance, before - 5);
    assert.equal(adj.body.transactions[0].kind, 'adjust');
    const neg = await api(A, 'POST', `/api/loyalty/customers/${ana.id}/points`, { points: -1000000, reason: 'x' });
    assert.equal(neg.body.code, 'INSUFFICIENT_POINTS');
    assert.equal((await api(A, 'PATCH', `/api/loyalty/customers/${ana.id}`, { email: 'otro@correo.mx' })).body.code, 'EMAIL_LOCKED');
    const st = (await api(A, 'GET', '/api/loyalty/stats')).body.stats;
    assert.equal(st.customers, 1);
    assert.equal(st.with_account, 1);
  });

  test('otro restaurante no ve ni usa los clientes', async () => {
    assert.equal((await api(B, 'GET', `/api/loyalty/customers/${ana.id}`)).status, 402);
    await api(owner, 'PUT', `/api/platform/restaurants/${B.id}/modules/lealtad`, { enabled: true });
    assert.equal((await api(B, 'GET', `/api/loyalty/customers/${ana.id}`)).status, 404);
    assert.equal((await api(B, 'GET', '/api/loyalty/customers')).body.customers.length, 0);
  });
});
