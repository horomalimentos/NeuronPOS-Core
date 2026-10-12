// Permisos por rol editables por restaurante: el admin prende o apaga
// capacidades del POS por rol; aplican al momento y no cruzan restaurantes.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

describe('permisos por rol', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B; let branchA; let mesero; let cajero; let gerente; let item;
  const api = (who, method, path, body) => ctx.request(method, path, { token: who.token ?? who, body });
  async function user(restaurant, slug, role) {
    const email = `${role}@${slug}.test`;
    await api(restaurant, 'POST', '/api/users', { email, name: role, role, password: 'clave-segura-9', branch_ids: [branchA.id] });
    return (await ctx.request('POST', '/api/auth/login', { slug, body: { email, password: 'clave-segura-9' } })).body.token;
  }
  const set = (role, capability, allowed) => api(A, 'PUT', '/api/permissions', { role, capability, allowed });

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['pos'] });
    branchA = (await api(A, 'GET', '/api/branches')).body.branches[0];
    mesero = await user(A, 'alfa', 'mesero');
    cajero = await user(A, 'alfa', 'cajero');
    gerente = await user(A, 'alfa', 'gerente');
    const cat = (await api(A, 'POST', '/api/pos/categories', { name: 'C' })).body.category;
    item = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Agua', price: 50 })).body.item;
  });
  after(() => ctx?.close());

  test('valores por omision y quien puede verlos o cambiarlos', async () => {
    const m = (await api(gerente, 'GET', '/api/permissions')).body;
    assert.ok(m.capabilities.some((c) => c.key === 'voidSent'));
    assert.ok(!m.roles.mesero.includes('cashier'));
    assert.equal((await api(cajero, 'GET', '/api/permissions')).status, 403);
    assert.equal((await api(gerente, 'PUT', '/api/permissions', { role: 'mesero', capability: 'cashier', allowed: true })).status, 403, 'solo el admin cambia');
    assert.equal((await set('admin', 'cashier', false)).status, 400, 'el admin no se edita');
    assert.equal((await set('mesero', 'inventarNada', true)).status, 400);
  });

  test('dar y quitar capacidades aplica de inmediato', async () => {
    assert.equal((await api(mesero, 'GET', `/api/pos/cash-sessions?branch_id=${branchA.id}`)).status, 403);
    const r = await set('mesero', 'cashier', true);
    assert.ok(r.body.roles.mesero.includes('cashier'));
    assert.equal((await api(mesero, 'GET', `/api/pos/cash-sessions?branch_id=${branchA.id}`)).status, 200);
    assert.ok((await api(mesero, 'GET', '/api/me')).body.capabilities.includes('cashier'));

    await set('cajero', 'cashier', false);
    assert.equal((await api(cajero, 'GET', `/api/pos/cash-sessions?branch_id=${branchA.id}`)).status, 403);
    await set('cajero', 'cashier', null);
    assert.equal((await api(cajero, 'GET', `/api/pos/cash-sessions?branch_id=${branchA.id}`)).status, 200, 'regresa al valor por omision');
  });

  test('quitar articulos enviados a cocina segun el permiso', async () => {
    const o = (await api(cajero, 'POST', '/api/pos/orders', { branch_id: branchA.id, order_type: 'para_llevar', items: [{ menu_item_id: item.id, quantity: 1 }, { menu_item_id: item.id, quantity: 1 }] })).body.order;
    await api(cajero, 'POST', `/api/pos/orders/${o.id}/send`);
    const del = (id) => api(cajero, 'DELETE', `/api/pos/orders/${o.id}/items/${id}?reason=${encodeURIComponent('cliente cambio')}`);
    assert.equal((await del(o.items[0].id)).status, 403);
    await set('cajero', 'voidSent', true);
    assert.equal((await del(o.items[0].id)).status, 200);
  });

  test('los permisos de A no cambian a B', async () => {
    const branchB = (await api(B, 'GET', '/api/branches')).body.branches[0];
    await api(B, 'POST', '/api/users', { email: 'mesero@beta.test', name: 'm', role: 'mesero', password: 'clave-segura-9', branch_ids: [branchB.id] });
    const mB = (await ctx.request('POST', '/api/auth/login', { slug: 'beta', body: { email: 'mesero@beta.test', password: 'clave-segura-9' } })).body.token;
    assert.equal((await api(mB, 'GET', `/api/pos/cash-sessions?branch_id=${branchB.id}`)).status, 403);
    assert.ok(!(await api(B, 'GET', '/api/permissions')).body.roles.mesero.includes('cashier'));
  });
});
