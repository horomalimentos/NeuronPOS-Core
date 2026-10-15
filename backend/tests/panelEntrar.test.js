// Panel NeuronPOS: entrar al panel de un restaurante (soporte). Solo el
// dueno de la plataforma; la sesion es del administrador del restaurante,
// sirve solo en ese restaurante y queda en su bitacora de accesos.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

describe('Panel: entrar al panel de un restaurante', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B;
  const api = (token, method, path, body) => ctx.request(method, path, { token, body });

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['pos'] });
  });
  after(() => ctx?.close());

  test('el dueno entra como el administrador del restaurante', async () => {
    const res = await api(owner, 'POST', `/api/platform/restaurants/${A.id}/enter`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.restaurant.slug, 'alfa');
    assert.equal(res.body.user.role, 'admin');
    const me = await api(res.body.token, 'GET', '/api/users');
    assert.equal(me.status, 200, JSON.stringify(me.body));
    // La sesion no sirve en otro restaurante.
    const other = await ctx.request('GET', '/api/users', { token: res.body.token, slug: 'beta' });
    assert.equal(other.status, 403);
    // Queda en la bitacora de accesos del restaurante.
    const log = await ctx.withTenant(A.id, (db) => db.query("SELECT email, user_agent FROM access_log WHERE user_agent LIKE 'Panel NeuronPOS%'"));
    assert.equal(log.rowCount, 1);
    assert.equal(log.rows[0].email, 'alex@neuronpos.test');
  });

  test('un usuario de restaurante no puede usarlo', async () => {
    const res = await api(B.token, 'POST', `/api/platform/restaurants/${A.id}/enter`);
    assert.equal(res.status, 403);
  });

  test('restaurante inexistente', async () => {
    const res = await api(owner, 'POST', '/api/platform/restaurants/00000000-0000-4000-8000-000000000000/enter');
    assert.equal(res.status, 404);
  });
});
