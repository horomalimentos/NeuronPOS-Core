// NeuronPOS Delivery (fase 2) contra Postgres: el cliente ve los
// restaurantes cercanos y pide. Cubre: sin repartidor en turno que cubra al
// restaurante no se puede pedir (como en Horom); envio por km de la tabla;
// precios del servidor (se ignora el precio que mande el cliente), pedido
// minimo y efectivo; reparto 80/20 guardado; el restaurante acepta, rechaza
// y marca listo, y el cliente lo ve; una cancelacion desde el POS se refleja;
// el restaurante no puede cambiar el envio; pausa y repartidor fuera de turno.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, ownerToken, setupDb } from './helpers.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));
const CENTRO = { latitude: 31.7389, longitude: -106.4870 };
const CERCA = { latitude: 31.7569, longitude: -106.4870 };
const LEJOS = { latitude: 31.8199, longitude: -106.4870 };

describe('NeuronPOS Delivery: fase 2 (el cliente pide)', { skip: SKIP_DB }, () => {
  let ctx; let owner; let R; let branchId; let taco; let salsaVerde; let driverToken; let driverId;
  const api = (token, method, path, body) => ctx.request(method, path, { token, body });
  const pub = (method, path, body) => ctx.request(method, `/api/marketplace${path}`, { body });
  const near = (p) => pub('GET', `/restaurants?lat=${p.latitude}&lng=${p.longitude}`);
  const orderBody = (extra = {}) => ({
    branch_id: branchId,
    items: [{ menu_item_id: taco.id, quantity: 3, modifier_ids: [salsaVerde.id], price: 0.01 }],
    location: CERCA,
    customer: { name: 'Maria Lopez', phone: '656 123 4567' },
    address: { address: 'Calle Uno 123, Centro', reference: 'Porton azul' },
    ...extra,
  });

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    const r = await pub('POST', '/restaurants', {
      name: 'Tacos Pepa', phone: '6561112222', address: 'Av. Juarez 100', location: CENTRO,
      admin: { name: 'Pepa', email: 'pepa@tacos.test', password: 'clave-segura-1' },
    });
    const login = await ctx.request('POST', '/api/auth/login', { slug: r.body.restaurant.slug, body: { email: 'pepa@tacos.test', password: 'clave-segura-1' } });
    R = { id: r.body.restaurant.id, token: login.body.token };
    branchId = (await api(R.token, 'GET', '/api/marketplace/listings')).body.listings[0].branch_id;
    const group = (await api(R.token, 'POST', '/api/pos/modifier-groups', {
      name: 'Salsa', min_selections: 1, max_selections: 1, modifiers: [{ name: 'Verde' }, { name: 'Roja', price_delta: 2 }],
    })).body.group;
    salsaVerde = group.modifiers.find((m) => m.name === 'Verde');
    const cat = (await api(R.token, 'POST', '/api/pos/categories', { name: 'Tacos' })).body.category;
    taco = (await api(R.token, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco de asada', price: 25, modifier_group_ids: [group.id] })).body.item;
    await api(R.token, 'PUT', `/api/branches/${branchId}/hours`, { hours: ALL_DAY });
    const pubd = await api(R.token, 'PUT', `/api/marketplace/listings/${branchId}`, { published: true, min_order: 50, cuisine: 'Tacos' });
    assert.equal(pubd.status, 200, JSON.stringify(pubd.body));
  });
  after(() => ctx?.close());

  test('sin repartidores conectados el restaurante aparece pero no se puede pedir', async () => {
    const res = await near(CERCA);
    assert.equal(res.status, 200);
    assert.equal(res.body.restaurants.length, 1);
    const [t] = res.body.restaurants;
    assert.equal(t.can_order, false);
    assert.equal(t.reason, 'sin_repartidor');
    assert.equal(t.delivery_fee, 35);
    const order = await pub('POST', '/orders', orderBody());
    assert.equal(order.status, 409);
    assert.equal(order.body.code, 'NO_DRIVERS');
  });

  test('con un repartidor en turno que cubre: se puede pedir; envio por km', async () => {
    const d = await pub('POST', '/drivers', {
      name: 'Juan', email: 'juan@moto.test', password: 'clave-segura-7', phone: '6560000000', vehicle: 'Moto', base: CERCA, radius_km: 4,
    });
    driverToken = d.body.token;
    driverId = d.body.driver.id;
    await ctx.request('POST', `/api/platform/marketplace/drivers/${driverId}/review`, { token: owner, body: { status: 'aprobado' } });
    await ctx.request('POST', '/api/fleet/duty', { token: driverToken, body: { on_duty: true } });

    const [t] = (await near(CERCA)).body.restaurants;
    assert.equal(t.can_order, true);
    assert.equal(t.name, 'Tacos Pepa');
    assert.ok(t.distance_km > 1.9 && t.distance_km < 2.1);
    const far = (await near(LEJOS)).body.restaurants[0];
    assert.equal(far.delivery_fee, 75); // ~9 km: tramo hasta 10 km
  });

  test('menu publico de la sucursal', async () => {
    const res = await pub('GET', `/restaurants/${branchId}?lat=${CERCA.latitude}&lng=${CERCA.longitude}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.restaurant.can_order, true);
    assert.deepEqual(res.body.items.map((i) => i.name), ['Taco de asada']);
    assert.equal(res.body.modifier_groups[0].modifiers.length, 2);
  });

  test('cotiza con precios del servidor, valida minimo y efectivo; crea el pedido con reparto 80/20', async () => {
    const low = await pub('POST', '/quote', orderBody({ items: [{ menu_item_id: taco.id, quantity: 1, modifier_ids: [salsaVerde.id] }] }));
    assert.equal(low.status, 400);
    assert.equal(low.body.code, 'BELOW_MIN_ORDER');
    const q = await pub('POST', '/quote', orderBody());
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.equal(Number(q.body.totals.total), 75 + 35);
    assert.equal((await pub('POST', '/orders', orderBody({ pay_with: 100 }))).body.code, 'PAY_WITH_TOO_LOW');
    assert.equal((await pub('POST', '/orders', orderBody({ customer: {} }))).status, 400);

    const res = await pub('POST', '/orders', orderBody({ pay_with: 200 }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const o = res.body.order;
    assert.equal(o.status, 'nuevo');
    assert.equal(Number(o.total), 110);
    assert.equal(Number(o.food_total), 75);
    assert.equal(Number(o.delivery_fee), 35);
    assert.equal(o.items[0].modifiers[0], 'Verde');

    const m = (await ctx.withPlatform((db) => db.query('SELECT * FROM marketplace_orders WHERE public_token = $1', [o.token]))).rows[0];
    assert.equal(Number(m.driver_share), 28);
    assert.equal(Number(m.platform_share), 7);
    const order = (await ctx.withTenant(R.id, (db) => db.query('SELECT * FROM orders WHERE id = $1', [m.order_id]))).rows[0];
    assert.equal(order.channel, 'marketplace');
    assert.equal(order.order_type, 'domicilio');
    assert.equal(order.online_status, 'pendiente');
    // El envio no es del restaurante: su orden es solo la comida.
    assert.equal(Number(order.delivery_fee), 0);
    assert.equal(Number(order.total), 75);
  });

  test('el restaurante acepta y marca listo; el cliente lo ve; rechazo y cancelacion se sincronizan', async () => {
    const list = await api(R.token, 'GET', '/api/marketplace/orders');
    assert.equal(list.status, 200);
    const [o] = list.body.orders;
    assert.equal(o.status, 'nuevo');
    assert.equal(o.items[0].quantity, 3);
    assert.equal((await api(R.token, 'POST', `/api/marketplace/orders/${o.id}/ready`)).status, 409);
    const acc = await api(R.token, 'POST', `/api/marketplace/orders/${o.id}/accept`, { prep_minutes: 15 });
    assert.equal(acc.status, 200, JSON.stringify(acc.body));
    assert.equal(acc.body.order.status, 'aceptado');
    const ready = await api(R.token, 'POST', `/api/marketplace/orders/${o.id}/ready`);
    assert.equal(ready.body.order.status, 'listo');
    const token = (await ctx.withPlatform((db) => db.query('SELECT public_token FROM marketplace_orders WHERE id = $1', [o.id]))).rows[0].public_token;
    const track = await pub('GET', `/orders/${token}`);
    assert.equal(track.body.order.status, 'listo');
    assert.equal(track.body.order.restaurant.name, 'Tacos Pepa');

    const second = (await pub('POST', '/orders', orderBody())).body.order;
    const id2 = (await api(R.token, 'GET', '/api/marketplace/orders')).body.orders.find((x) => x.status === 'nuevo').id;
    assert.equal((await api(R.token, 'POST', `/api/marketplace/orders/${id2}/reject`, {})).status, 400);
    await api(R.token, 'POST', `/api/marketplace/orders/${id2}/reject`, { reason: 'Se acabo la carne' });
    const t2 = (await pub('GET', `/orders/${second.token}`)).body.order;
    assert.equal(t2.status, 'rechazado');
    assert.equal(t2.cancel_reason, 'Se acabo la carne');

    // Cancelado desde el POS (orders): tambien se refleja.
    const third = (await pub('POST', '/orders', orderBody())).body.order;
    await ctx.withTenant(R.id, (db) => db.query(
      "UPDATE orders SET status = 'cancelada', cancel_reason = 'Cliente no contesta', cancelled_at = now() WHERE public_token = $1",
      [third.token],
    ));
    assert.equal((await pub('GET', `/orders/${third.token}`)).body.order.status, 'cancelado');

    // El restaurante no puede tocar el envio.
    await assert.rejects(
      ctx.withTenant(R.id, (db) => db.query('UPDATE marketplace_orders SET delivery_fee = 0, driver_share = 0, platform_share = 0')),
      /Solo la plataforma/,
    );
  });

  test('en pausa o con el repartidor fuera de turno ya no se puede pedir', async () => {
    await api(R.token, 'POST', `/api/marketplace/listings/${branchId}/pause`, { minutes: 30 });
    assert.equal((await near(CERCA)).body.restaurants.length, 0);
    await api(R.token, 'POST', `/api/marketplace/listings/${branchId}/pause`, { minutes: 0 });
    await ctx.request('POST', '/api/fleet/duty', { token: driverToken, body: { on_duty: false } });
    assert.equal((await near(CERCA)).body.restaurants[0].reason, 'sin_repartidor');
    assert.equal((await pub('GET', '/orders/nope')).status, 404);
  });
});
