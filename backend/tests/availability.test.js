// "Agotado hasta" con regreso automatico y pausa de pedidos en linea.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));

describe('agotado hasta y pausa en linea', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let branch; let taco; let cajero; let mesero;
  const api = (who, method, path, body) => ctx.request(method, path, { token: who.token ?? who, body });
  const login = async (email) => (await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email, password: 'clave-segura-9' } })).body.token;
  const order = (who = A) => api(who, 'POST', '/api/pos/orders', { branch_id: branch.id, order_type: 'para_llevar', items: [{ menu_item_id: taco.id, quantity: 1 }] });
  const menuItem = async () => (await api(A, 'GET', `/api/pos/menu?branch_id=${branch.id}`)).body.items.find((i) => i.id === taco.id);

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos', 'portal'] });
    branch = (await api(A, 'GET', '/api/branches')).body.branches[0];
    const cat = (await api(A, 'POST', '/api/pos/categories', { name: 'Menu' })).body.category;
    taco = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco', price: 100 })).body.item;
    for (const role of ['cajero', 'mesero']) {
      await api(A, 'POST', '/api/users', { email: `${role}@alfa.test`, name: role, role, password: 'clave-segura-9', branch_ids: [branch.id] });
    }
    cajero = await login('cajero@alfa.test');
    mesero = await login('mesero@alfa.test');
    await api(A, 'PUT', `/api/branches/${branch.id}/hours`, { hours: ALL_DAY });
    await api(A, 'PATCH', '/api/online/settings', { enabled: true });
  });
  after(() => ctx?.close());

  test('agotado por un rato y regreso automatico', async () => {
    assert.equal((await api(cajero, 'PUT', `/api/pos/items/${taco.id}/availability`, { branch_id: branch.id, available: false, minutes: 0 })).status, 400);
    const r = await api(cajero, 'PUT', `/api/pos/items/${taco.id}/availability`, { branch_id: branch.id, available: false, minutes: 90 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const it = await menuItem();
    assert.equal(it.available, false);
    assert.ok(Math.abs(new Date(it.available_at).getTime() - Date.now() - 90 * 60000) < 60000);
    assert.equal((await order()).body.code, 'ITEM_UNAVAILABLE');

    // Ya paso la hora: vuelve solo.
    const c = await ctx.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.restaurant_id', $1, true)", [A.id]);
      await c.query("UPDATE menu_item_branches SET unavailable_until = now() - interval '1 minute'");
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    assert.equal((await menuItem()).available, true);
    assert.equal((await order()).status, 201);

    // Sin minutos: hasta reactivarlo.
    await api(cajero, 'PUT', `/api/pos/items/${taco.id}/availability`, { branch_id: branch.id, available: false });
    const it2 = await menuItem();
    assert.deepEqual([it2.available, it2.available_at], [false, null]);
    assert.equal((await order()).body.code, 'ITEM_UNAVAILABLE');
    await api(cajero, 'PUT', `/api/pos/items/${taco.id}/availability`, { branch_id: branch.id, available: true });
    assert.equal((await menuItem()).available, true);
  });

  test('pausar pedidos en linea', async () => {
    assert.equal((await api(mesero, 'PUT', '/api/pos/online-pause', { branch_id: branch.id, minutes: 30 })).status, 403);
    assert.equal((await api(cajero, 'PUT', '/api/pos/online-pause', { branch_id: branch.id, minutes: 2 })).status, 400);
    const p = await api(cajero, 'PUT', '/api/pos/online-pause', { branch_id: branch.id, minutes: 30, message: 'Cocina llena, volvemos en media hora' });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.ok(p.body.paused_until);
    const site = await ctx.request('GET', '/api/portal/config', { slug: 'alfa' });
    const b = site.body.branches.find((x) => x.id === branch.id);
    assert.equal(b.open_now, false);
    assert.equal(b.paused_message, 'Cocina llena, volvemos en media hora');
    const body = {
      branch_id: branch.id, order_type: 'para_llevar', items: [{ menu_item_id: taco.id, quantity: 1 }],
      customer: { name: 'Ana', phone: '656 123 4567' }, payment: { provider: 'contra_entrega', method: 'efectivo' },
    };
    const blocked = await ctx.request('POST', '/api/portal/orders', { slug: 'alfa', body });
    assert.equal(blocked.body.code, 'BRANCH_PAUSED');
    assert.equal(blocked.body.error, 'Cocina llena, volvemos en media hora');
    // El POS sigue vendiendo.
    assert.equal((await order(cajero)).status, 201);

    assert.equal((await api(cajero, 'DELETE', `/api/pos/online-pause?branch_id=${branch.id}`)).body.paused_until, null);
    const ok = await ctx.request('POST', '/api/portal/orders', { slug: 'alfa', body });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  });
});
