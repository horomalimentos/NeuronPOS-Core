// Nayo: un repartidor lleva hasta N pedidos a la vez (2 de
// inicio, se cambia en el Panel) y los pedidos salen en "Pedidos en linea"
// del POS con su estado de repartidor; desde ahi se aceptan y se marcan
// listos, pero no "salio a reparto" (eso lo marca el repartidor).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, ownerToken, setupDb } from './helpers.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));
const CENTRO = { latitude: 31.7389, longitude: -106.4870 };
const CERCA = { latitude: 31.7569, longitude: -106.4870 };

describe('Nayo: varios pedidos y POS', { skip: SKIP_DB }, () => {
  let ctx; let owner; let R; let branchId; let taco; let juan;
  const api = (token, method, path, body) => ctx.request(method, path, { token, body });
  const pub = (method, path, body) => ctx.request(method, `/api/marketplace${path}`, { body });
  // Para pedir hay que tener cuenta de Nayo.
  let shopper;
  const buy = (body) => ctx.request('POST', '/api/marketplace/orders', { token: shopper, body });
  const panel = (method, path, body) => api(owner, method, `/api/platform${path}`, body);
  const fleet = (method, path, body) => api(juan.token, method, `/api/fleet${path}`, body);
  const posOrders = async () => {
    const r = await api(R.token, 'GET', `/api/pos/online-orders?branch_id=${branchId}&status=activas`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.orders;
  };
  const newOrder = async () => {
    const r = await buy({
      branch_id: branchId, items: [{ menu_item_id: taco.id, quantity: 2 }], location: CERCA,
      customer: { name: 'Maria Lopez', phone: '656 123 4567' }, address: { address: 'Calle Uno 123' }, pay_with: 200,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.order;
  };

  before(async () => {
    ctx = await setupDb();
    shopper = (await ctx.request('POST', '/api/marketplace/account/register', {
      body: { name: 'Maria Lopez', email: 'maria@cliente.test', phone: '6561234567', password: 'clave-cliente-1' },
    })).body.token;
    owner = await ownerToken(ctx);
    const r = await pub('POST', '/restaurants', {
      name: 'Tacos Pepa', phone: '6561112222', address: 'Av. Juarez 100', location: CENTRO,
      admin: { name: 'Pepa', email: 'pepa@tacos.test', password: 'clave-segura-1' },
    });
    const login = await ctx.request('POST', '/api/auth/login', { slug: r.body.restaurant.slug, body: { email: 'pepa@tacos.test', password: 'clave-segura-1' } });
    R = { id: r.body.restaurant.id, token: login.body.token };
    // Tambien usa el POS: sus pedidos de Delivery salen en Pedidos en linea.
    assert.equal((await panel('PUT', `/restaurants/${R.id}/modules/pos`, { enabled: true })).status, 200);
    branchId = (await api(R.token, 'GET', '/api/marketplace/listings')).body.listings[0].branch_id;
    const cat = (await api(R.token, 'POST', '/api/pos/categories', { name: 'Tacos' })).body.category;
    taco = (await api(R.token, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco de asada', price: 25 })).body.item;
    await api(R.token, 'PUT', `/api/branches/${branchId}/hours`, { hours: ALL_DAY });
    await api(R.token, 'PUT', `/api/marketplace/listings/${branchId}`, { published: true });
    await panel('POST', `/marketplace/listings/${branchId}/approval`, { status: 'aprobado' });
    const d = await pub('POST', '/drivers', { name: 'Juan', email: 'juan@moto.test', password: 'clave-segura-7', phone: '6560000000', vehicle: 'Moto', base: CERCA, radius_km: 4 });
    await panel('POST', `/marketplace/drivers/${d.body.driver.id}/review`, { status: 'aprobado' });
    await api(d.body.token, 'POST', '/api/fleet/duty', { on_duty: true });
    juan = { id: d.body.driver.id, token: d.body.token };
  });
  after(() => ctx?.close());

  test('el pedido sale en Pedidos en linea del POS y se acepta y se marca listo desde ahi', async () => {
    const o = await newOrder();
    let pos = (await posOrders()).find((x) => x.marketplace);
    assert.ok(pos, 'el pedido de Delivery sale en el POS');
    assert.equal(pos.online_status, 'pendiente');
    assert.equal(pos.marketplace.status, 'nuevo');
    assert.equal(pos.marketplace.driver_assigned, false);
    assert.equal(pos.marketplace.messages, 0);
    assert.equal(Number(pos.delivery_fee), 0, 'el restaurante solo cobra la comida');

    const acc = await api(R.token, 'POST', `/api/pos/online-orders/${pos.id}/accept`, {});
    assert.equal(acc.status, 200, JSON.stringify(acc.body));
    pos = (await posOrders()).find((x) => x.id === pos.id);
    assert.equal(pos.marketplace.status, 'aceptado', 'aceptar en el POS lo ofrece a los repartidores');
    assert.equal((await pub('GET', `/orders/${o.token}`)).body.order.status, 'aceptado');

    const disp = await api(R.token, 'POST', `/api/pos/online-orders/${pos.id}/dispatch`, {});
    assert.equal(disp.body.code, 'MARKETPLACE_ORDER');

    const ready = await api(R.token, 'POST', `/api/marketplace/orders/${pos.marketplace.id}/ready`);
    assert.equal(ready.status, 200, JSON.stringify(ready.body));
    assert.equal((await posOrders()).find((x) => x.id === pos.id).marketplace.status, 'listo');

    const take = await fleet('POST', `/marketplace/orders/${pos.marketplace.id}/take`);
    assert.equal(take.status, 200, JSON.stringify(take.body));
    assert.equal((await posOrders()).find((x) => x.id === pos.id).marketplace.driver_assigned, true);
  });

  test('lleva hasta 2 pedidos a la vez; el Panel cambia el tope', async () => {
    assert.equal((await panel('GET', '/marketplace/settings')).body.settings.driver_max_orders, 2);
    const acceptNext = async () => {
      await newOrder();
      const p = (await posOrders()).find((x) => x.online_status === 'pendiente');
      await api(R.token, 'POST', `/api/pos/online-orders/${p.id}/accept`, {});
      return p.marketplace.id;
    };
    const second = await acceptNext();
    let b = (await fleet('GET', '/marketplace')).body;
    assert.equal(b.max_orders, 2);
    assert.equal(b.active.length, 1);
    assert.ok(b.available.some((x) => x.id === second), 'con 1 pedido todavia ve los disponibles');
    assert.equal((await fleet('POST', `/marketplace/orders/${second}/take`)).status, 200);

    const third = await acceptNext();
    b = (await fleet('GET', '/marketplace')).body;
    assert.equal(b.active.length, 2);
    assert.equal(b.available.length, 0, 'con 2 ya no le ofrecemos mas');
    const busy = await fleet('POST', `/marketplace/orders/${third}/take`);
    assert.equal(busy.status, 409);
    assert.equal(busy.body.code, 'DRIVER_BUSY');

    assert.equal((await panel('PUT', '/marketplace/settings', { driver_max_orders: 9 })).body.code, 'INVALID_FIELD');
    assert.equal((await panel('PUT', '/marketplace/settings', { driver_max_orders: 3 })).status, 200);
    assert.equal((await fleet('POST', `/marketplace/orders/${third}/take`)).status, 200);

    await panel('PUT', '/marketplace/settings', { driver_max_orders: 1 });
    const fourth = await acceptNext();
    assert.equal((await fleet('POST', `/marketplace/orders/${fourth}/take`)).body.code, 'DRIVER_BUSY');
  });
});
