// Aislamiento entre restaurantes: un usuario del restaurante A nunca puede
// leer ni modificar datos del restaurante B, ni por la API ni a nivel BD.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb, PLATFORM_DOMAIN } from './helpers.js';

describe('aislamiento multi-restaurante', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B; let branchA; let branchB; let userB;

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos'] });
    B = await createRestaurant(ctx, owner, 'beta');
    branchA = (await ctx.request('GET', '/api/branches', { token: A.token })).body.branches[0];
    branchB = (await ctx.request('GET', '/api/branches', { token: B.token })).body.branches[0];
    userB = (await ctx.request('GET', '/api/users', { token: B.token })).body.users[0];
  });
  after(() => ctx?.close());

  test('cada restaurante solo ve sus sucursales y usuarios', async () => {
    const branches = await ctx.request('GET', '/api/branches', { token: A.token });
    assert.equal(branches.status, 200);
    assert.deepEqual(branches.body.branches.map((b) => b.id), [branchA.id]);
    const users = await ctx.request('GET', '/api/users', { token: A.token });
    assert.deepEqual(users.body.users.map((u) => u.email), [A.email]);
  });

  test('un token de A no sirve en el tenant de B (header o Host)', async () => {
    const byHeader = await ctx.request('GET', '/api/branches', { token: A.token, slug: 'beta' });
    assert.equal(byHeader.status, 403);
    assert.equal(byHeader.body.code, 'TENANT_MISMATCH');
    const byHost = await ctx.request('GET', '/api/me', { token: A.token, host: `beta.${PLATFORM_DOMAIN}` });
    assert.equal(byHost.status, 403);
    assert.equal(byHost.body.code, 'TENANT_MISMATCH');
  });

  test('A no puede leer, editar ni borrar registros de B por id', async () => {
    assert.equal((await ctx.request('GET', `/api/users/${userB.id}`, { token: A.token })).status, 404);
    assert.equal((await ctx.request('PATCH', `/api/users/${userB.id}`, { token: A.token, body: { name: 'hack' } })).status, 404);
    assert.equal((await ctx.request('DELETE', `/api/users/${userB.id}`, { token: A.token })).status, 404);
    assert.equal((await ctx.request('PATCH', `/api/branches/${branchB.id}`, { token: A.token, body: { name: 'hack' } })).status, 404);
    assert.equal((await ctx.request('DELETE', `/api/branches/${branchB.id}`, { token: A.token })).status, 404);
    const still = await ctx.request('GET', '/api/users', { token: B.token });
    assert.equal(still.body.users[0].name, userB.name);
  });

  test('A no puede asignar una sucursal de B a sus usuarios', async () => {
    const res = await ctx.request('POST', '/api/users', {
      token: A.token,
      body: { email: 'cajero@alfa.test', name: 'Cajero', role: 'cajero', password: 'clave-segura-2', branch_ids: [branchB.id] },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'BRANCH_NOT_FOUND');
  });

  test('las credenciales de B no inician sesion en A', async () => {
    const res = await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email: B.email, password: B.password } });
    assert.equal(res.status, 401);
  });

  test('tenant por Host: subdominio y dominio propio', async () => {
    const sub = await ctx.request('GET', '/api/public/site', { host: `beta.${PLATFORM_DOMAIN}` });
    assert.equal(sub.status, 200);
    assert.equal(sub.body.restaurant.slug, 'beta');
    await ctx.request('PATCH', `/api/platform/restaurants/${A.id}`, { token: owner, body: { custom_domain: 'www.alfa-sushi.mx' } });
    const custom = await ctx.request('GET', '/api/public/site', { host: 'www.alfa-sushi.mx' });
    assert.equal(custom.body.restaurant.slug, 'alfa');
    assert.deepEqual(custom.body.modules, ['pos']);
    const unknown = await ctx.request('GET', '/api/public/site', { host: `gamma.${PLATFORM_DOMAIN}`, slug: 'alfa' });
    assert.equal(unknown.status, 404, 'si el Host apunta a un restaurante inexistente el header no lo rescata');
  });

  test('tokens de plataforma y de restaurante no son intercambiables', async () => {
    assert.equal((await ctx.request('GET', '/api/me', { token: owner })).status, 401);
    const r = await ctx.request('GET', '/api/platform/restaurants', { token: A.token });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'PLATFORM_ONLY');
  });

  test('roles: un cajero no administra usuarios', async () => {
    await ctx.request('POST', '/api/users', {
      token: A.token,
      body: { email: 'caja@alfa.test', name: 'Caja', role: 'cajero', password: 'clave-segura-3', branch_ids: [branchA.id] },
    });
    const login = await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email: 'caja@alfa.test', password: 'clave-segura-3' } });
    assert.equal(login.status, 200);
    const res = await ctx.request('GET', '/api/users', { token: login.body.token });
    assert.equal(res.status, 403);
    const me = await ctx.request('GET', '/api/me', { token: login.body.token });
    assert.deepEqual(me.body.branches.map((b) => b.id), [branchA.id]);
  });

  describe('RLS en la base de datos', () => {
    test('sin contexto de restaurante no se ve nada (falla cerrado)', async () => {
      const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM users');
      assert.equal(rows[0].n, 0);
      const b = await ctx.pool.query('SELECT count(*)::int AS n FROM branches');
      assert.equal(b.rows[0].n, 0);
    });

    test('con contexto de A, una consulta sin WHERE solo regresa filas de A', async () => {
      const ids = await ctx.withTenant(A.id, async (db) =>
        (await db.query('SELECT DISTINCT restaurant_id FROM users')).rows.map((r) => r.restaurant_id));
      assert.deepEqual(ids, [A.id]);
    });

    test('con contexto de A no se pueden insertar ni modificar filas de B', async () => {
      await assert.rejects(
        ctx.withTenant(A.id, (db) => db.query("INSERT INTO branches (restaurant_id, name) VALUES ($1, 'intrusa')", [B.id])),
        /row-level security/,
      );
      const upd = await ctx.withTenant(A.id, (db) => db.query("UPDATE branches SET name = 'x' WHERE restaurant_id = $1", [B.id]));
      assert.equal(upd.rowCount, 0);
    });

    test('el contexto no se filtra entre requests del pool', async () => {
      await ctx.withTenant(A.id, (db) => db.query('SELECT 1'));
      const { rows } = await ctx.pool.query("SELECT coalesce(current_setting('app.restaurant_id', true), '') AS rid");
      assert.equal(rows[0].rid, '');
    });

    test('el contexto de plataforma ve todos los restaurantes', async () => {
      const n = await ctx.withPlatform(async (db) => (await db.query('SELECT count(DISTINCT restaurant_id)::int AS n FROM branches')).rows[0].n);
      assert.equal(n, 2);
    });
  });
});
