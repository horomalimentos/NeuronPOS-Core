// Apartados de dinero y metas de aguinaldo: cuotas, depositos y retiros,
// acceso (negocio, personal y compartido) y aislamiento entre restaurantes.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, localToday } from '../services/rh/dates.js';
import { installmentDates, planInstallments } from '../services/savings.js';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

describe('cuotas de un apartado (puro)', () => {
  test('mensual: el 31 cae en el ultimo dia de los meses cortos', () => {
    assert.deepEqual(installmentDates({ frequency: 'mensual', from: '2026-01-31', due: '2026-04-30' }),
      ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  });

  test('diaria: solo los dias marcados', () => {
    // 2026-10-12 es lunes; sin domingo.
    assert.deepEqual(installmentDates({ frequency: 'diaria', from: '2026-10-17', due: '2026-10-19', weekdays: [1, 2, 3, 4, 5, 6] }),
      ['2026-10-17', '2026-10-19']);
  });

  test('reparte exacto: los centavos sobrantes van en las primeras', () => {
    const plan = planInstallments({ remaining: 100, frequency: 'quincenal', from: '2026-10-01', due: '2026-11-11' });
    assert.deepEqual(plan.map((p) => p.amount), [33.34, 33.33, 33.33]);
    assert.deepEqual(plan.map((p) => p.due_on), ['2026-10-01', '2026-10-15', '2026-10-29']);
    assert.deepEqual(planInstallments({ remaining: 0, frequency: 'semanal', from: '2026-10-01', due: '2026-11-01' }), []);
    assert.deepEqual(planInstallments({ remaining: 50, frequency: null, from: '2026-10-01', due: '2026-11-01' }), []);
  });

  test('demasiadas cuotas', () => {
    assert.throws(() => installmentDates({ frequency: 'diaria', from: '2026-01-01', due: '2028-01-01', weekdays: [1, 2, 3, 4, 5, 6, 7] }), RangeError);
  });
});

describe('apartados (modulo apartados)', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B; let C; let branch; let mesero; let cajero; let meseroId; let cajeroId; let renta;
  const today = localToday('America/Mexico_City');
  const api = (who, method, path, body) => ctx.request(method, path, { token: who.token ?? who, body });
  const login = async (email) => (await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email, password: 'clave-segura-9' } })).body.token;
  const detail = async (who, id) => (await api(who, 'GET', `/api/savings/goals/${id}`)).body;

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['apartados', 'rh'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['apartados'] });
    C = await createRestaurant(ctx, owner, 'gama', { modules: ['pos'] });
    branch = (await api(A, 'GET', '/api/branches')).body.branches[0];
    meseroId = (await api(A, 'POST', '/api/users', { email: 'mesero@alfa.test', name: 'Lupe', role: 'mesero', password: 'clave-segura-9', branch_ids: [branch.id] })).body.user.id;
    cajeroId = (await api(A, 'POST', '/api/users', { email: 'caja@alfa.test', name: 'Beto', role: 'cajero', password: 'clave-segura-9', branch_ids: [branch.id] })).body.user.id;
    mesero = await login('mesero@alfa.test');
    cajero = await login('caja@alfa.test');
  });
  after(() => ctx?.close());

  test('sin el modulo responde 402', async () => {
    assert.equal((await api(C, 'GET', '/api/savings/goals')).status, 402);
  });

  test('crear con plan semanal: cuotas iguales hasta la fecha limite', async () => {
    const r = await api(A, 'POST', '/api/savings/goals', {
      name: 'Renta de diciembre', target_amount: 1000, frequency: 'semanal', due_date: addDays(today, 21), branch_id: branch.id,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    renta = r.body.goal;
    assert.equal(renta.access, 'manage');
    assert.equal(renta.installments_total, 4);
    assert.equal(renta.next_installment.due_on, today);
    const d = await detail(A, renta.id);
    assert.deepEqual(d.installments.map((i) => Number(i.amount)), [250, 250, 250, 250]);
    assert.equal((await api(A, 'POST', '/api/savings/goals', { name: 'x', target_amount: 10, frequency: 'semanal' })).body.code, 'MISSING_FIELD');
    assert.equal((await api(A, 'POST', '/api/savings/goals', { name: 'x', target_amount: 10, frequency: 'diaria', due_date: addDays(today, 900) })).body.code, 'TOO_MANY_INSTALLMENTS');
  });

  test('marcar cuota crea el deposito; desmarcar lo quita', async () => {
    const [first] = (await detail(A, renta.id)).installments;
    let g = (await api(A, 'PATCH', `/api/savings/installments/${first.id}`, { done: true })).body.goal;
    assert.equal(g.balance, 250);
    assert.equal(g.installments_done, 1);
    assert.equal(g.missing, 750);
    const d = await detail(A, renta.id);
    assert.equal(d.movements.length, 1);
    assert.equal(d.movements[0].installment_id, first.id);
    g = (await api(A, 'PATCH', `/api/savings/installments/${first.id}`, { done: false })).body.goal;
    assert.equal(g.balance, 0);
    assert.equal((await detail(A, renta.id)).movements.length, 0);
    await api(A, 'PATCH', `/api/savings/installments/${first.id}`, { done: true });
  });

  test('depositos y retiros; no se retira mas de lo apartado; replanear reparte lo que falta', async () => {
    let g = (await api(A, 'POST', `/api/savings/goals/${renta.id}/movements`, { kind: 'deposito', amount: 100, notes: 'Propinas' })).body.goal;
    assert.equal(g.balance, 350);
    assert.equal((await api(A, 'POST', `/api/savings/goals/${renta.id}/movements`, { kind: 'retiro', amount: 500 })).body.code, 'INSUFFICIENT_BALANCE');
    g = (await api(A, 'POST', `/api/savings/goals/${renta.id}/movements`, { kind: 'retiro', amount: 50 })).body.goal;
    assert.equal(g.balance, 300);
    const d = await detail(A, renta.id);
    const pending = d.installments.filter((i) => !i.done).reduce((s, i) => s + Math.round(Number(i.amount) * 100), 0);
    assert.equal(pending, 70000, 'los depositos y retiros extra reparten de nuevo lo que falta (700)');
    assert.equal(d.installments.filter((i) => i.done).length, 1, 'la cuota apartada se conserva');
    // Borrar el deposito de una cuota la deja pendiente otra vez.
    const cuota = d.movements.find((m) => m.installment_id);
    assert.equal((await api(A, 'DELETE', `/api/savings/movements/${cuota.id}`)).status, 204);
    const after = await detail(A, renta.id);
    assert.equal(after.goal.installments_done, 0);
    assert.equal(after.installments.reduce((s, i) => s + Math.round(Number(i.amount) * 100), 0), 95000, 'la cuota vuelve a quedar pendiente');
    assert.equal((await api(A, 'POST', `/api/savings/goals/${renta.id}/replan`)).status, 200);
    assert.equal((await api(A, 'DELETE', `/api/savings/goals/${renta.id}`)).body.code, 'GOAL_HAS_MOVEMENTS');
  });

  test('acceso: negocio para gerentes, personal para su dueno, compartido para ver o registrar', async () => {
    assert.equal((await api(mesero, 'GET', `/api/savings/goals/${renta.id}`)).status, 404);
    assert.equal((await api(mesero, 'POST', '/api/savings/goals', { name: 'Caja chica', target_amount: 500 })).status, 403);
    const mine = (await api(mesero, 'POST', '/api/savings/goals', { name: 'Mi moto', target_amount: 5000, scope: 'personal' })).body.goal;
    assert.equal(mine.access, 'manage');
    assert.equal((await api(A, 'GET', `/api/savings/goals/${mine.id}`)).status, 404, 'el admin no ve lo personal');
    assert.deepEqual((await api(mesero, 'GET', '/api/savings/goals')).body.goals.map((g) => g.name), ['Mi moto']);

    assert.equal((await api(mesero, 'PUT', `/api/savings/goals/${mine.id}/shares/${cajeroId}`, { can_edit: false })).status, 200);
    const shared = (await api(cajero, 'GET', `/api/savings/goals/${mine.id}`)).body;
    assert.equal(shared.goal.access, 'view');
    assert.deepEqual(shared.shares, [], 'solo quien administra ve con quien se comparte');
    assert.equal((await api(cajero, 'POST', `/api/savings/goals/${mine.id}/movements`, { kind: 'deposito', amount: 10 })).body.code, 'GOAL_READ_ONLY');
    assert.equal((await api(cajero, 'PUT', `/api/savings/goals/${mine.id}`, { name: 'Mia' })).body.code, 'GOAL_FORBIDDEN');
    await api(mesero, 'PUT', `/api/savings/goals/${mine.id}/shares/${cajeroId}`, { can_edit: true });
    const r = await api(cajero, 'POST', `/api/savings/goals/${mine.id}/movements`, { kind: 'deposito', amount: 10 });
    assert.equal(r.status, 201);
    assert.equal(r.body.goal.access, 'edit');
    assert.equal((await detail(mesero, mine.id)).shares[0].name, 'Beto');
    // El compartido se puede salir solo.
    assert.equal((await api(cajero, 'DELETE', `/api/savings/goals/${mine.id}/shares/${cajeroId}`)).status, 204);
    assert.equal((await api(cajero, 'GET', `/api/savings/goals/${mine.id}`)).status, 404);
    assert.equal((await api(mesero, 'PUT', `/api/savings/goals/${mine.id}/shares/${meseroId}`, {})).body.code, 'INVALID_FIELD');
  });

  test('otro restaurante no ve nada', async () => {
    assert.equal((await api(B, 'GET', '/api/savings/goals')).body.goals.length, 0);
    assert.equal((await api(B, 'GET', `/api/savings/goals/${renta.id}`)).status, 404);
  });

  test('meta de aguinaldo: con los empleados de RH y vence el 20 de diciembre', async () => {
    const year = today <= `${today.slice(0, 4)}-12-20` ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) + 1;
    assert.equal((await api(B, 'POST', '/api/savings/aguinaldo', { year })).body.code, 'MODULE_REQUIRED');
    assert.equal((await api(A, 'POST', '/api/savings/aguinaldo', { year })).body.code, 'NOTHING_TO_SAVE');
    await api(A, 'POST', '/api/employees', { full_name: 'Ana López', branch_id: branch.id, daily_salary: 400, hire_date: `${year - 1}-06-01` });
    const r = await api(A, 'POST', '/api/savings/aguinaldo', { year, frequency: 'semanal' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const g = r.body.goal;
    assert.equal(g.kind, 'aguinaldo');
    assert.equal(g.due_date, `${year}-12-20`);
    assert.equal(g.target_amount, 6000, '15 dias de 400');
    assert.equal((await api(A, 'POST', '/api/savings/aguinaldo', { year })).body.code, 'AGUINALDO_EXISTS');
    const d = await detail(A, g.id);
    assert.equal(d.aguinaldo.total, 6000);
    assert.equal(d.aguinaldo.employees[0].full_name, 'Ana López');
    // Otra contratacion: recalcular sube la meta.
    await api(A, 'POST', '/api/employees', { full_name: 'Omar Ruiz', branch_id: branch.id, daily_salary: 200, hire_date: `${year - 1}-01-01` });
    const re = (await api(A, 'POST', `/api/savings/goals/${g.id}/recalculate`)).body.goal;
    assert.equal(re.target_amount, 9000);
    assert.equal((await api(A, 'PUT', `/api/savings/goals/${g.id}`, { due_date: `${year}-12-31` })).body.code, 'INVALID_FIELD');
  });
});
