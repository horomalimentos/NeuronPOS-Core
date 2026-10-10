// Canal en vivo (SSE): un cambio de orden avisa al instante a las pantallas de
// esa sucursal, no a las de otra ni a otro restaurante.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

describe('avisos en vivo', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B; let branch; let branch2; let taco;
  const api = (who, method, path, body) => ctx.request(method, path, { token: who.token ?? who, body });

  // Abre el canal y junta los eventos que lleguen.
  function listen(who, branchId) {
    const events = [];
    const req = http.get({ host: '127.0.0.1', port: ctx.port, path: `/api/live?branch_id=${branchId}`, headers: { authorization: `Bearer ${who.token ?? who}` } });
    const ready = new Promise((resolve, reject) => {
      req.on('response', (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          for (const m of chunk.matchAll(/event: (\w+)\ndata: (.*)\n/g)) events.push({ type: m[1], data: JSON.parse(m[2]) });
          if (chunk.includes('retry:')) resolve();
        });
      });
      req.on('error', reject);
    });
    return { events, ready, close: () => req.destroy() };
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['pos'] });
    branch = (await api(A, 'GET', '/api/branches')).body.branches[0];
    branch2 = (await api(A, 'POST', '/api/branches', { name: 'Centro' })).body.branch;
    const cat = (await api(A, 'POST', '/api/pos/categories', { name: 'Menu' })).body.category;
    taco = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco', price: 100 })).body.item;
  });
  after(() => ctx?.close());

  test('aviso a la sucursal de la orden', async () => {
    const mine = listen(A, branch.id);
    const other = listen(A, branch2.id);
    const otherRestaurant = listen(B, (await api(B, 'GET', '/api/branches')).body.branches[0].id);
    await Promise.all([mine.ready, other.ready, otherRestaurant.ready]);
    const o = (await api(A, 'POST', '/api/pos/orders', { branch_id: branch.id, order_type: 'para_llevar', items: [{ menu_item_id: taco.id, quantity: 1 }] })).body.order;
    await api(A, 'POST', `/api/pos/orders/${o.id}/send`);
    await wait(300);
    assert.ok(mine.events.length >= 2, JSON.stringify(mine.events));
    assert.deepEqual(mine.events[0], { type: 'orders', data: { branch_id: branch.id } });
    assert.equal(other.events.length, 0);
    assert.equal(otherRestaurant.events.length, 0);
    // Un error (400) no avisa.
    const before = mine.events.length;
    await api(A, 'POST', '/api/pos/orders', { branch_id: branch.id, order_type: 'para_llevar', items: [{ menu_item_id: taco.id, quantity: 0 }] });
    await wait(200);
    assert.equal(mine.events.length, before);
    [mine, other, otherRestaurant].forEach((l) => l.close());
    assert.equal((await api(A, 'GET', '/api/live')).status, 400, 'pide sucursal');
  });
});
