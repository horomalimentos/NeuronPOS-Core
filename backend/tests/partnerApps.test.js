// Apps Nayo Partner y Panel: horas conectado, numeros del restaurante y
// avisos push del Panel cuando se registra un restaurante o repartidor.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, ownerToken, setupDb, nayoShopper } from './helpers.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));
const CENTRO = { latitude: 31.7389, longitude: -106.4870 };
const CERCA = { latitude: 31.7569, longitude: -106.4870 };
const sub = (name) => ({ endpoint: `https://push.example.com/${name}`, keys: { p256dh: `p256-${name}`, auth: `auth-${name}` } });

describe('Apps Partner y Panel', { skip: SKIP_DB }, () => {
  let ctx; let owner; let R; let branchId; let taco; let shopper; let juan;
  const sent = [];
  const api = (token, method, path, body) => ctx.request(method, path, { token, body });
  const pub = (method, path, body, token) => ctx.request(method, `/api/marketplace${path}`, { body, token });
  const fleet = (method, path, body) => ctx.request(method, `/api/fleet${path}`, { token: juan, body });

  before(async () => {
    ctx = await setupDb();
    (await import('../services/push.js')).setPushSender(async (s, payload) => { sent.push({ endpoint: s.endpoint, payload }); return { ok: true }; });
    owner = await ownerToken(ctx);
    assert.equal((await api(owner, 'POST', '/api/platform/push/subscribe', { subscription: sub('alex') })).status, 201);
    assert.equal((await api(owner, 'POST', '/api/platform/push/subscribe', { subscription: { endpoint: 'http://x' } })).body.code, 'INVALID_SUBSCRIPTION');
    shopper = await nayoShopper(ctx, { name: 'Maria Lopez', email: 'maria@cliente.test', phone: '6561234567', password: 'clave-cliente-1' });
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
    const d = await pub('POST', '/drivers', { name: 'Juan', email: 'juan@moto.test', password: 'clave-segura-7', phone: '6560000000', vehicle: 'Moto', base: CERCA, radius_km: 4 });
    juan = d.body.token;
    await api(owner, 'POST', `/api/platform/marketplace/drivers/${d.body.driver.id}/review`, { status: 'aprobado' });
    await fleet('POST', '/duty', { on_duty: true });
  });
  after(async () => { (await import('../services/push.js')).setPushSender(null); await ctx?.close(); });

  test('Panel: aviso al registrarse un restaurante y un repartidor', () => {
    const titles = sent.filter((m) => m.endpoint.endsWith('/alex')).map((m) => m.payload);
    assert.deepEqual(titles.map((p) => p.title), ['Nuevo restaurante en Nayo', 'Nuevo repartidor en Nayo']);
    assert.match(titles[0].body, /Tacos Pepa/);
    assert.equal(titles[0].link, '/panel/delivery');
    assert.equal(titles[0].icon, '/icons/panel-192.png');
  });

  test('horas conectado: solo con la ficha aprobada y sin pausa', async () => {
    // Aun sin aprobar: no cuenta.
    assert.deepEqual((await api(R.token, 'POST', '/api/marketplace/presence', {})).body, { online: 0 });
    await api(owner, 'POST', `/api/platform/marketplace/listings/${branchId}/approval`, { status: 'aprobado' });
    assert.deepEqual((await api(R.token, 'POST', '/api/marketplace/presence', { branch_id: branchId })).body, { online: 1 });
    // El mismo minuto no se cuenta dos veces.
    assert.deepEqual((await api(R.token, 'POST', '/api/marketplace/presence', {})).body, { online: 0 });
    await api(R.token, 'POST', `/api/marketplace/listings/${branchId}/pause`, { minutes: 30 });
    await ctx.withPlatform((db) => db.query("DELETE FROM nayo_online_minutes"));
    assert.deepEqual((await api(R.token, 'POST', '/api/marketplace/presence', {})).body, { online: 0 });
    await api(R.token, 'POST', `/api/marketplace/listings/${branchId}/pause`, { minutes: 0 });
    // 90 minutos conectados hoy.
    await ctx.withPlatform((db) => db.query(
      `INSERT INTO nayo_online_minutes (restaurant_id, branch_id, minute)
       SELECT $1, $2, date_trunc('minute', now()) - make_interval(mins => g) FROM generate_series(0, 89) g`,
      [R.id, branchId],
    ));
  });

  test('numeros: ventas, pedidos, tiempos y productos', async () => {
    const order = async (quantity) => {
      const res = await ctx.request('POST', '/api/marketplace/orders', { token: shopper, body: {
        branch_id: branchId, items: [{ menu_item_id: taco.id, quantity }], location: CERCA,
        customer: { name: 'Maria Lopez', phone: '656 123 4567' }, address: { address: 'Calle Uno 123' },
      } });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return (await api(R.token, 'GET', '/api/marketplace/orders')).body.orders.find((o) => o.status === 'nuevo');
    };
    const a = await order(4);
    await api(R.token, 'POST', `/api/marketplace/orders/${a.id}/accept`, { prep_minutes: 10 });
    await fleet('POST', `/marketplace/orders/${a.id}/take`);
    await api(R.token, 'POST', `/api/marketplace/orders/${a.id}/ready`);
    await fleet('POST', `/marketplace/orders/${a.id}/pickup`);
    assert.equal((await fleet('POST', `/marketplace/orders/${a.id}/deliver`)).status, 200);
    const b = await order(2);
    await api(R.token, 'POST', `/api/marketplace/orders/${b.id}/reject`, { reason: 'Se nos agotó un producto' });

    assert.equal((await api(R.token, 'GET', '/api/marketplace/stats?days=3')).body.code, 'INVALID_FIELD');
    const r = await api(R.token, 'GET', '/api/marketplace/stats?days=7');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = r.body;
    assert.equal(s.daily.length, 7);
    assert.equal(s.hourly.length, 24);
    assert.equal(s.current.orders, 2);
    assert.equal(s.current.delivered, 1);
    assert.equal(s.current.lost, 1);
    assert.equal(s.current.sales, 100);
    assert.equal(s.current.avg_ticket, 100);
    assert.equal(s.current.acceptance_pct, 50);
    assert.equal(s.current.online_hours, 1.5);
    assert.equal(s.previous.orders, 0);
    assert.equal(s.daily.at(-1).sales, 100);
    assert.equal(s.daily.at(-1).online_hours, 1.5);
    assert.equal(s.scheduled_hours, 7 * 24, 'abierto todo el dia, 7 dias');
    assert.deepEqual(s.top_products, [{ name: 'Taco', quantity: 4, total: 100 }]);

    const today = (await api(R.token, 'GET', `/api/marketplace/stats?days=1&branch_id=${branchId}`)).body;
    assert.equal(today.daily.length, 1);
    assert.equal(today.current.orders, 2);
  });

  test('otro restaurante no ve los numeros ni puede pedirlos sin sesion', async () => {
    assert.equal((await ctx.request('GET', '/api/marketplace/stats')).status, 401);
    const r2 = await pub('POST', '/restaurants', {
      name: 'Pizzas Lalo', phone: '6561113333', address: 'Av. Juarez 200', location: CENTRO,
      admin: { name: 'Lalo', email: 'lalo@pizza.test', password: 'clave-segura-2' },
    });
    const login = await ctx.request('POST', '/api/auth/login', { slug: r2.body.restaurant.slug, body: { email: 'lalo@pizza.test', password: 'clave-segura-2' } });
    const s = (await api(login.body.token, 'GET', '/api/marketplace/stats?days=30')).body;
    assert.equal(s.current.orders, 0);
    assert.equal(s.current.online_hours, 0);
    const foreign = await api(login.body.token, 'GET', `/api/marketplace/stats?days=7&branch_id=${branchId}`);
    assert.equal(foreign.body.current.orders, 0);
  });

  test('Panel: dejar de recibir avisos', async () => {
    await api(owner, 'POST', '/api/platform/push/unsubscribe', { endpoint: sub('alex').endpoint });
    const left = await ctx.withPlatform((db) => db.query('SELECT count(*)::int AS n FROM platform_push_subscriptions'));
    assert.equal(left.rows[0].n, 0);
  });
});
