// Pedidos programados: horarios disponibles (anticipacion, dias, horario de
// la sucursal), validacion, aceptado sin pasar a cocina hasta su hora, job
// que lo libera y modulo requerido.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORM_DOMAIN, SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';
import { readScheduledFor, scheduleSlots } from '../services/scheduling.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));
const SETTINGS = { schedule_max_days: 2, schedule_min_lead_minutes: 60, schedule_kitchen_minutes: 45 };

test('horarios y validacion (sin BD)', () => {
  // Miercoles 8 oct 2026 10:07 en Juarez (UTC-6). Abre 12:00-22:00, cerrado el jueves 9.
  const now = new Date('2026-10-08T16:07:00Z');
  const branch = {
    timezone: 'America/Ciudad_Juarez',
    hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '12:00', closes_at: '22:00' })),
    closures: [{ closed_on: '2026-10-09' }],
  };
  const days = scheduleSlots(branch, SETTINGS, now);
  assert.deepEqual(days.map((d) => d.label), ['Hoy', days[1].label]);
  assert.equal(days[0].date, '2026-10-08');
  assert.equal(days[1].date, '2026-10-10', 'el jueves esta cerrado');
  assert.equal(days[0].times[0].label, '12:00');
  assert.equal(days[0].times.at(-1).label, '21:45');
  assert.equal(days[0].times.length, 40);

  assert.equal(readScheduledFor(days[0].times[3].at, branch, SETTINGS, now).toISOString(), days[0].times[3].at);
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
  assert.equal(code(() => readScheduledFor('2026-10-08T16:30:00Z', branch, SETTINGS, now)), 'INVALID_SCHEDULE', 'menos de 1 h');
  assert.equal(code(() => readScheduledFor('2026-10-09T19:00:00Z', branch, SETTINGS, now)), 'INVALID_SCHEDULE', 'dia cerrado');
  assert.equal(code(() => readScheduledFor('2026-10-08T05:00:00Z', branch, SETTINGS, now)), 'INVALID_SCHEDULE');
  assert.equal(code(() => readScheduledFor('2026-10-08T19:07:00Z', branch, SETTINGS, now)), 'INVALID_SCHEDULE', 'cada 15 min');
  assert.equal(code(() => readScheduledFor('2026-10-12T19:00:00Z', branch, SETTINGS, now)), 'INVALID_SCHEDULE', 'mas de 2 dias');
  assert.equal(code(() => readScheduledFor('mañana', branch, SETTINGS, now)), 'INVALID_SCHEDULE');
});

describe('pedidos programados', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let branch; let taco; let anaToken;
  const host = `alfa.${PLATFORM_DOMAIN}`;
  const api = (who, method, p, body) => ctx.request(method, p, { token: who.token ?? who, body });
  const portal = (method, p, body, token) => ctx.request(method, `/api/portal${p}`, { host, body, token });

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos', 'portal', 'pedidos_programados'] });
    branch = (await api(A, 'GET', '/api/branches')).body.branches[0];
    const cat = (await api(A, 'POST', '/api/pos/categories', { name: 'Tacos' })).body.category;
    taco = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco', price: 100 })).body.item;
    await api(A, 'PUT', `/api/branches/${branch.id}/hours`, { hours: ALL_DAY });
    await api(A, 'PATCH', '/api/online/settings', { enabled: true, schedule_max_days: 1, schedule_min_lead_minutes: 90 });
    anaToken = (await portal('POST', '/auth/register', { name: 'Ana', email: 'ana@correo.mx', phone: '6561234567', password: 'clave-ana-12' })).body.token;
  });
  after(() => ctx?.close());

  test('horarios, pedido programado aceptado y liberado a cocina a su hora', async () => {
    const cfg = (await portal('GET', '/config')).body.settings;
    assert.deepEqual(cfg.scheduling, { max_days: 1, min_lead_minutes: 90 });
    const sched = await portal('GET', `/schedule?branch_id=${branch.id}`);
    assert.equal(sched.status, 200);
    assert.ok(sched.body.days.length >= 1 && sched.body.days.length <= 2);
    const first = new Date(sched.body.days[0].times[0].at);
    assert.ok(first.getTime() >= Date.now() + 89 * 60000);
    const at = sched.body.days[0].times[2].at;

    const r = await portal('POST', '/orders', {
      branch_id: branch.id, order_type: 'para_llevar', items: [{ menu_item_id: taco.id, quantity: 1 }],
      payment: { method: 'efectivo' }, scheduled_for: at,
    }, anaToken);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.order.scheduled_for && new Date(r.body.order.scheduled_for).toISOString(), at);
    const id = r.body.order.id;

    const acc = await api(A, 'POST', `/api/pos/online-orders/${id}/accept`, {});
    assert.equal(acc.status, 200, JSON.stringify(acc.body));
    assert.equal(acc.body.order.status, 'abierta', 'no pasa a cocina todavia');
    assert.equal(new Date(acc.body.order.estimated_ready_at).toISOString(), at);
    const track = await portal('GET', `/track/${r.body.order.token}`);
    assert.equal(track.body.order.status, 'programado');
    assert.equal(track.body.order.status_label, 'Programado');
    const kitchen = await api(A, 'GET', `/api/pos/kitchen?branch_id=${branch.id}`);
    assert.ok(!kitchen.body.orders.some((o) => o.id === id));

    const { releaseScheduledOrders } = await import('../services/scheduledOrders.js');
    assert.equal(await releaseScheduledOrders(), 0, 'falta para su hora');
    await ctx.withTenant(A.id, (db) => db.query("UPDATE orders SET scheduled_for = now() + interval '30 minutes' WHERE id = $1", [id]));
    assert.equal(await releaseScheduledOrders(), 1);
    const after2 = await api(A, 'GET', `/api/pos/orders/${id}`);
    assert.equal(after2.body.order.status, 'enviada');
    assert.equal((await portal('GET', `/track/${r.body.order.token}`)).body.order.status, 'preparando');
    assert.equal(await releaseScheduledOrders(), 0, 'una sola vez');
  });

  test('hora invalida y sin el modulo', async () => {
    const bad = await portal('POST', '/orders', {
      branch_id: branch.id, order_type: 'para_llevar', items: [{ menu_item_id: taco.id, quantity: 1 }],
      payment: { method: 'efectivo' }, scheduled_for: new Date(Date.now() + 10 * 60000).toISOString(),
    }, anaToken);
    assert.equal(bad.body.code, 'INVALID_SCHEDULE');
    await api(owner, 'PUT', `/api/platform/restaurants/${A.id}/modules/pedidos_programados`, { enabled: false });
    assert.deepEqual((await portal('GET', `/schedule?branch_id=${branch.id}`)).body, { available: false, days: [] });
    assert.equal((await portal('GET', '/config')).body.settings.scheduling, null);
    const off = await portal('POST', '/orders', {
      branch_id: branch.id, order_type: 'para_llevar', items: [{ menu_item_id: taco.id, quantity: 1 }],
      payment: { method: 'efectivo' }, scheduled_for: new Date(Date.now() + 5 * 3600000).toISOString(),
    }, anaToken);
    assert.equal(off.body.code, 'SCHEDULING_UNAVAILABLE');
  });
});
