// NeuronPOS Delivery (fase 1) contra Postgres: registro gratis de
// restaurantes y repartidores, ficha de la sucursal, ajustes y tabla de
// envio del Panel, aprobacion de repartidores y cobertura por epicentro.
//
// Cubre: el restaurante registrado entra a su admin con el modulo
// 'marketplace' ($0) y usa el menu sin el POS (pero no las ordenes); no
// puede publicar sin ubicacion, horario y menu; no se quita un bloqueo del
// Panel (API y trigger); el repartidor pendiente no se pone en turno ni
// cambia su propio estado (trigger); el Panel aprueba, rechaza y bloquea
// (sale de turno); solo cubren el punto los repartidores aprobados, en
// turno y con el punto dentro de su radio.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';
import {
  feeForDistance, slugify, splitDeliveryFee,
} from '../services/marketplace.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));
// Centro de Cd. Juarez y puntos a ~2 km y ~9 km.
const CENTRO = { latitude: 31.7389, longitude: -106.4870 };
const CERCA = { latitude: 31.7569, longitude: -106.4870 };
const LEJOS = { latitude: 31.8199, longitude: -106.4870 };

describe('NeuronPOS Delivery: reglas puras', () => {
  test('envio por tramos y reparto 80/20', () => {
    const tiers = [{ up_to_km: 3, fee: 35 }, { up_to_km: 5, fee: 45 }, { up_to_km: 8, fee: 60 }];
    assert.equal(feeForDistance(tiers, 0), 35);
    assert.equal(feeForDistance(tiers, 3), 35);
    assert.equal(feeForDistance(tiers, 3.01), 45);
    assert.equal(feeForDistance(tiers, 7.9), 60);
    assert.equal(feeForDistance(tiers, 8.5), null);
    assert.equal(feeForDistance(tiers, 6, 5), null);
    assert.deepEqual(splitDeliveryFee(45, 80), { driver: 36, platform: 9 });
    assert.deepEqual(splitDeliveryFee(35.5, 80), { driver: 28.4, platform: 7.1 });
    assert.deepEqual(splitDeliveryFee(33.33, 80), { driver: 26.66, platform: 6.67 });
  });

  test('slug a partir del nombre', () => {
    assert.equal(slugify('Tacos Doña Pepa!'), 'tacos-dona-pepa');
    assert.equal(slugify('   '), 'restaurante');
  });
});

