// Panel NeuronPOS: el dueno restablece la contrasena de un usuario de restaurante.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

describe('Panel: contrasenas de usuarios de restaurante', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B; let adminA;

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa');
    B = await createRestaurant(ctx, owner, 'beta');
    const res = await ctx.request('GET', `/api/platform/restaurants/${A.id}/users`, { token: owner });
    adminA = res.body.users.find((u) => u.email === A.email);
  });
  after(() => ctx?.close());

  test('lista los usuarios del restaurante sin el hash', async () => {
    const res = await ctx.request('GET', `/api/platform/restaurants/${A.id}/users`, { token: owner });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.users.map((u) => u.email), [A.email]);
    assert.equal(res.body.users[0].password_hash, undefined);
  });

  test('solo el dueno de la plataforma puede usarlo', async () => {
    const res = await ctx.request('GET', `/api/platform/restaurants/${A.id}/users`, { token: A.token });
    assert.equal(res.status, 403);
  });

  test('pone una contrasena nueva y cierra las sesiones abiertas', async () => {
    const weak = await ctx.request('PUT', `/api/platform/restaurants/${A.id}/users/${adminA.id}/password`, { token: owner, body: { password: 'corta' } });
    assert.equal(weak.status, 400);
    // Sesion emitida antes del cambio: debe dejar de servir (iat en segundos).
    await new Promise((r) => setTimeout(r, 1100));
    const res = await ctx.request('PUT', `/api/platform/restaurants/${A.id}/users/${adminA.id}/password`, { token: owner, body: { password: 'nueva-clave-99' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, A.email);
    assert.equal((await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email: A.email, password: A.password } })).status, 401);
    assert.equal((await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email: A.email, password: 'nueva-clave-99' } })).status, 200);
    assert.equal((await ctx.request('GET', '/api/me', { token: A.token })).status, 401);
  });

  test('no toca usuarios de otro restaurante', async () => {
    const res = await ctx.request('PUT', `/api/platform/restaurants/${B.id}/users/${adminA.id}/password`, { token: owner, body: { password: 'otra-clave-99' } });
    assert.equal(res.status, 404);
  });

  test('manda la liga de cambio al correo del usuario', async () => {
    const res = await ctx.request('POST', `/api/platform/restaurants/${A.id}/users/${adminA.id}/reset-link`, { token: owner });
    assert.equal(res.status, 200);
    assert.equal(res.body.email, A.email);
    const again = await ctx.request('POST', `/api/platform/restaurants/${A.id}/users/${adminA.id}/reset-link`, { token: owner });
    assert.equal(again.body.code, 'RESET_TOO_SOON');
  });
});
