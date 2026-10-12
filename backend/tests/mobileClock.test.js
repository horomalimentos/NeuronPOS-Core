// Checada desde el celular: solo si la sucursal lo permite y dentro de la geocerca.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

// Juarez centro y un punto a ~1.5 km.
const HERE = { latitude: 31.738, longitude: -106.487 };
const FAR = { latitude: 31.751, longitude: -106.487 };

describe('checada desde el celular', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let branch; let ana; let mesero;
  const api = (who, method, path, body) => ctx.request(method, path, { token: who.token ?? who, body });

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['rh'] });
    branch = (await api(A, 'GET', '/api/branches')).body.branches[0];
    const u = await api(A, 'POST', '/api/users', { email: 'ana@alfa.test', name: 'Ana', role: 'cocina', password: 'clave-segura-9', branch_ids: [branch.id] });
    await api(A, 'POST', '/api/users', { email: 'mesero@alfa.test', name: 'M', role: 'mesero', password: 'clave-segura-9', branch_ids: [branch.id] });
    ana = (await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email: 'ana@alfa.test', password: 'clave-segura-9' } })).body.token;
    mesero = (await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email: 'mesero@alfa.test', password: 'clave-segura-9' } })).body.token;
    await api(A, 'POST', '/api/employees', { full_name: 'Ana', user_id: u.body.user.id, branch_id: branch.id, daily_salary: 400, hire_date: '2026-01-01' });
  });
  after(() => ctx?.close());

  test('apagado por omision; requiere geocerca', async () => {
    assert.equal((await api(ana, 'GET', '/api/rh/me/clock')).body.enabled, false);
    assert.equal((await api(ana, 'POST', '/api/rh/me/clock', HERE)).body.code, 'MOBILE_CLOCK_DISABLED');
    assert.equal((await api(A, 'PUT', `/api/rh/clock-settings/${branch.id}`, { mobile_enabled: true })).body.code, 'GEOFENCE_REQUIRED');
    const ok = await api(A, 'PUT', `/api/rh/clock-settings/${branch.id}`, { geo_enabled: true, ...HERE, radius_meters: 200, mobile_enabled: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.settings.mobile_enabled, true);
  });

  test('checa dentro de la geocerca, con entrada y salida', async () => {
    const st = (await api(ana, 'GET', '/api/rh/me/clock')).body;
    assert.deepEqual([st.enabled, st.next], [true, 'entrada']);
    assert.equal((await api(ana, 'POST', '/api/rh/me/clock', {})).body.code, 'CLOCK_LOCATION_REQUIRED');
    assert.equal((await api(ana, 'POST', '/api/rh/me/clock', FAR)).body.code, 'CLOCK_OUT_OF_RANGE');
    const r = await api(ana, 'POST', '/api/rh/me/clock', HERE);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.entry.kind, 'entrada');
    assert.equal((await api(ana, 'POST', '/api/rh/me/clock', HERE)).body.code, 'CLOCK_DUPLICATE');
    const day = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
    const list = (await api(A, 'GET', `/api/rh/time-entries?from=${day(-1)}&to=${day(1)}`)).body.entries;
    assert.equal(list?.[0]?.source, 'celular', JSON.stringify(list));
    assert.equal((await api(mesero, 'POST', '/api/rh/me/clock', HERE)).body.code, 'NOT_AN_EMPLOYEE');
  });
});
