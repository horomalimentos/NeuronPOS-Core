// Nayo: notificaciones del sistema para cliente, restaurante y repartidor.
// Los triggers encolan sin importar quien hizo el cambio (restaurante,
// repartidor o plataforma) y cada aviso sale una sola vez.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, ownerToken, setupDb, nayoShopper } from './helpers.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));
const CENTRO = { latitude: 31.7389, longitude: -106.4870 };
const CERCA = { latitude: 31.7569, longitude: -106.4870 };
const LEJOS = { latitude: 31.9500, longitude: -106.4870 };
const sub = (name) => ({ endpoint: `https://push.example.com/${name}`, keys: { p256dh: `p256-${name}`, auth: `auth-${name}` } });

describe('Nayo: notificaciones push', { skip: SKIP_DB }, () => {
  let ctx; let owner; let R; let branchId; let taco; let shopper; let juan; let lejos; let nayoPush;
  const sent = [];
  const api = (token, method, path, body) => ctx.request(method, path, { token, body });
  const pub = (method, path, body, token) => ctx.request(method, `/api/marketplace${path}`, { body, token });
  const flush = async () => { sent.length = 0; await nayoPush.dispatchNayoPush(); return sent.map((m) => [m.endpoint.split('/').pop(), m.payload]); };
  const to = (msgs, name) => msgs.filter(([n]) => n === name).map(([, p]) => p);

  before(async () => {
    ctx = await setupDb();
    (await import('../services/push.js')).setPushSender(async (s, payload) => { sent.push({ endpoint: s.endpoint, payload }); return { ok: true }; });
    nayoPush = await import('../services/nayoPush.js');
    shopper = await nayoShopper(ctx, { name: 'Maria Lopez', email: 'maria@cliente.test', phone: '6561234567', password: 'clave-cliente-1' });
    owner = await ownerToken(ctx);
    const r = await pub('POST', '/restaurants', {
      name: 'Tacos Pepa', phone: '6561112222', address: 'Av. Juarez 100', location: CENTRO,
      admin: { name: 'Pepa', email: 'pepa@tacos.test', password: 'clave-segura-1' },
    });
    const login = await ctx.request('POST', '/api/auth/login', { slug: r.body.restaurant.slug, body: { email: 'pepa@tacos.test', password: 'clave-segura-1' } });
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
    juan = await driver('Juan', 'juan@moto.test', CERCA);
    lejos = await driver('Lalo', 'lalo@moto.test', LEJOS);
  });
  after(async () => { (await import('../services/push.js')).setPushSender(null); await ctx?.close(); });

  test('suscripciones de cada app', async () => {
    assert.ok((await pub('GET', '/push/key')).body.public_key);
    assert.equal((await pub('POST', '/push/cliente', { subscription: sub('maria') })).status, 401);
    assert.equal((await pub('POST', '/push/cliente', { subscription: { endpoint: 'http://x' } }, shopper)).body.code, 'INVALID_SUBSCRIPTION');
    assert.equal((await pub('POST', '/push/cliente', { subscription: sub('maria'), link_base: '/nayo' }, shopper)).status, 200);
    assert.equal((await pub('POST', '/push/repartidor', { subscription: sub('juan') }, juan)).status, 200);
    assert.equal((await pub('POST', '/push/repartidor', { subscription: sub('lalo') }, lejos)).status, 200);
    assert.equal((await pub('POST', '/push/repartidor', { subscription: sub('x') }, shopper)).status, 401);
    assert.equal((await api(R.token, 'POST', '/api/marketplace/push/subscribe', { subscription: sub('pepa') })).status, 200);
  });

  test('aviso de prueba solo a los dispositivos del cliente', async () => {
    sent.length = 0;
    const r = await pub('POST', '/push/cliente/test', {}, shopper);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { devices: 1, sent: 1 });
    assert.deepEqual(sent.map((m) => m.endpoint.split('/').pop()), ['maria']);
    assert.equal(sent[0].payload.link, '/nayo');
    assert.equal((await pub('POST', '/push/cliente/test', {})).status, 401);
    const otro = await nayoShopper(ctx, { name: 'Sin Avisos', email: 'sin@cliente.test', phone: '6569998888', password: 'clave-cliente-2' });
    assert.equal((await pub('POST', '/push/cliente/test', {}, otro)).body.code, 'PUSH_NOT_ENABLED');
    sent.length = 0;
  });

  test('pedido: restaurante, cliente y repartidores de la zona', async () => {
    const res = await ctx.request('POST', '/api/marketplace/orders', { token: shopper, body: {
      branch_id: branchId, items: [{ menu_item_id: taco.id, quantity: 4 }], location: CERCA,
      customer: { name: 'Maria Lopez', phone: '656 123 4567' }, address: { address: 'Calle Uno 123' },
    } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const token = res.body.order.token;
    let msgs = await flush();
    const [nuevo] = to(msgs, 'pepa');
    assert.match(nuevo.title, /^Nuevo pedido de Nayo #\d+ · \$100\.00$/);
    assert.equal(nuevo.link, '/admin/delivery');
    assert.equal(nuevo.badge, '/icons/nayo-restaurante-badge.png');
    assert.equal(nuevo.icon, '/icons/nayo-restaurante-192.png');
    assert.equal(msgs.length, 1);
    assert.deepEqual(await flush(), [], 'cada aviso sale una sola vez');

    const order = (await api(R.token, 'GET', '/api/marketplace/orders')).body.orders[0];
    await api(R.token, 'POST', `/api/marketplace/orders/${order.id}/accept`, { prep_minutes: 10 });
    msgs = await flush();
    const [acc] = to(msgs, 'maria');
    assert.equal(acc.title, 'Tacos Pepa aceptó tu pedido');
    assert.equal(acc.link, `/nayo/pedido/${token}`);
    const [disp] = to(msgs, 'juan');
    assert.match(disp.title, /^Pedido disponible/);
    assert.equal(disp.driver, true);
    assert.equal(disp.badge, '/icons/nayo-repartidor-badge.png');
    assert.equal(to(msgs, 'lalo').length, 0, 'solo los que cubren al restaurante');

    // Chat: le llega a los otros dos.
    const fleet = (t, m, p, b) => ctx.request(m, `/api/fleet${p}`, { token: t, body: b });
    await fleet(juan, 'POST', `/marketplace/orders/${order.id}/take`);
    await pub('POST', `/orders/${token}/messages`, { body: 'Porton azul' });
    msgs = await flush();
    assert.equal(to(msgs, 'pepa')[0].body, 'Porton azul');
    assert.equal(to(msgs, 'juan')[0].body, 'Porton azul');
    assert.equal(to(msgs, 'maria').length, 0);

    await api(R.token, 'POST', `/api/marketplace/orders/${order.id}/ready`);
    await fleet(juan, 'POST', `/marketplace/orders/${order.id}/pickup`);
    msgs = await flush();
    assert.equal(to(msgs, 'maria')[0].title, 'Tu pedido va en camino');
    await fleet(juan, 'POST', `/marketplace/orders/${order.id}/deliver`);
    msgs = await flush();
    assert.equal(to(msgs, 'maria')[0].title, 'Pedido entregado');

    // Dejar de recibir.
    await pub('POST', '/push/cliente/off', { endpoint: sub('maria').endpoint }, shopper);
    const left = await ctx.withPlatform((db) => db.query('SELECT count(*)::int AS n FROM nayo_push_subscriptions WHERE customer_id IS NOT NULL'));
    assert.equal(left.rows[0].n, 0);
  });
});
