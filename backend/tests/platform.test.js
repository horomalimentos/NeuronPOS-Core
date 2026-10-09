// requireModule de punta a punta y cobro mensual calculado por la API del
// Panel NeuronPOS.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

describe('modulos, estado y cobro mensual', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B;

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos'] });
    B = await createRestaurant(ctx, owner, 'beta');
  });
  after(() => ctx?.close());

  test('el catalogo trae los modulos sembrados', async () => {
    const res = await ctx.request('GET', '/api/platform/modules', { token: owner });
    assert.deepEqual(res.body.modules.map((m) => m.code), ['pos', 'reportes', 'landing', 'portal', 'rh', 'empleado_mes', 'domicilios']);
  });

  test('la pagina principal lee los planes sin restaurante y oculta los inactivos', async () => {
    await ctx.request('PUT', '/api/platform/modules/empleado_mes', { token: owner, body: { monthly_price_mxn: 199, active: false } });
    await ctx.request('PUT', '/api/platform/modules/pos', { token: owner, body: { monthly_price_mxn: 499 } });
    const res = await ctx.request('GET', '/api/public/plans');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.modules.map((m) => m.code), ['pos', 'reportes', 'landing', 'portal', 'rh', 'domicilios']);
    assert.equal(Number(res.body.modules[0].monthly_price_mxn), 499);
    assert.equal(res.body.modules[0].enabled_restaurants, undefined);
    assert.ok(res.body.trial_days > 0);
    await ctx.request('PUT', '/api/platform/modules/empleado_mes', { token: owner, body: { active: true } });
  });

  test('requireModule: 200 con modulo, 402 sin modulo', async () => {
    assert.equal((await ctx.request('GET', '/api/pos/status', { token: A.token })).status, 200);
    const res = await ctx.request('GET', '/api/pos/status', { token: B.token });
    assert.equal(res.status, 402);
    assert.equal(res.body.code, 'MODULE_NOT_ENABLED');
    assert.match(res.body.error, /no tiene contratado el módulo "Punto de venta"/);
  });

  test('requireModule: 402 al suspender y 200 al reactivar', async () => {
    const s = await ctx.request('POST', `/api/platform/restaurants/${A.id}/suspend`, { token: owner });
    assert.equal(s.body.restaurant.status, 'suspended');
    const denied = await ctx.request('GET', '/api/pos/status', { token: A.token });
    assert.equal(denied.status, 402);
    assert.equal(denied.body.code, 'RESTAURANT_SUSPENDED');
    const site = await ctx.request('GET', '/api/public/site', { slug: 'alfa' });
    assert.equal(site.body.restaurant.available, false);
    await ctx.request('POST', `/api/platform/restaurants/${A.id}/reactivate`, { token: owner });
    assert.equal((await ctx.request('GET', '/api/pos/status', { token: A.token })).status, 200);
  });

  test('requireModule: 402 con prueba vencida', async () => {
    await ctx.request('PATCH', `/api/platform/restaurants/${A.id}`, {
      token: owner, body: { status: 'trial', trial_ends_at: '2020-01-01T00:00:00Z' },
    });
    const res = await ctx.request('GET', '/api/pos/status', { token: A.token });
    assert.equal(res.status, 402);
    assert.equal(res.body.code, 'TRIAL_EXPIRED');
    await ctx.request('PATCH', `/api/platform/restaurants/${A.id}`, { token: owner, body: { status: 'active' } });
  });

  test('deshabilitar un modulo corta el acceso', async () => {
    await ctx.request('PUT', `/api/platform/restaurants/${A.id}/modules/pos`, { token: owner, body: { enabled: false } });
    assert.equal((await ctx.request('GET', '/api/pos/status', { token: A.token })).status, 402);
    const me = await ctx.request('GET', '/api/me', { token: A.token });
    assert.equal(me.body.modules.find((m) => m.code === 'pos').enabled, false);
    await ctx.request('PUT', `/api/platform/restaurants/${A.id}/modules/pos`, { token: owner, body: { enabled: true } });
    assert.equal((await ctx.request('GET', '/api/pos/status', { token: A.token })).status, 200);
  });

  test('cobro mensual: precios de catalogo, precio personalizado y descuento', async () => {
    await ctx.request('PUT', '/api/platform/modules/pos', { token: owner, body: { monthly_price_mxn: 500 } });
    await ctx.request('PUT', '/api/platform/modules/landing', { token: owner, body: { monthly_price_mxn: 300 } });
    await ctx.request('PUT', '/api/platform/modules/rh', { token: owner, body: { monthly_price_mxn: 800 } });

    const detail = await ctx.request('PUT', `/api/platform/restaurants/${A.id}/modules/landing`, {
      token: owner, body: { enabled: true, custom_price_mxn: 250, discount_pct: 10 },
    });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.monthly.total_mxn, 725); // 500 + 250*0.9
    assert.ok(detail.body.modules.find((m) => m.module_code === 'landing').started_at, 'registra fecha de alta');

    // rh habilitado pero ya vencido: no cuenta
    await ctx.request('PUT', `/api/platform/restaurants/${A.id}/modules/rh`, {
      token: owner, body: { enabled: true, ends_at: '2020-01-01T00:00:00Z' },
    });

    const list = await ctx.request('GET', '/api/platform/restaurants', { token: owner });
    const byslug = Object.fromEntries(list.body.restaurants.map((r) => [r.slug, r]));
    assert.equal(byslug.alfa.monthly_total_mxn, 725);
    assert.deepEqual(byslug.alfa.enabled_modules.sort(), ['landing', 'pos']);
    assert.equal(byslug.beta.monthly_total_mxn, 0);
    assert.equal(list.body.monthly_grand_total_mxn, 725);

    // Quitar el precio personalizado regresa al de catalogo (300 * 0.9 = 270)
    const reset = await ctx.request('PUT', `/api/platform/restaurants/${A.id}/modules/landing`, {
      token: owner, body: { custom_price_mxn: null },
    });
    assert.equal(reset.body.monthly.total_mxn, 770);

    // Un restaurante suspendido no suma al total de la plataforma
    await ctx.request('POST', `/api/platform/restaurants/${A.id}/suspend`, { token: owner });
    const list2 = await ctx.request('GET', '/api/platform/restaurants', { token: owner });
    assert.equal(list2.body.monthly_grand_total_mxn, 0);
    await ctx.request('POST', `/api/platform/restaurants/${A.id}/reactivate`, { token: owner });
  });

  test('el restaurante no ve precios en /api/me', async () => {
    const me = await ctx.request('GET', '/api/me', { token: A.token });
    assert.ok(!JSON.stringify(me.body.modules).includes('price'));
  });

  test('domicilios: modo y comision Horom', async () => {
    const bad = await ctx.request('PUT', `/api/platform/restaurants/${B.id}/delivery`, {
      token: owner, body: { mode: 'horom', horom_fee_type: 'percent', horom_fee_value: 120 },
    });
    assert.equal(bad.status, 400);
    const ok = await ctx.request('PUT', `/api/platform/restaurants/${B.id}/delivery`, {
      token: owner, body: { mode: 'horom', horom_fee_type: 'percent', horom_fee_value: 15 },
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(
      { mode: ok.body.delivery.mode, type: ok.body.delivery.horom_fee_type, value: Number(ok.body.delivery.horom_fee_value) },
      { mode: 'horom', type: 'percent', value: 15 },
    );
  });

  test('validaciones al crear restaurante', async () => {
    const dup = await ctx.request('POST', '/api/platform/restaurants', { token: owner, body: { slug: 'alfa', name: 'Otro' } });
    assert.equal(dup.status, 409);
    const badSlug = await ctx.request('POST', '/api/platform/restaurants', { token: owner, body: { slug: 'Con Espacios', name: 'X' } });
    assert.equal(badSlug.status, 400);
    const trial = await ctx.request('POST', '/api/platform/restaurants', { token: owner, body: { slug: 'gamma', name: 'Gamma' } });
    assert.equal(trial.status, 201);
    assert.equal(trial.body.restaurant.status, 'trial');
    assert.ok(trial.body.restaurant.trial_ends_at);
    assert.equal(trial.body.counts.branches, 1);
  });

  test('borrar restaurante exige confirmar el slug', async () => {
    const gamma = (await ctx.request('GET', '/api/platform/restaurants', { token: owner })).body.restaurants.find((r) => r.slug === 'gamma');
    assert.equal((await ctx.request('DELETE', `/api/platform/restaurants/${gamma.id}`, { token: owner })).status, 400);
    assert.equal((await ctx.request('DELETE', `/api/platform/restaurants/${gamma.id}?confirm=gamma`, { token: owner })).status, 204);
    assert.equal((await ctx.request('GET', `/api/platform/restaurants/${gamma.id}`, { token: owner })).status, 404);
  });

  test('login de plataforma con contrasena incorrecta', async () => {
    const res = await ctx.request('POST', '/api/platform/auth/login', { body: { email: 'alex@neuronpos.test', password: 'mala' } });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'INVALID_CREDENTIALS');
  });
});