describe('NeuronPOS Delivery: fase 1', { skip: SKIP_DB }, () => {
  let ctx; let owner;
  let R; let branchR; let driverToken; let driverId; let pos;

  const api = (token, method, path, body) => ctx.request(method, path, { token, body });
  const panel = (method, path, body) => ctx.request(method, `/api/platform${path}`, { token: owner, body });
  const fleet = (token, method, path, body) => ctx.request(method, `/api/fleet${path}`, { token, body });

  async function signupDriver(email, base, radius = 5) {
    const res = await ctx.request('POST', '/api/marketplace/drivers', {
      body: {
        name: `Repartidor ${email}`, email, password: 'clave-segura-7', phone: '656 123 4567',
        vehicle: 'Moto', plate: 'ABC-123', base, radius_km: radius,
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  }

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    pos = await createRestaurant(ctx, owner, 'conpos', { modules: ['pos'] });
  });
  after(() => ctx?.close());

  test('info publica: tarifas y reparto inicial 80/20', async () => {
    const res = await ctx.request('GET', '/api/marketplace/info');
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.driver_share_pct, 80);
    assert.equal(res.body.food_commission_pct, 0);
    assert.deepEqual(res.body.fee_tiers.map((t) => t.up_to_km), [3, 5, 8, 10]);
  });

  test('registro gratis de restaurante: cuenta activa, modulo marketplace y ficha sin publicar', async () => {
    const bad = await ctx.request('POST', '/api/marketplace/restaurants', {
      body: { name: 'Sin mapa', phone: '6561112222', address: 'Calle 1', admin: { name: 'X', email: 'x@x.test', password: 'clave-segura-1' } },
    });
    assert.equal(bad.status, 400);

    const res = await ctx.request('POST', '/api/marketplace/restaurants', {
      body: {
        name: 'Tacos Doña Pepa', phone: '656 111 2222', address: 'Av. Juarez 100', cuisine: 'Tacos', location: CENTRO,
        admin: { name: 'Pepa', email: 'pepa@tacos.test', password: 'clave-segura-1' },
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.restaurant.slug, 'tacos-dona-pepa');
    assert.match(res.body.admin_url, /tacos-dona-pepa.*\/admin$/);

    // Mismo nombre: otro slug.
    const twin = await ctx.request('POST', '/api/marketplace/restaurants', {
      body: {
        name: 'Tacos Dona Pepa', phone: '6561112223', address: 'Otra 2', location: CERCA,
        admin: { name: 'Pepa 2', email: 'pepa2@tacos.test', password: 'clave-segura-1' },
      },
    });
    assert.equal(twin.body.restaurant.slug, 'tacos-dona-pepa-2');

    const login = await ctx.request('POST', '/api/auth/login', {
      slug: 'tacos-dona-pepa', body: { email: 'pepa@tacos.test', password: 'clave-segura-1' },
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    R = { id: res.body.restaurant.id, token: login.body.token };

    const me = await api(R.token, 'GET', '/api/me');
    const mods = Object.fromEntries(me.body.modules.map((m) => [m.code, m.enabled]));
    assert.equal(mods.marketplace, true);
    assert.equal(mods.pos, false);

    const detail = await panel('GET', `/restaurants/${R.id}`);
    assert.equal(detail.body.restaurant.status, 'active');
    assert.equal(detail.body.monthly_total_mxn ?? detail.body.charge?.total_mxn ?? 0, 0);

    const list = await api(R.token, 'GET', '/api/marketplace/listings');
    assert.equal(list.status, 200);
    [branchR] = list.body.listings;
    assert.deepEqual(branchR.location, CENTRO);
    assert.equal(branchR.cuisine, 'Tacos');
    assert.equal(branchR.published, false);
    assert.deepEqual(branchR.missing, ['horario', 'menu']);
  });

  test('restaurante solo de Delivery: usa el menu pero no las ordenes del POS', async () => {
    const cat = await api(R.token, 'POST', '/api/pos/categories', { name: 'Tacos' });
    assert.equal(cat.status, 201, JSON.stringify(cat.body));
    const item = await api(R.token, 'POST', '/api/pos/items', { category_id: cat.body.category.id, name: 'Taco de asada', price: 25 });
    assert.equal(item.status, 201);
    assert.equal((await api(R.token, 'GET', '/api/pos/menu')).status, 200);
    const orders = await api(R.token, 'GET', '/api/pos/orders');
    assert.equal(orders.status, 402);
    assert.equal(orders.body.module, 'pos');
    // Y un restaurante con POS pero sin Delivery no tiene ficha.
    assert.equal((await api(pos.token, 'GET', '/api/marketplace/listings')).status, 402);
    assert.equal((await api(pos.token, 'GET', '/api/pos/menu')).status, 200);
  });

  test('publicar exige ubicacion, horario y menu; pausar y reanudar', async () => {
    const early = await api(R.token, 'PUT', `/api/marketplace/listings/${branchR.branch_id}`, { published: true });
    assert.equal(early.status, 400);
    assert.equal(early.body.code, 'LISTING_INCOMPLETE');
    assert.match(early.body.error, /horario/);

    await api(R.token, 'PUT', `/api/branches/${branchR.branch_id}/hours`, { hours: ALL_DAY });
    const ok = await api(R.token, 'PUT', `/api/marketplace/listings/${branchR.branch_id}`, {
      published: true, description: 'Los mejores tacos', prep_minutes: 20, min_order: 80,
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.listing.published, true);
    assert.equal(ok.body.listing.visible, true);
    assert.equal(ok.body.listing.prep_minutes, 20);

    const paused = await api(R.token, 'POST', `/api/marketplace/listings/${branchR.branch_id}/pause`, { minutes: 30 });
    assert.equal(paused.body.listing.visible, false);
    assert.ok(paused.body.listing.paused_until);
    const resumed = await api(R.token, 'POST', `/api/marketplace/listings/${branchR.branch_id}/pause`, { minutes: 0 });
    assert.equal(resumed.body.listing.visible, true);
  });

  test('el Panel bloquea una ficha y el restaurante no puede quitarse el bloqueo', async () => {
    assert.equal((await panel('POST', `/marketplace/listings/${branchR.branch_id}/block`, { blocked: true })).status, 400);
    const res = await panel('POST', `/marketplace/listings/${branchR.branch_id}/block`, { blocked: true, reason: 'Menu falso' });
    assert.equal(res.status, 200);
    const mine = (await api(R.token, 'GET', '/api/marketplace/listings')).body.listings[0];
    assert.equal(mine.blocked, true);
    assert.equal(mine.visible, false);
    assert.equal(mine.blocked_reason, 'Menu falso');
    // Ni con SQL directo dentro del tenant.
    await assert.rejects(
      ctx.withTenant(R.id, (db) => db.query('UPDATE marketplace_listings SET blocked = false WHERE branch_id = $1', [branchR.branch_id])),
      /Solo el Panel/,
    );
    await panel('POST', `/marketplace/listings/${branchR.branch_id}/block`, { blocked: false });
    const all = await panel('GET', '/marketplace/listings');
    assert.equal(all.body.listings.length, 2);
    assert.ok(all.body.listings.some((l) => l.restaurant_name === 'Tacos Doña Pepa' && l.published && !l.blocked));
  });

  test('registro de repartidor: queda pendiente y no puede ponerse en turno ni aprobarse solo', async () => {
    const bad = await ctx.request('POST', '/api/marketplace/drivers', {
      body: { name: 'X', email: 'x@moto.test', password: 'clave-segura-7', phone: '6560000000', vehicle: 'Moto', base: CENTRO, radius_km: 40 },
    });
    assert.equal(bad.status, 400);

    const r = await signupDriver('juan@moto.test', CENTRO, 5);
    assert.equal(r.driver.status, 'pendiente');
    driverToken = r.token;
    driverId = r.driver.id;
    const dup = await ctx.request('POST', '/api/marketplace/drivers', {
      body: { name: 'Otro', email: 'juan@moto.test', password: 'clave-segura-7', phone: '6560000000', vehicle: 'Moto', base: CENTRO, radius_km: 3 },
    });
    assert.equal(dup.status, 409);

    const me = await fleet(driverToken, 'GET', '/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.driver.status, 'pendiente');
    assert.deepEqual(me.body.driver.base, CENTRO);
    assert.equal(me.body.driver.radius_km, 5);

    const duty = await fleet(driverToken, 'POST', '/duty', { on_duty: true });
    assert.equal(duty.status, 403);
    assert.equal(duty.body.code, 'DRIVER_NOT_APPROVED');

    const { withFleetDriver } = await import('../config/database.js');
    await assert.rejects(
      withFleetDriver(driverId, (db) => db.query("UPDATE fleet_drivers SET status = 'aprobado' WHERE id = $1", [driverId])),
      /Solo el Panel/,
    );

    const zone = await fleet(driverToken, 'PUT', '/zone', { base: CERCA, radius_km: 3 });
    assert.equal(zone.status, 200, JSON.stringify(zone.body));
    assert.deepEqual(zone.body.driver.base, CERCA);
    assert.equal((await fleet(driverToken, 'PUT', '/zone', { base: CERCA, radius_km: 99 })).status, 400);
  });

  test('el Panel aprueba, el repartidor se conecta y cubre solo dentro de su radio', async () => {
    const pending = await panel('GET', '/marketplace/drivers?status=pendiente');
    assert.deepEqual(pending.body.drivers.map((d) => d.id), [driverId]);
    const s = await panel('GET', '/marketplace/settings');
    assert.equal(s.body.summary.pending_drivers, 1);

    assert.equal((await panel('POST', `/marketplace/drivers/${driverId}/review`, { status: 'rechazado' })).status, 400);
    const ok = await panel('POST', `/marketplace/drivers/${driverId}/review`, { status: 'aprobado' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.driver.status, 'aprobado');
    assert.equal((await fleet(driverToken, 'POST', '/duty', { on_duty: true })).status, 200);

    const { coveringDrivers } = await import('../services/marketplace.js');
    const covering = (p) => ctx.withPlatform((db) => coveringDrivers(db, p));
    // Epicentro en CERCA con 3 km: cubre CENTRO (~2 km), no LEJOS (~7 km).
    assert.deepEqual((await covering(CENTRO)).map((d) => d.id), [driverId]);
    assert.deepEqual(await covering(LEJOS), []);

    // Bloqueado: sale de turno y ya no cubre.
    const blocked = await panel('POST', `/marketplace/drivers/${driverId}/review`, { status: 'bloqueado', note: 'Adeudo' });
    assert.equal(blocked.body.driver.on_duty, false);
    assert.deepEqual(await covering(CENTRO), []);
    const me = await fleet(driverToken, 'GET', '/me');
    assert.equal(me.body.driver.review_note, 'Adeudo');
    assert.equal((await fleet(driverToken, 'POST', '/duty', { on_duty: true })).status, 403);
  });

  test('ajustes y tabla de envio del Panel', async () => {
    const res = await panel('PUT', '/marketplace/settings', { driver_share_pct: 75, driver_debt_limit: 500, max_distance_km: 12 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(Number(res.body.settings.driver_share_pct), 75);
    assert.equal((await panel('PUT', '/marketplace/settings', { driver_share_pct: 120 })).status, 400);

    assert.equal((await panel('PUT', '/marketplace/fee-tiers', { tiers: [{ up_to_km: 2, fee: 30 }, { up_to_km: 2, fee: 40 }] })).status, 400);
    const tiers = await panel('PUT', '/marketplace/fee-tiers', { tiers: [{ up_to_km: 6, fee: 50 }, { up_to_km: 2, fee: 30 }] });
    assert.equal(tiers.status, 200);
    assert.deepEqual(tiers.body.fee_tiers, [{ up_to_km: 2, fee: 30 }, { up_to_km: 6, fee: 50 }]);
    const info = await ctx.request('GET', '/api/marketplace/info');
    assert.equal(info.body.driver_share_pct, 75);
    assert.deepEqual(info.body.fee_tiers, tiers.body.fee_tiers);

    // Solo el Panel.
    assert.equal((await api(R.token, 'GET', '/api/platform/marketplace/settings')).status, 403);

    // Delivery apagado: no hay registros nuevos.
    await panel('PUT', '/marketplace/settings', { enabled: false });
    const closed = await ctx.request('POST', '/api/marketplace/drivers', {
      body: { name: 'Z', email: 'z@moto.test', password: 'clave-segura-7', phone: '6560000000', vehicle: 'Moto', base: CENTRO, radius_km: 3 },
    });
    assert.equal(closed.status, 403);
    await panel('PUT', '/marketplace/settings', { enabled: true });
  });
});
