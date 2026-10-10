// Notificaciones push: suscripciones (personal, cliente con sesion, invitado
// por token), avisos generados por triggers sin importar la ruta, una sola
// entrega por aviso, modulo requerido, limpieza de suscripciones muertas y
// aislamiento entre restaurantes.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORM_DOMAIN, SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));
const sub = (name) => ({ endpoint: `https://push.example.com/${name}`, keys: { p256dh: `p256-${name}`, auth: `auth-${name}` } });

describe('notificaciones push', { skip: SKIP_DB }, () => {
  let ctx; let push; let owner; let A; let B; let branch; let taco; let anaToken; let cajero; let driver;
  const sent = [];
  const dead = new Set();
  const host = `alfa.${PLATFORM_DOMAIN}`;
  const api = (who, method, p, body) => ctx.request(method, p, { token: who.token ?? who, body });
  const portal = (method, p, body, token) => ctx.request(method, `/api/portal${p}`, { host, body, token });
  const pushApi = (method, p, body, token) => ctx.request(method, `/api/push${p}`, { host, body, token });
  const flush = async () => { sent.length = 0; await push.dispatchPushOutbox(); return sent.map((m) => [m.endpoint.split('/').pop(), m.payload]); };
  const to = (msgs, name) => msgs.filter(([n]) => n === name).map(([, p]) => p);

  async function login(slug, email, password) {
    return (await ctx.request('POST', '/api/auth/login', { slug, body: { email, password } })).body;
  }

  before(async () => {
    ctx = await setupDb();
    push = await import('../services/push.js');
    push.setPushSender(async (s, payload) => {
      if (dead.has(s.endpoint)) return { ok: false, gone: true };
      sent.push({ endpoint: s.endpoint, payload });
      return { ok: true };
    });
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos', 'portal', 'domicilios', 'push'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['pos', 'portal'] });
    branch = (await api(A, 'GET', '/api/branches')).body.branches[0];
    const cat = (await api(A, 'POST', '/api/pos/categories', { name: 'Tacos' })).body.category;
    taco = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco', price: 100 })).body.item;
    await api(A, 'PUT', `/api/branches/${branch.id}/hours`, { hours: ALL_DAY });
    await api(A, 'PATCH', '/api/online/settings', { enabled: true });
    await api(A, 'POST', '/api/users', { email: 'cajero@alfa.test', name: 'Caja', role: 'cajero', password: 'clave-segura-9', branch_ids: [branch.id] });
    cajero = await login('alfa', 'cajero@alfa.test', 'clave-segura-9');
    await api(A, 'POST', '/api/users', { email: 'pedro@alfa.test', name: 'Pedro', role: 'repartidor', password: 'clave-segura-9', branch_ids: [branch.id] });
    driver = await login('alfa', 'pedro@alfa.test', 'clave-segura-9');
    anaToken = (await portal('POST', '/auth/register', { name: 'Ana', email: 'ana@correo.mx', phone: '6561234567', password: 'clave-ana-12' })).body.token;
  });
  after(async () => {
    push?.setPushSender(null);
    await ctx?.close();
  });

  test('llave publica y suscripciones; sin el modulo responde 402', async () => {
    const key = await pushApi('GET', '/key');
    assert.equal(key.status, 200, JSON.stringify(key.body));
    assert.match(key.body.public_key, /^[A-Za-z0-9_-]{80,}$/);
    // Se genera una sola vez y queda guardada.
    assert.equal((await pushApi('GET', '/key')).body.public_key, key.body.public_key);

    const noModule = await ctx.request('GET', '/api/push/key', { host: `beta.${PLATFORM_DOMAIN}` });
    assert.equal(noModule.status, 402);

    assert.equal((await pushApi('POST', '/subscribe', { subscription: sub('admin') }, A.token)).status, 200);
    assert.equal((await pushApi('POST', '/subscribe', { subscription: sub('caja') }, cajero.token)).status, 200);
    assert.equal((await pushApi('POST', '/subscribe', { subscription: sub('pedro') }, driver.token)).status, 200);
    assert.equal((await pushApi('POST', '/customer/subscribe', { subscription: sub('ana') }, anaToken)).status, 200);
    const bad = await pushApi('POST', '/subscribe', { subscription: { endpoint: 'http://inseguro', keys: { p256dh: 'x', auth: 'y' } } }, A.token);
    assert.equal(bad.status, 400);
    assert.equal((await pushApi('POST', '/subscribe', { subscription: sub('x') })).status, 401);
    // Repetir la suscripcion no duplica.
    await pushApi('POST', '/subscribe', { subscription: sub('admin') }, A.token);
    const n = await ctx.withTenant(A.id, async (db) => (await db.query("SELECT count(*)::int AS n FROM push_subscriptions WHERE endpoint LIKE '%/admin'")).rows[0].n);
    assert.equal(n, 1);
  });

  test('pedido en linea: aviso al personal y al cliente en cada paso, una sola vez', async () => {
    const r = await portal('POST', '/orders', {
      branch_id: branch.id, order_type: 'para_llevar', items: [{ menu_item_id: taco.id, quantity: 2 }], payment: { method: 'efectivo' },
    }, anaToken);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.order.id;
    let msgs = await flush();
    assert.equal(to(msgs, 'admin').length, 1);
    assert.match(to(msgs, 'admin')[0].title, /Pedido en línea #\d+ · \$200\.00/);
    assert.equal(to(msgs, 'admin')[0].link, '/admin/pos?tab=linea');
    assert.equal(to(msgs, 'caja').length, 1, 'el cajero de la sucursal');
    assert.equal(to(msgs, 'pedro').length, 0, 'el repartidor no');
    assert.equal(to(msgs, 'ana').length, 0);
    assert.deepEqual(await flush(), [], 'no se repite');

    assert.equal((await api(cajero, 'POST', `/api/pos/online-orders/${id}/accept`, { prep_time_minutes: 20 })).status, 200);
    msgs = await flush();
    assert.equal(msgs.length, 1);
    assert.match(to(msgs, 'ana')[0].title, /Restaurante ALFA: pedido #\d+ aceptado/);
    assert.match(to(msgs, 'ana')[0].body, /listo cerca de las/);
    assert.match(to(msgs, 'ana')[0].link, /^\/pedido\/[A-Za-z0-9_-]+$/);

    assert.equal((await api(A, 'POST', `/api/pos/orders/${id}/ready`)).status, 200);
    msgs = await flush();
    assert.match(to(msgs, 'ana')[0].title, /está listo/);
    assert.match(to(msgs, 'ana')[0].body, /Ya puedes pasar por él/);
  });

  test('invitado por token, rechazo, y suscripcion muerta se borra', async () => {
    const r = await portal('POST', '/orders', {
      branch_id: branch.id, order_type: 'para_llevar', customer: { name: 'Invitado', phone: '6560000000' },
      items: [{ menu_item_id: taco.id, quantity: 1 }], payment: { method: 'efectivo' },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const token = r.body.order.token;
    assert.equal((await pushApi('POST', '/customer/subscribe', { subscription: sub('guest'), token })).status, 200);
    assert.equal((await pushApi('POST', '/customer/subscribe', { subscription: sub('guest'), token: 'x'.repeat(20) })).status, 404);
    await flush();
    dead.add(sub('caja').endpoint);
    const rej = await api(cajero, 'POST', `/api/pos/online-orders/${r.body.order.id}/reject`, { reason: 'Sin gas' });
    assert.equal(rej.status, 200);
    const msgs = await flush();
    assert.equal(to(msgs, 'guest').length, 1);
    assert.match(to(msgs, 'guest')[0].body, /Sin gas/);
    assert.equal(to(msgs, 'ana').length, 0, 'no es de Ana');

    // El aviso de un pedido nuevo al cajero falla con 410 y su suscripcion se borra.
    await portal('POST', '/orders', {
      branch_id: branch.id, order_type: 'para_llevar', items: [{ menu_item_id: taco.id, quantity: 1 }], payment: { method: 'efectivo' },
    }, anaToken);
    await flush();
    const left = await ctx.withTenant(A.id, async (db) => (await db.query("SELECT count(*)::int AS n FROM push_subscriptions WHERE endpoint LIKE '%/caja'")).rows[0].n);
    assert.equal(left, 0);
  });

  test('repartidor: aviso al asignarle un pedido; en camino al cliente', async () => {
    const r = await portal('POST', '/orders', {
      branch_id: branch.id, order_type: 'domicilio', address: { address: 'Calle Uno 123, Centro' },
      items: [{ menu_item_id: taco.id, quantity: 3 }], payment: { method: 'efectivo' },
    }, anaToken);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.order.id;
    await api(A, 'POST', `/api/pos/online-orders/${id}/accept`, {});
    await flush();
    const as = await api(A, 'POST', `/api/delivery/orders/${id}/assign`, { driver_user_id: driver.user.id });
    assert.equal(as.status, 201, JSON.stringify(as.body));
    let msgs = await flush();
    assert.equal(to(msgs, 'pedro').length, 1);
    assert.match(to(msgs, 'pedro')[0].title, /Nuevo pedido a domicilio #\d+/);
    assert.match(to(msgs, 'pedro')[0].body, /Calle Uno 123/);
    assert.equal(to(msgs, 'pedro')[0].driver, true);

    const onWay = [];
    for (const status of ['recogido', 'en_camino']) {
      const st = await api(driver, 'POST', `/api/delivery/driver/deliveries/${as.body.delivery.id}/status`, { status });
      assert.equal(st.status, 200, JSON.stringify(st.body));
      onWay.push(...to(await flush(), 'ana').filter((m) => /va en camino/.test(m.title)));
    }
    assert.equal(onWay.length, 1, 'una sola vez');
  });

  test('sin el modulo no se manda nada; otro restaurante no ve las suscripciones', async () => {
    const off = await api(owner, 'PUT', `/api/platform/restaurants/${A.id}/modules/push`, { enabled: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    await portal('POST', '/orders', {
      branch_id: branch.id, order_type: 'para_llevar', items: [{ menu_item_id: taco.id, quantity: 1 }], payment: { method: 'efectivo' },
    }, anaToken);
    assert.deepEqual(await flush(), []);
    const seen = await ctx.withTenant(B.id, async (db) => (await db.query('SELECT count(*)::int AS n FROM push_subscriptions')).rows[0].n);
    assert.equal(seen, 0);
  });
});
