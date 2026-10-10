// Plano de mesas: guardar posiciones, forma y elementos de una zona.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

describe('plano de mesas', { skip: SKIP_DB }, () => {
  let ctx; let A; let branch; let zone; let zone2; let t1; let t2; let other; let mesero;
  const api = (who, method, path, body) => ctx.request(method, path, { token: who.token ?? who, body });

  before(async () => {
    ctx = await setupDb();
    const owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos'] });
    branch = (await api(A, 'GET', '/api/branches')).body.branches[0];
    zone = (await api(A, 'POST', '/api/pos/zones', { branch_id: branch.id, name: 'Salón' })).body.zone;
    zone2 = (await api(A, 'POST', '/api/pos/zones', { branch_id: branch.id, name: 'Terraza' })).body.zone;
    t1 = (await api(A, 'POST', '/api/pos/tables', { branch_id: branch.id, zone_id: zone.id, name: '1' })).body.table;
    t2 = (await api(A, 'POST', '/api/pos/tables', { branch_id: branch.id, zone_id: zone.id, name: '2', capacity: 6 })).body.table;
    other = (await api(A, 'POST', '/api/pos/tables', { branch_id: branch.id, zone_id: zone2.id, name: 'T1' })).body.table;
    await api(A, 'POST', '/api/users', { email: 'm@alfa.test', name: 'M', role: 'mesero', password: 'clave-segura-9', branch_ids: [branch.id] });
    mesero = (await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email: 'm@alfa.test', password: 'clave-segura-9' } })).body.token;
  });
  after(() => ctx?.close());

  test('guardar y leer el plano', async () => {
    const body = {
      map_enabled: true, map_width: 20, map_height: 12,
      tables: [{ id: t1.id, map_x: 1, map_y: 1, map_w: 2, map_h: 2, map_shape: 'redonda' }, { id: t2.id, map_x: 5, map_y: 1, map_w: 4, map_h: 2 }],
      objects: [{ kind: 'barra', label: 'Barra', x: 0, y: 10, w: 8, h: 2 }, { kind: 'puerta', x: 18, y: 5, w: 2, h: 1 }],
    };
    assert.equal((await api(mesero, 'PUT', `/api/pos/zones/${zone.id}/map`, body)).status, 403);
    assert.equal((await api(A, 'PUT', `/api/pos/zones/${zone.id}/map`, { ...body, objects: [{ kind: 'barra', x: 15, y: 0, w: 8, h: 1 }] })).body.code, 'OUT_OF_MAP');
    assert.equal((await api(A, 'PUT', `/api/pos/zones/${zone.id}/map`, { ...body, tables: [{ id: other.id, map_x: 0, map_y: 0 }] })).body.code, 'TABLE_NOT_IN_ZONE');
    assert.equal((await api(A, 'PUT', `/api/pos/zones/${zone.id}/map`, { ...body, objects: [{ kind: 'jacuzzi', x: 0, y: 0 }] })).status, 400);
    const r = await api(A, 'PUT', `/api/pos/zones/${zone.id}/map`, body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.zone.map_enabled, r.body.zone.map_width, r.body.zone.map_height], [true, 20, 12]);
    const data = (await api(mesero, 'GET', `/api/pos/tables?branch_id=${branch.id}`)).body;
    const a = data.tables.find((t) => t.id === t1.id);
    assert.deepEqual([a.map_x, a.map_y, a.map_shape, a.status], [1, 1, 'redonda', 'libre']);
    assert.equal(data.tables.find((t) => t.id === other.id).map_x, null);
    assert.deepEqual(data.objects.map((o) => o.kind).sort(), ['barra', 'puerta']);
    // Volver a guardar reemplaza los elementos; quitar una mesa del plano.
    await api(A, 'PUT', `/api/pos/zones/${zone.id}/map`, { ...body, tables: [{ id: t2.id, map_x: null }], objects: [] });
    const again = (await api(A, 'GET', `/api/pos/tables?branch_id=${branch.id}`)).body;
    assert.equal(again.objects.length, 0);
    assert.equal(again.tables.find((t) => t.id === t2.id).map_x, null);
    assert.equal(again.tables.find((t) => t.id === t1.id).map_x, 1, 'la que no viene queda igual');
  });
});
