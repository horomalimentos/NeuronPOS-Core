// Apps instalables de Nayo: el servicio de la app pregunta por pedidos sin
// atender con un token de alertas que solo sirve para eso.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, ownerToken, setupDb, nayoShopper } from './helpers.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));
const CENTRO = { latitude: 31.7389, longitude: -106.4870 };
const CERCA = { latitude: 31.7569, longitude: -106.4870 };
const LEJOS = { latitude: 31.9500, longitude: -106.4870 };

describe('alertas de las apps de Nayo', { skip: SKIP_DB }, () => {
  let ctx; let R; let branchId; let taco; let shopper; let juan; let lalo;
  const api = (token, method, path, body) => ctx.request(method, path, { token, body });
  const pub = (method, path, body, token) => ctx.request(method, `/api/marketplace${path}`, { body, token });
  const alerts = (token) => ctx.request('GET', '/api/alertas', { token });

  before(async () => {
    ctx = await setupDb();
    shopper = await nayoShopper(ctx, { name: 'Maria Lopez', email: 'maria@alertas.test', phone: '6561234567', password: 'clave-cliente-1' });
    const owner = await ownerToken(ctx);
    const r = await pub('POST', '/restaurants', {
      name: 'Tacos Alerta', phone: '6561112222', address: 'Av. Juarez 100', location: CENTRO,
      admin: { name: 'Pepa', email: 'pepa@alertas.test', password: 'clave-segura-1' },
    });
    const login = await ctx.request('POST', '/api/auth/login', { slug: r.body.restaurant.slug, body: { email: 'pepa@alertas.test', password: 'clave-segura-1' } });
    R = { id: r.body.restaurant.id, token: login.body.token };
    branchId = (await api(R.token, 'GET', '/api/marketplace/listings')).body.listings[0].branch_id;
    const cat = (await api(R.token, 'POST', '/api/pos/categories', { name: 'Tacos' })).body.category;
    taco = (await api(R.token, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco', price: 25 })).body.item;
    await api(R.token, 'PUT', `/api/branches/${branchId}/hours`, { hours: ALL_DAY });
    await api(R.token, 'PUT', `/api/marketplace/listings/${branchId}`, { published: true });
    await ctx.request('POST', `/api/platform/marketplace/listings/${branchId}/approval`, { token: owner, body: { status: 'aprobado' } });
    const driver = async (name, email, base) => {
      const d = await pub('POST', '/drivers', { name, email, password: 'clave-segura-7', phone: '6560000000', vehicle: 'Moto', base, radius_km: 4 });
      await ctx.request('POST', `/api/platform/marketplace/drivers/${d.body.driver.id}/review`, { token: owner, body: { status: 'aprobado' } });
      await ctx.request('POST', '/api/fleet/duty', { token: d.body.token, body: { on_duty: true } });
      return d.body.token;
    };
    juan = await driver('Juan', 'juan@alertas.test', CERCA);
    lalo = await driver('Lalo', 'lalo@alertas.test', LEJOS);
  });
  after(async () => { await ctx?.close(); });

  test('el token de alertas solo sale con sesion y solo sirve para alertas', async () => {
    assert.equal((await ctx.request('POST', '/api/alertas/restaurante', {})).status, 401);
    assert.equal((await api(juan, 'POST', '/api/alertas/restaurante')).status, 401);
    assert.equal((await alerts(R.token)).status, 401, 'la sesion normal no sirve como token de alertas');
    const t = (await api(R.token, 'POST', '/api/alertas/restaurante')).body.token;
    assert.ok(t);
    assert.equal((await api(t, 'GET', '/api/marketplace/orders')).status, 401, 'el de alertas no abre el sistema');
    assert.equal((await api(t, 'GET', '/api/fleet/me')).status, 401);
  });

  test('restaurante: suena mientras el pedido no se acepta; repartidor: mientras nadie lo toma', async () => {
    const rest = (await api(R.token, 'POST', '/api/alertas/restaurante')).body.token;
    const moto = (await api(juan, 'POST', '/api/alertas/repartidor')).body.token;
    const lejos = (await api(lalo, 'POST', '/api/alertas/repartidor')).body.token;
    assert.deepEqual((await alerts(rest)).body.pending, []);

    const res = await ctx.request('POST', '/api/marketplace/orders', { token: shopper, body: {
      branch_id: branchId, items: [{ menu_item_id: taco.id, quantity: 4 }], location: CERCA,
      customer: { name: 'Maria Lopez', phone: '656 123 4567' }, address: { address: 'Calle Uno 123' },
    } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    let r = await alerts(rest);
    assert.equal(r.status, 200);
    assert.equal(r.body.app, 'restaurante');
    assert.equal(r.body.pending.length, 1);
    assert.match(r.body.pending[0].title, /^Nuevo pedido de Nayo #\d+ · \$100\.00$/);
    assert.equal(r.body.pending[0].link, '/admin/delivery');
    assert.deepEqual((await alerts(moto)).body.pending, [], 'sin aceptar no es de los repartidores');

    const id = r.body.pending[0].id;
    await api(R.token, 'POST', `/api/marketplace/orders/${id}/accept`, { prep_minutes: 10 });
    assert.deepEqual((await alerts(rest)).body.pending, [], 'aceptado: deja de sonar');
    r = await alerts(moto);
    assert.equal(r.body.pending.length, 1);
    assert.match(r.body.pending[0].title, /^Pedido disponible/);
    assert.deepEqual((await alerts(lejos)).body.pending, [], 'fuera de su zona no suena');

    await ctx.request('POST', `/api/fleet/marketplace/orders/${id}/take`, { token: juan });
    assert.deepEqual((await alerts(moto)).body.pending, [], 'tomado: deja de sonar');
  });

  test('cuenta desactivada: el token de alertas ya no sirve', async () => {
    const moto = (await api(lalo, 'POST', '/api/alertas/repartidor')).body.token;
    await ctx.withPlatform((db) => db.query("UPDATE fleet_drivers SET active = false WHERE email = 'lalo@alertas.test'"));
    assert.equal((await alerts(moto)).status, 401);
  });
});
