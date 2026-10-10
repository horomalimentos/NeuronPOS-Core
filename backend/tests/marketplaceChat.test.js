// NeuronPOS Delivery (fase 4) contra Postgres: chat de tres partes por pedido.
// Cubre: cliente (token), restaurante (RLS) y repartidor (solo el que lo
// lleva) leen y escriben; otro repartidor u otro restaurante no; el
// restaurante no puede escribir como cliente; al terminar es solo lectura.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, ownerToken, setupDb } from './helpers.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));
const CENTRO = { latitude: 31.7389, longitude: -106.4870 };
const CERCA = { latitude: 31.7569, longitude: -106.4870 };

describe('NeuronPOS Delivery: fase 4 (chat del pedido)', { skip: SKIP_DB }, () => {
  let ctx; let owner; let R; let R2; let branchId; let taco; let juan; let pedro; let order; let mid;
  const api = (token, method, path, body) => ctx.request(method, path, { token, body });
  const pub = (method, path, body) => ctx.request(method, `/api/marketplace${path}`, { body });
  const signup = async (name, email) => {
    const r = await pub('POST', '/restaurants', {
      name, phone: '6561112222', address: 'Av. Juarez 100', location: CENTRO, admin: { name, email, password: 'clave-segura-1' },
    });
    const login = await ctx.request('POST', '/api/auth/login', { slug: r.body.restaurant.slug, body: { email, password: 'clave-segura-1' } });
    return { id: r.body.restaurant.id, token: login.body.token };
  };
  const driver = async (name, email) => {
    const r = await pub('POST', '/drivers', { name, email, password: 'clave-segura-7', phone: '6560000000', vehicle: 'Moto', base: CERCA, radius_km: 4 });
    await api(owner, 'POST', `/api/platform/marketplace/drivers/${r.body.driver.id}/review`, { status: 'aprobado' });
    await api(r.body.token, 'POST', '/api/fleet/duty', { on_duty: true });
    return { id: r.body.driver.id, token: r.body.token };
  };

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    R = await signup('Tacos Pepa', 'pepa@tacos.test');
    R2 = await signup('Sushi Ken', 'ken@sushi.test');
    branchId = (await api(R.token, 'GET', '/api/marketplace/listings')).body.listings[0].branch_id;
    const cat = (await api(R.token, 'POST', '/api/pos/categories', { name: 'Tacos' })).body.category;
    taco = (await api(R.token, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco', price: 25 })).body.item;
    await api(R.token, 'PUT', `/api/branches/${branchId}/hours`, { hours: ALL_DAY });
    await api(R.token, 'PUT', `/api/marketplace/listings/${branchId}`, { published: true });
    juan = await driver('Juan Perez', 'juan@moto.test');
    pedro = await driver('Pedro', 'pedro@moto.test');
    order = (await pub('POST', '/orders', {
      branch_id: branchId, items: [{ menu_item_id: taco.id, quantity: 4 }], location: CERCA,
      customer: { name: 'Maria', phone: '6561234567' }, address: { address: 'Calle Uno 123' },
    })).body.order;
    mid = (await api(R.token, 'GET', '/api/marketplace/orders')).body.orders[0].id;
  });
  after(() => ctx?.close());

  test('cliente y restaurante platican; otro restaurante no ve el chat', async () => {
    const empty = await pub('GET', `/orders/${order.token}/messages`);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.messages, []);
    assert.equal(empty.body.open, true);
    assert.equal((await pub('POST', `/orders/${order.token}/messages`, { body: '   ' })).status, 400);
    assert.equal((await pub('POST', `/orders/${order.token}/messages`, { body: 'x'.repeat(501) })).status, 400);
    const c = await pub('POST', `/orders/${order.token}/messages`, { body: 'Sin cebolla por favor' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const r = await api(R.token, 'POST', `/api/marketplace/orders/${mid}/messages`, { body: 'Claro, anotado' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.messages.map((m) => [m.sender, m.sender_name]), [['cliente', 'Maria'], ['restaurante', 'Tacos Pepa']]);
    assert.equal((await api(R.token, 'GET', '/api/marketplace/orders')).body.orders[0].messages, 2);
    assert.equal((await pub('GET', `/orders/${order.token}`)).body.order.messages, 2);

    assert.equal((await api(R2.token, 'GET', `/api/marketplace/orders/${mid}/messages`)).status, 404);
    // RLS: el restaurante no puede escribir como cliente ni en pedidos ajenos.
    await assert.rejects(ctx.withTenant(R.id, (db) => db.query(
      "INSERT INTO marketplace_messages (marketplace_order_id, restaurant_id, sender, sender_name, body) VALUES ($1, $2, 'cliente', 'X', 'hola')",
      [mid, R.id],
    )), /row-level security/);
    const seen = (await ctx.withTenant(R2.id, (db) => db.query('SELECT count(*)::int AS n FROM marketplace_messages'))).rows[0].n;
    assert.equal(seen, 0);
  });

  test('solo el repartidor que lleva el pedido entra al chat', async () => {
    assert.equal((await api(juan.token, 'GET', `/api/fleet/marketplace/orders/${mid}/messages`)).status, 404);
    await api(R.token, 'POST', `/api/marketplace/orders/${mid}/accept`, { prep_minutes: 10 });
    assert.equal((await api(juan.token, 'POST', `/api/fleet/marketplace/orders/${mid}/take`)).status, 200);
    const job = (await api(juan.token, 'GET', '/api/fleet/marketplace')).body.active[0];
    assert.equal(job.messages, 2);
    const d = await api(juan.token, 'POST', `/api/fleet/marketplace/orders/${mid}/messages`, { body: 'Voy en camino al restaurante' });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    assert.equal(d.body.messages.at(-1).sender_name, 'Juan');
    assert.equal((await api(pedro.token, 'GET', `/api/fleet/marketplace/orders/${mid}/messages`)).status, 404);
    assert.equal((await api(pedro.token, 'POST', `/api/fleet/marketplace/orders/${mid}/messages`, { body: 'hola' })).status, 404);
    const c = await pub('GET', `/orders/${order.token}/messages`);
    assert.equal(c.body.driver_assigned, true);
    assert.equal(c.body.messages.length, 3);
  });

  test('al entregar el chat queda de solo lectura', async () => {
    await api(juan.token, 'POST', `/api/fleet/marketplace/orders/${mid}/pickup`);
    await api(juan.token, 'POST', `/api/fleet/marketplace/orders/${mid}/deliver`);
    const c = await pub('GET', `/orders/${order.token}/messages`);
    assert.equal(c.body.open, false);
    assert.equal(c.body.messages.length, 3);
    assert.equal((await pub('POST', `/orders/${order.token}/messages`, { body: 'Gracias' })).body.code, 'CHAT_CLOSED');
    assert.equal((await api(R.token, 'POST', `/api/marketplace/orders/${mid}/messages`, { body: 'De nada' })).body.code, 'CHAT_CLOSED');
    assert.equal((await pub('GET', '/orders/no-existe-este-token-de-pedido/messages')).status, 404);
  });
});
