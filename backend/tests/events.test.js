// Ventas por evento: evento y productos con cupo, pedidos del vendedor y de la
// pagina publica, cobro, entrega, produccion y control de vendedores.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

describe('ventas por evento', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B; let branch; let mesero; let mesero2; let ev; let products; let token;
  const api = (who, method, path, body) => ctx.request(method, path, { token: who.token ?? who, body });
  const pub = (method, path, body) => ctx.request(method, path, { slug: 'alfa', body });
  const login = async (email) => (await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email, password: 'clave-segura-9' } })).body.token;
  const tomorrow = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['eventos'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['pos'] });
    branch = (await api(A, 'GET', '/api/branches')).body.branches[0];
    for (const e of ['mesero@alfa.test', 'mesero2@alfa.test']) {
      await api(A, 'POST', '/api/users', { email: e, name: e.split('@')[0], role: 'mesero', password: 'clave-segura-9', branch_ids: [branch.id] });
    }
    mesero = await login('mesero@alfa.test');
    mesero2 = await login('mesero2@alfa.test');
  });
  after(() => ctx?.close());

  test('el gerente crea el evento y sus productos', async () => {
    assert.equal((await api(mesero, 'POST', '/api/events', { branch_id: branch.id, name: 'X', sale_date: tomorrow() })).status, 403);
    const r = await api(A, 'POST', '/api/events', { branch_id: branch.id, name: 'Carne asada Maquila Norte', place: 'Planta Norte', sale_date: tomorrow(), commission_pct: 10 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ev = r.body.event;
    assert.match(ev.slug, /^carne-asada-maquila-norte/);
    assert.equal(ev.status, 'borrador');
    const p = await api(A, 'PUT', `/api/events/${ev.id}/products`, { products: [
      { name: 'Plato de carne asada', price: 120, max_quantity: 3 },
      { name: 'Refresco', price: 25 },
    ] });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    products = p.body.products;
    assert.deepEqual(products.map((x) => [x.name, x.left]), [['Plato de carne asada', 3], ['Refresco', null]]);
    assert.equal((await pub('GET', `/api/event-page/${ev.slug}`)).status, 404, 'borrador no se ve');
    assert.equal((await api(mesero, 'POST', `/api/events/${ev.id}/orders`, { customer_name: 'Ana', items: [{ product_id: products[0].id }] })).body.code, 'EVENT_NOT_OPEN');
    await api(A, 'PATCH', `/api/events/${ev.id}`, { status: 'abierto' });
  });

  test('pedidos del vendedor y de la pagina, con cupo', async () => {
    const o1 = await api(mesero, 'POST', `/api/events/${ev.id}/orders`, { customer_name: 'Ana', items: [{ product_id: products[0].id, quantity: 2 }, { product_id: products[1].id, quantity: 2 }], paid: true });
    assert.equal(o1.status, 201, JSON.stringify(o1.body));
    assert.deepEqual([o1.body.order.folio, Number(o1.body.order.total), o1.body.order.status], [1, 290, 'pagado']);
    const page = await pub('GET', `/api/event-page/${ev.slug}`);
    assert.equal(page.status, 200);
    assert.equal(page.body.event.accepting, true);
    assert.equal(page.body.products[0].left, 1);
    assert.equal((await pub('POST', `/api/event-page/${ev.slug}/orders`, { customer_name: 'Beto', customer_phone: '656 111 2222', items: [{ product_id: products[0].id, quantity: 2 }] })).body.code, 'EVENT_SOLD_OUT');
    assert.equal((await pub('POST', `/api/event-page/${ev.slug}/orders`, { customer_name: 'Beto', items: [{ product_id: products[0].id }] })).body.code, 'INVALID_PHONE');
    const web = await pub('POST', `/api/event-page/${ev.slug}/orders`, { customer_name: 'Beto', customer_phone: '656 111 2222', items: [{ product_id: products[0].id }] });
    assert.equal(web.status, 201, JSON.stringify(web.body));
    assert.equal(web.body.order.seller_id, undefined);
    token = web.body.order.public_token;
    assert.equal((await pub('GET', `/api/event-page/${ev.slug}/orders/${token}`)).body.order.status, 'pendiente');
    assert.equal((await pub('GET', `/api/event-page/${ev.slug}`)).body.products[0].left, 0);
    assert.equal((await pub('GET', '/api/event-page/no-existe')).status, 404);
    assert.equal((await ctx.request('GET', `/api/event-page/${ev.slug}`, { slug: 'beta' })).body.code, 'MODULE_NOT_ENABLED');
  });

  test('cobrar, entregar, cancelar y produccion', async () => {
    const orders = (await api(mesero2, 'GET', `/api/events/${ev.id}/orders`)).body.orders;
    assert.deepEqual(orders.map((o) => o.customer_name), ['Beto'], 'el vendedor ve los suyos y los de la pagina');
    const beto = orders[0];
    assert.equal((await api(mesero2, 'POST', `/api/events/orders/${beto.id}/deliver`)).body.code, 'EVENT_ORDER_NOT_PAID');
    const paid = await api(mesero2, 'POST', `/api/events/orders/${beto.id}/pay`);
    assert.equal(paid.body.order.status, 'pagado');
    assert.equal(paid.body.order.seller_name, 'mesero2', 'quien cobra se vuelve el vendedor');
    assert.equal((await api(mesero2, 'POST', `/api/events/orders/${beto.id}/deliver`)).status, 200);
    assert.equal((await api(mesero2, 'POST', `/api/events/orders/${beto.id}/cancel`)).status, 403, 'pagado: solo gerente');

    const all = (await api(A, 'GET', `/api/events/${ev.id}/orders`)).body.orders;
    const ana = all.find((o) => o.customer_name === 'Ana');
    assert.equal((await api(mesero2, 'POST', `/api/events/orders/${ana.id}/cancel`)).status, 403, 'otro vendedor');

    const prod = (await api(A, 'GET', `/api/events/${ev.id}/production`)).body.production;
    assert.deepEqual(prod.map((p) => [p.name, p.paid, p.delivered]), [['Plato de carne asada', 3, 1], ['Refresco', 2, 0]]);

    assert.equal((await api(A, 'POST', `/api/events/orders/${ana.id}/cancel`)).body.order.status, 'cancelado');
    assert.equal((await api(A, 'GET', `/api/events/${ev.id}`)).body.products[0].left, 2, 'el cupo regresa');
    assert.equal((await api(A, 'DELETE', `/api/events/${ev.id}`)).body.code, 'EVENT_HAS_ORDERS');
  });

  test('control de vendedores', async () => {
    assert.equal((await api(mesero, 'GET', `/api/events/${ev.id}/sellers`)).status, 403);
    const s = (await api(A, 'GET', `/api/events/${ev.id}/sellers`)).body.sellers;
    const m2 = s.find((x) => x.name === 'mesero2');
    assert.deepEqual([m2.orders, Number(m2.collected), Number(m2.commission)], [1, 120, 12]);
    await api(A, 'PUT', `/api/events/${ev.id}/sellers/${m2.seller_id}`, { cash_delivered: 108, commission_paid: true });
    const again = (await api(A, 'GET', `/api/events/${ev.id}/sellers`)).body.sellers.find((x) => x.name === 'mesero2');
    assert.deepEqual([Number(again.cash_delivered), again.commission_paid], [108, true]);
  });

  test('cerrar la pagina', async () => {
    await api(A, 'PATCH', `/api/events/${ev.id}`, { status: 'cerrado' });
    assert.equal((await pub('GET', `/api/event-page/${ev.slug}`)).body.event.accepting, false);
    assert.equal((await pub('POST', `/api/event-page/${ev.slug}/orders`, { customer_name: 'C', customer_phone: '6561112222', items: [{ product_id: products[1].id }] })).body.code, 'EVENT_CLOSED');
    assert.equal((await api(mesero, 'POST', `/api/events/${ev.id}/orders`, { customer_name: 'C', items: [{ product_id: products[1].id }] })).status, 201, 'el personal aun puede');
  });
});
