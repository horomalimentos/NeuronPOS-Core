// Cocina: tiempos configurables, vista de listas y regresar a cocina.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

describe('cocina: listas y tiempos', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let branch; let taco; let cocina; let mesero; let o;
  const api = (who, method, path, body) => ctx.request(method, path, { token: who.token ?? who, body });
  const login = async (email) => (await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email, password: 'clave-segura-9' } })).body.token;
  const kitchen = (view = '') => api(cocina, 'GET', `/api/pos/kitchen?branch_id=${branch.id}${view ? `&view=${view}` : ''}`);

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos'] });
    branch = (await api(A, 'GET', '/api/branches')).body.branches[0];
    const cat = (await api(A, 'POST', '/api/pos/categories', { name: 'Menu' })).body.category;
    taco = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco', price: 100 })).body.item;
    for (const role of ['cocina', 'mesero']) {
      await api(A, 'POST', '/api/users', { email: `${role}@alfa.test`, name: role, role, password: 'clave-segura-9', branch_ids: [branch.id] });
    }
    cocina = await login('cocina@alfa.test');
    mesero = await login('mesero@alfa.test');
  });
  after(() => ctx?.close());

  test('tiempos de la pantalla configurables', async () => {
    const s = (await api(A, 'GET', '/api/pos/settings')).body.settings;
    assert.deepEqual([s.kitchen_warn_minutes, s.kitchen_late_minutes], [10, 20]);
    assert.equal((await api(A, 'PATCH', '/api/pos/settings', { kitchen_warn_minutes: 30 })).body.code, 'INVALID_FIELD', 'rojo debe ser mayor');
    const r = await api(A, 'PATCH', '/api/pos/settings', { kitchen_warn_minutes: 8, kitchen_late_minutes: 15 });
    assert.deepEqual([r.body.settings.kitchen_warn_minutes, r.body.settings.kitchen_late_minutes], [8, 15]);
  });

  test('listas y regresar a cocina', async () => {
    o = (await api(mesero, 'POST', '/api/pos/orders', { branch_id: branch.id, order_type: 'para_llevar', items: [{ menu_item_id: taco.id, quantity: 2 }], send: true })).body.order;
    if (!o.sent_at) o = (await api(mesero, 'POST', `/api/pos/orders/${o.id}/send`)).body.order;
    assert.equal((await kitchen()).body.orders.length, 1);
    assert.equal((await kitchen('listas')).body.orders.length, 0);
    await api(cocina, 'POST', `/api/pos/orders/${o.id}/ready`);
    assert.equal((await kitchen()).body.orders.length, 0);
    const listas = (await kitchen('listas')).body.orders;
    assert.equal(listas.length, 1);
    assert.equal(listas[0].status, 'lista');

    assert.equal((await api(mesero, 'POST', `/api/pos/orders/${o.id}/unready`)).status, 403);
    const back = await api(cocina, 'POST', `/api/pos/orders/${o.id}/unready`);
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.order.status, 'enviada');
    assert.equal((await kitchen()).body.orders.length, 1);
    assert.equal((await kitchen('listas')).body.orders.length, 0);
    assert.equal((await api(cocina, 'POST', `/api/pos/orders/${o.id}/unready`)).body.code, 'NOTHING_READY');
  });
});
