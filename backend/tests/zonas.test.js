// Zonas de entrega: tramos por distancia desde el centro de la sucursal,
// domicilio fuera de zona rechazado, pin obligatorio al pedir (no al
// cotizar), pedido minimo de la zona, direcciones guardadas con pin y
// modulo requerido.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORM_DOMAIN, SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';
import { haversineKm, quoteZone, readTiers } from '../services/deliveryZones.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));
// Centro: Juarez. ~1.1 km al norte por cada 0.01 grados de latitud.
const CENTER = { latitude: 31.7, longitude: -106.4 };
const north = (km) => ({ latitude: CENTER.latitude + km / 111.2, longitude: CENTER.longitude });

test('distancia y tramos (sin BD)', () => {
  assert.ok(Math.abs(haversineKm(CENTER, north(3)) - 3) < 0.01);
  const tiers = readTiers([{ radius_km: 4, fee: 45 }, { radius_km: 2, fee: 30 }]);
  assert.deepEqual(tiers.map((t) => t.radius_km), [2, 4]);
  assert.throws(() => readTiers([{ radius_km: 2, fee: 1 }, { radius_km: 2, fee: 2 }]), /mismo radio/);
  assert.throws(() => readTiers([]), /tramos/);
  const zone = { center: CENTER, tiers, min_order: 0 };
  assert.equal(quoteZone(zone, north(1.5)).fee, 30);
  assert.equal(quoteZone(zone, north(3)).fee, 45);
  assert.throws(() => quoteZone(zone, north(5)), (e) => e.code === 'OUT_OF_ZONE');
});

describe('zonas de entrega', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let branch; let taco; let anaToken;
  const host = `alfa.${PLATFORM_DOMAIN}`;
  const api = (who, method, p, body) => ctx.request(method, p, { token: who.token ?? who, body });
  const portal = (method, p, body, token) => ctx.request(method, `/api/portal${p}`, { host, body, token });
  const order = (extra, token = anaToken, path = '/orders') => portal('POST', path, {
    branch_id: branch.id, order_type: 'domicilio', items: [{ menu_item_id: taco.id, quantity: 2 }],
    payment: { method: 'efectivo' }, ...extra,
  }, token);

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos', 'portal', 'domicilios', 'zonas_entrega'] });
    branch = (await api(A, 'GET', '/api/branches')).body.branches[0];
    const cat = (await api(A, 'POST', '/api/pos/categories', { name: 'Tacos' })).body.category;
    taco = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco', price: 100 })).body.item;
    await api(A, 'PUT', `/api/branches/${branch.id}/hours`, { hours: ALL_DAY });
    await api(A, 'PATCH', '/api/online/settings', { enabled: true });
    await api(A, 'PUT', `/api/online/branches/${branch.id}`, { delivery_fee: 25 });
    anaToken = (await portal('POST', '/auth/register', { name: 'Ana', email: 'ana@correo.mx', phone: '6561234567', password: 'clave-ana-12' })).body.token;
  });
  after(() => ctx?.close());

  test('el administrador configura la zona y el sitio la ve', async () => {
    const bad = await api(A, 'PUT', `/api/online/branches/${branch.id}/zone`, { center: CENTER, tiers: [] });
    assert.equal(bad.status, 400);
    const r = await api(A, 'PUT', `/api/online/branches/${branch.id}/zone`, {
      center: CENTER, tiers: [{ radius_km: 4, fee: 45 }, { radius_km: 2, fee: 30 }], min_order: 150,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.zone.tiers, [{ radius_km: 2, fee: 30 }, { radius_km: 4, fee: 45 }]);
    const cfg = (await portal('GET', '/config')).body.branches[0];
    assert.equal(cfg.delivery_zone.tiers.length, 2);
    assert.equal(Number(cfg.delivery_fee), 30, 'muestra "desde" el primer tramo');
  });

  test('cotiza por distancia, rechaza fuera de zona y pide el pin al ordenar', async () => {
    const q0 = await order({}, anaToken, '/quote');
    assert.equal(q0.status, 200, JSON.stringify(q0.body));
    assert.equal(q0.body.delivery_location_required, true);
    const q1 = await order({ location: north(3) }, anaToken, '/quote');
    assert.equal(q1.body.delivery_fee, 45);
    assert.ok(Math.abs(q1.body.delivery_distance_km - 3) < 0.05);
    const far = await order({ location: north(6) }, anaToken, '/quote');
    assert.equal(far.status, 400);
    assert.equal(far.body.code, 'OUT_OF_ZONE');

    const noPin = await order({ address: { address: 'Calle Uno 1' } });
    assert.equal(noPin.body.code, 'LOCATION_REQUIRED');
    const small = await order({ address: { address: 'Calle Uno 1' }, location: north(1), items: [{ menu_item_id: taco.id, quantity: 1 }] });
    assert.equal(small.body.code, 'BELOW_MIN_ORDER');

    const ok = await order({ address: { address: 'Calle Uno 1' }, location: north(1), save_address: true });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(Number(ok.body.order.delivery_fee), 30);
    const row = await ctx.withTenant(A.id, async (db) => (await db.query(
      'SELECT delivery_latitude, delivery_distance_km FROM orders WHERE id = $1', [ok.body.order.id])).rows[0]);
    assert.ok(row.delivery_latitude !== null);
    assert.ok(Math.abs(Number(row.delivery_distance_km) - 1) < 0.05);

    // La direccion guardada conserva el pin y sirve para el siguiente pedido.
    const me = (await portal('GET', '/me', undefined, anaToken)).body;
    const saved = me.addresses[0];
    assert.ok(saved.latitude !== null);
    const again = await order({ address_id: saved.id });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(Number(again.body.order.delivery_fee), 30);
  });

  test('sin el modulo vuelve la tarifa fija y no pide pin', async () => {
    const off = await api(owner, 'PUT', `/api/platform/restaurants/${A.id}/modules/zonas_entrega`, { enabled: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const r = await order({ address: { address: 'Lejos 9' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(Number(r.body.order.delivery_fee), 25);
    assert.equal((await portal('GET', '/config')).body.branches[0].delivery_zone, null);
    assert.equal((await api(A, 'GET', '/api/online/zones')).status, 402);
  });
});
