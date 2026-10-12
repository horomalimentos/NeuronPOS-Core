// Bitacora de accesos: intentos correctos y fallidos con IP; solo admin y gerente la ven.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

describe('bitacora de accesos', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B; let cajero;
  const api = (who, method, path, body) => ctx.request(method, path, { token: who.token ?? who, body });
  const login = (slug, email, password, ua = 'PruebaUA/1.0') => ctx.request('POST', '/api/auth/login', { slug, body: { email, password }, headers: { 'user-agent': ua } });

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['pos'] });
    await api(A, 'POST', '/api/users', { email: 'caja@alfa.test', name: 'Caja', role: 'cajero', password: 'clave-segura-9' });
  });
  after(() => ctx?.close());

  test('registra intentos y los filtra', async () => {
    assert.equal((await login('alfa', 'caja@alfa.test', 'mala-clave-123')).status, 401);
    assert.equal((await login('alfa', 'nadie@alfa.test', 'mala-clave-123')).status, 401);
    const ok = await login('alfa', 'caja@alfa.test', 'clave-segura-9', 'Mozilla/5.0 (Android 14)');
    assert.equal(ok.status, 200);
    cajero = ok.body.token;
    assert.equal((await api(cajero, 'GET', '/api/users/access-log')).status, 403);
    const log = (await api(A, 'GET', '/api/users/access-log')).body.log;
    const mine = log.filter((l) => ['caja@alfa.test', 'nadie@alfa.test'].includes(l.email));
    assert.deepEqual(mine.map((l) => l.result), ['ok', 'contrasena', 'contrasena']);
    assert.equal(mine[0].user_name, 'Caja');
    assert.match(mine[0].user_agent, /Android/);
    assert.ok(mine[0].ip);
    assert.equal(mine[1].user_id, null, 'correo que no existe');
    const failed = (await api(A, 'GET', '/api/users/access-log?failed=1')).body.log;
    assert.ok(failed.every((l) => l.result !== 'ok'));
    assert.equal((await api(B, 'GET', '/api/users/access-log')).body.log.filter((l) => l.email.endsWith('@alfa.test')).length, 0);
  });
});
