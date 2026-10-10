// Calificaciones y quejas: solo al recibir el pedido, una por pedido, fotos
// de evidencia validadas, aprobar con compensacion al monedero y descuento
// en nomina, rechazar con motivo, modulo requerido y aislamiento.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORM_DOMAIN, SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '00:00', closes_at: '00:00' }));
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('calificaciones y quejas', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B; let branch; let taco; let agua; let anaToken; let cajero; let session; let methods; let emp;
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-'));
  const host = `alfa.${PLATFORM_DOMAIN}`;
  const api = (who, method, p, body) => ctx.request(method, p, { token: who.token ?? who, body });
  const portal = (method, p, body, token) => ctx.request(method, `/api/portal${p}`, { host, body, token });
  const cash = () => methods.find((m) => m.kind === 'efectivo').id;

  /** Pedido en linea aceptado y cobrado en caja (el cliente lo ve entregado). */
  async function deliveredOrder(token, extra = {}) {
    const r = await portal('POST', '/orders', {
      branch_id: branch.id, order_type: 'para_llevar', payment: { method: 'efectivo' },
      items: [{ menu_item_id: taco.id, quantity: 2 }, { menu_item_id: agua.id, quantity: 1 }], ...extra,
    }, token);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const o = r.body.order;
    assert.equal((await api(cajero, 'POST', `/api/pos/online-orders/${o.id}/accept`, {})).status, 200);
    const p = await api(cajero, 'POST', `/api/pos/orders/${o.id}/payments`, {
      cash_session_id: session.id, payments: [{ payment_method_id: cash(), amount: 230 }],
    });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    return (await portal('GET', `/track/${o.token}`)).body.order;
  }

  before(async () => {
    process.env.UPLOADS_DIR = uploads;
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos', 'portal', 'quejas', 'monedero', 'rh'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['pos', 'portal'] });
    branch = (await api(A, 'GET', '/api/branches')).body.branches[0];
    const cat = (await api(A, 'POST', '/api/pos/categories', { name: 'Tacos' })).body.category;
    taco = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Taco', price: 100 })).body.item;
    agua = (await api(A, 'POST', '/api/pos/items', { category_id: cat.id, name: 'Agua', price: 30 })).body.item;
    await api(A, 'PUT', `/api/branches/${branch.id}/hours`, { hours: ALL_DAY });
    await api(A, 'PATCH', '/api/online/settings', { enabled: true });
    await api(A, 'POST', '/api/users', { email: 'caja@alfa.test', name: 'Caja', role: 'cajero', password: 'clave-segura-9', branch_ids: [branch.id] });
    cajero = (await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email: 'caja@alfa.test', password: 'clave-segura-9' } })).body;
    methods = (await api(A, 'GET', '/api/pos/payment-methods')).body.payment_methods;
    session = (await api(cajero, 'POST', '/api/pos/cash-sessions/open', { branch_id: branch.id })).body.session;
    anaToken = (await portal('POST', '/auth/register', { name: 'Ana', email: 'ana@correo.mx', phone: '6561234567', password: 'clave-ana-12' })).body.token;
    emp = (await api(A, 'POST', '/api/employees', { full_name: 'Luis Cocina', branch_id: branch.id, hire_date: '2026-01-01', daily_salary: 400 })).body.employee;
  });
  after(() => { ctx?.close(); fs.rmSync(uploads, { recursive: true, force: true }); });

  test('calificar: solo al recibirlo y una vez; resumen por sucursal', async () => {
    // Pedido sin entregar: no se puede.
    const r = await portal('POST', '/orders', {
      branch_id: branch.id, order_type: 'para_llevar', payment: { method: 'efectivo' }, items: [{ menu_item_id: taco.id, quantity: 1 }],
    }, anaToken);
    assert.equal(r.body.order.feedback?.can_rate ?? false, false);
    const early = await portal('POST', `/track/${r.body.order.token}/rating`, { overall: 5 });
    assert.equal(early.body.code, 'FEEDBACK_CLOSED');

    const o = await deliveredOrder(anaToken);
    assert.equal(o.status, 'entregado');
    assert.deepEqual([o.feedback.can_rate, o.feedback.can_complain], [true, true]);
    assert.equal((await portal('POST', `/track/${o.token}/rating`, { overall: 6 })).status, 400);
    const ok = await portal('POST', `/track/${o.token}/rating`, { overall: 4, food: 5, service: 3, comment: 'Muy rico' });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.order.feedback.can_rate, false);
    assert.equal(ok.body.order.feedback.rating.overall, 4);
    assert.equal((await portal('POST', `/track/${o.token}/rating`, { overall: 1 })).body.code, 'ALREADY_RATED');

    const g = await deliveredOrder(undefined, { customer: { name: 'Invitado', phone: '6560000000' } });
    assert.equal((await portal('POST', `/track/${g.token}/rating`, { overall: 2 })).status, 201);

    const s = (await api(A, 'GET', '/api/feedback/ratings?days=30')).body.summary;
    assert.equal(s.count, 2);
    assert.equal(s.average.overall, 3);
    assert.deepEqual(s.distribution, [0, 1, 0, 1, 0]);
    assert.equal(s.by_branch[0].count, 2);
    assert.equal(s.recent[0].overall, 2);
    assert.equal((await api(cajero, 'GET', '/api/feedback/ratings')).status, 403, 'el cajero no');
  });

  test('queja con productos y fotos; aprobar con monedero y descuento en nomina', async () => {
    const o = await deliveredOrder(anaToken);
    const up = await ctx.request('POST', `/api/portal/track/${o.token}/evidence`, { host, raw: PNG, headers: { 'content-type': 'image/png' } });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.match(up.body.url, new RegExp(`^/api/uploads/${A.id}/quejas/[0-9a-f-]{36}\\.png$`));
    const fake = await ctx.request('POST', `/api/portal/track/${o.token}/evidence`, { host, raw: Buffer.from('<svg/>'), headers: { 'content-type': 'image/png' } });
    assert.equal(fake.body.code, 'INVALID_IMAGE');

    const tacoLine = o.items.find((i) => i.name === 'Taco');
    const bad = await portal('POST', `/track/${o.token}/complaint`, { reason: 'Llegó frío', evidence_urls: ['/api/uploads/otro/x.png'] });
    assert.equal(bad.body.code, 'INVALID_PHOTO');
    const wrongItem = await portal('POST', `/track/${o.token}/complaint`, { reason: 'Llegó frío', item_ids: [taco.id] });
    assert.equal(wrongItem.body.code, 'INVALID_ITEMS');
    const c = await portal('POST', `/track/${o.token}/complaint`, { reason: 'Los tacos llegaron fríos', item_ids: [tacoLine.id], evidence_urls: [up.body.url] });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.order.feedback.complaint.status, 'pendiente');
    assert.equal(c.body.order.feedback.can_complain, false);
    assert.equal((await portal('POST', `/track/${o.token}/complaint`, { reason: 'Otra vez' })).body.code, 'COMPLAINT_EXISTS');

    const list = (await api(A, 'GET', '/api/feedback/complaints?status=pendiente')).body;
    assert.equal(list.pending_count, 1);
    assert.deepEqual(list.options, { wallet: true, points: false, payroll: true, employees: list.options.employees });
    assert.equal(list.options.employees[0].id, emp.id);
    const q = list.complaints[0];
    assert.equal(q.folio, o.folio);
    assert.deepEqual(q.items, [{ order_item_id: tacoLine.id, name: 'Taco', quantity: 2 }]);
    assert.deepEqual(q.evidence_urls, [up.body.url]);
    assert.equal(q.contact_email, 'ana@correo.mx');

    // Puntos sin el modulo de lealtad: no.
    const noPoints = await api(A, 'POST', `/api/feedback/complaints/${q.id}/approve`, { compensation: { type: 'puntos', points: 50 } });
    assert.equal(noPoints.body.code, 'MODULE_REQUIRED');
    // Descuento sin responsable: no.
    const noEmp = await api(A, 'POST', `/api/feedback/complaints/${q.id}/approve`, { employee_charge: 50 });
    assert.equal(noEmp.body.code, 'EMPLOYEE_REQUIRED');

    const ap = await api(A, 'POST', `/api/feedback/complaints/${q.id}/approve`, {
      responsible_employee_id: emp.id, compensation: { type: 'monedero', amount: 80 }, employee_charge: 50, notes: 'Se tardó el despacho',
    });
    assert.equal(ap.status, 200, JSON.stringify(ap.body));
    assert.equal(ap.body.complaint.status, 'aprobada');
    assert.equal(ap.body.complaint.responsible_name, 'Luis Cocina');
    assert.equal((await api(A, 'POST', `/api/feedback/complaints/${q.id}/reject`, { notes: 'x' })).body.code, 'ALREADY_REVIEWED');

    const me = (await portal('GET', '/me/wallet', undefined, anaToken)).body;
    assert.equal(Number(me.wallet?.balance ?? me.balance), 80);
    const adj = (await api(A, 'GET', `/api/rh/adjustments?employee_id=${emp.id}`)).body.adjustments;
    const charge = adj.find((a) => a.kind === 'descuento');
    assert.equal(Number(charge.amount), 50);
    assert.match(charge.concept, new RegExp(`#${o.folio}`));

    const track = (await portal('GET', `/track/${o.token}`)).body.order.feedback.complaint;
    assert.equal(track.status, 'aprobada');
    assert.match(track.response, /\$80\.00 a tu monedero/);
  });

  test('rechazar con motivo; invitado sin monedero; borrar ajuste deja la queja', async () => {
    const g = await deliveredOrder(undefined, { customer: { name: 'Invitado', phone: '6560000001' } });
    const c = await portal('POST', `/track/${g.token}/complaint`, { reason: 'Faltó el agua', contact_email: 'inv@correo.mx' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const q = (await api(A, 'GET', '/api/feedback/complaints?status=pendiente')).body.complaints[0];
    const guest = await api(A, 'POST', `/api/feedback/complaints/${q.id}/approve`, { compensation: { type: 'monedero', amount: 30 } });
    assert.equal(guest.body.code, 'GUEST_CUSTOMER');
    assert.equal((await api(A, 'POST', `/api/feedback/complaints/${q.id}/reject`, {})).status, 400, 'motivo obligatorio');
    const rj = await api(A, 'POST', `/api/feedback/complaints/${q.id}/reject`, { notes: 'El agua sí iba en la bolsa' });
    assert.equal(rj.status, 200);
    const t = (await portal('GET', `/track/${g.token}`)).body.order.feedback.complaint;
    assert.equal(t.status, 'rechazada');
    assert.equal(t.response, 'El agua sí iba en la bolsa');
    assert.equal((await api(A, 'GET', '/api/feedback/complaints/pending-count')).body.pending_count, 0);

    // El empleado con quejas tiene historial: no se borra.
    assert.equal((await api(A, 'DELETE', `/api/employees/${emp.id}`)).body.code, 'EMPLOYEE_HAS_HISTORY');
  });

  test('sin el modulo: 402 y el seguimiento no ofrece calificar; otro restaurante no ve nada', async () => {
    assert.equal((await api(B, 'GET', '/api/feedback/complaints')).status, 402);
    const seen = await ctx.withTenant(B.id, async (db) => (await db.query(
      'SELECT (SELECT count(*) FROM customer_complaints)::int + (SELECT count(*) FROM order_ratings)::int AS n',
    )).rows[0].n);
    assert.equal(seen, 0);
    const o = await deliveredOrder(anaToken);
    assert.equal((await api(owner, 'PUT', `/api/platform/restaurants/${A.id}/modules/quejas`, { enabled: false })).status, 200);
    const t = (await portal('GET', `/track/${o.token}`)).body.order;
    assert.equal(t.feedback, null);
    assert.equal((await portal('POST', `/track/${o.token}/rating`, { overall: 5 })).status, 402);
  });
});
