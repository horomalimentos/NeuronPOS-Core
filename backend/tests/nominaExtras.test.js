// Prenomina en vivo, aclaraciones del empleado (bloquean la firma del
// recibo hasta responderse) y aguinaldo proporcional (LFT art. 87).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

describe('prenomina en vivo, aclaraciones y aguinaldo', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B; let branch; let mesero; let gerente; let ana; let omar; let today;
  const api = (who, method, p, body) => ctx.request(method, p, { token: who.token ?? who, body });
  const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

  async function addUser(role, email) {
    await api(A, 'POST', '/api/users', { email, name: role, role, password: 'clave-segura-9', branch_ids: [branch.id] });
    return (await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email, password: 'clave-segura-9' } })).body;
  }

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['rh'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['pos'] });
    branch = (await api(A, 'GET', '/api/branches')).body.branches[0];
    mesero = await addUser('mesero', 'mesero@alfa.test');
    gerente = await addUser('gerente', 'gerente@alfa.test');
    ana = (await api(A, 'POST', '/api/employees', {
      full_name: 'Ana López', user_id: mesero.user.id, branch_id: branch.id, daily_salary: 400, payment_frequency: 'semanal',
      hire_date: '2026-01-01', schedule: [1, 2, 3, 4, 5, 6].map((d) => ({ day_of_week: d, start_time: '09:00', end_time: '17:00' })),
    })).body.employee;
    omar = (await api(A, 'POST', '/api/employees', {
      full_name: 'Omar Ruiz', branch_id: branch.id, pay_type: 'por_hora', hourly_rate: 50, payment_frequency: 'quincenal', hire_date: '2026-07-01',
    })).body.employee;
  });
  after(() => ctx?.close());

  test('prenomina en vivo: periodo en curso de cada empleado segun su frecuencia', async () => {
    const r = await api(A, 'GET', '/api/rh/payroll/live');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    today = r.body.today;
    const a = r.body.items.find((i) => i.employee_id === ana.id);
    assert.equal(a.frequency, 'semanal');
    assert.ok(a.start_date <= today && today <= a.end_date);
    assert.equal(a.days.length, 7);
    assert.ok(Array.isArray(a.lines));
    const o = r.body.items.find((i) => i.employee_id === omar.id);
    assert.equal(o.frequency, 'quincenal');
    assert.ok(o.start_date.endsWith('-01') || o.start_date.endsWith('-16'));

    const me = await api(mesero, 'GET', '/api/rh/me/live');
    assert.equal(me.status, 200);
    assert.equal(me.body.item.employee_id, ana.id);
    assert.equal(me.body.item.gross, a.gross);
    assert.equal((await api(mesero, 'GET', '/api/rh/payroll/live')).status, 403);
  });

  test('aclaracion de un dia: el gerente la responde una sola vez', async () => {
    const short = await api(mesero, 'POST', '/api/rh/me/claims', { date: today, kind: 'falta', description: 'Sí vine' });
    assert.equal(short.status, 400);
    const future = await api(mesero, 'POST', '/api/rh/me/claims', { date: addDays(today, 1), kind: 'falta', description: 'Sí vine, olvidé checar' });
    assert.equal(future.status, 400);
    const c = await api(mesero, 'POST', '/api/rh/me/claims', { date: addDays(today, -1), kind: 'falta', description: 'Sí vine, olvidé checar la salida' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.claim.status, 'pendiente');

    const list = (await api(gerente, 'GET', '/api/rh/claims?status=pendiente')).body;
    assert.equal(list.pending_count, 1);
    assert.equal(list.claims[0].employee_name, 'Ana López');
    assert.equal((await api(gerente, 'POST', `/api/rh/claims/${c.body.claim.id}/resolve`, { status: 'resuelta' })).status, 400, 'respuesta obligatoria');
    const ok = await api(gerente, 'POST', `/api/rh/claims/${c.body.claim.id}/resolve`, { status: 'resuelta', response: 'Ya agregué tu salida' });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.body.claim.status, ok.body.claim.resolved_by_name], ['resuelta', 'gerente']);
    assert.equal((await api(gerente, 'POST', `/api/rh/claims/${c.body.claim.id}/resolve`, { status: 'rechazada', response: 'x' })).body.code, 'ALREADY_RESOLVED');
    const mine = (await api(mesero, 'GET', '/api/rh/me/claims')).body.claims;
    assert.equal(mine[0].response, 'Ya agregué tu salida');
  });

  test('aclaracion de un recibo: no se firma hasta responderla', async () => {
    const p = (await api(A, 'POST', '/api/rh/payroll/periods', { frequency: 'semanal', date: '2026-09-07' })).body.period;
    await api(A, 'POST', `/api/rh/payroll/periods/${p.id}/calculate`);
    assert.equal((await api(A, 'POST', `/api/rh/payroll/periods/${p.id}/approve`)).status, 200);
    const receipt = (await api(mesero, 'GET', '/api/rh/me/receipts')).body.receipts[0];
    const c = await api(mesero, 'POST', '/api/rh/me/claims', { item_id: receipt.id, kind: 'pago', description: 'No me pagaron el festivo', amount: 400 });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.claim.period_start, '2026-09-07');
    const blocked = await api(mesero, 'POST', `/api/rh/me/receipts/${receipt.id}/sign`, { accept: true });
    assert.equal(blocked.body.code, 'CLAIM_PENDING');
    await api(gerente, 'POST', `/api/rh/claims/${c.body.claim.id}/resolve`, { status: 'rechazada', response: 'Esa semana no hubo festivo' });
    assert.equal((await api(mesero, 'POST', `/api/rh/me/receipts/${receipt.id}/sign`, { accept: true })).status, 201);
    const late = await api(mesero, 'POST', '/api/rh/me/claims', { item_id: receipt.id, kind: 'pago', description: 'Otra cosa del recibo' });
    assert.equal(late.body.code, 'ALREADY_SIGNED');
  });

  test('aguinaldo: completo, proporcional, dias configurables y pago una vez', async () => {
    let r = (await api(A, 'GET', '/api/rh/aguinaldo?year=2026')).body;
    assert.equal(r.aguinaldo_days, 15);
    const a = r.employees.find((e) => e.employee_id === ana.id);
    assert.deepEqual([a.days_counted, a.proportional, a.amount], [365, false, 6000]);
    const o = r.employees.find((e) => e.employee_id === omar.id);
    // Julio a diciembre: 184 dias; base por hora 50 x 8 h = 400.
    assert.deepEqual([o.days_counted, o.proportional, o.daily_base, o.amount], [184, true, 400, 3024.66]);

    assert.equal((await api(A, 'PUT', '/api/rh/settings', { aguinaldo_days: 10 })).status, 400, 'minimo 15 (LFT)');
    assert.equal((await api(A, 'PUT', '/api/rh/settings', { aguinaldo_days: 20 })).status, 200);
    r = (await api(A, 'GET', '/api/rh/aguinaldo?year=2026')).body;
    assert.equal(r.employees.find((e) => e.employee_id === ana.id).amount, 8000);

    assert.equal((await api(gerente, 'POST', '/api/rh/aguinaldo/pay', { employee_id: ana.id, year: 2026 })).status, 403, 'solo admin');
    const pay = await api(A, 'POST', '/api/rh/aguinaldo/pay', { employee_id: ana.id, year: 2026, method: 'transferencia' });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    assert.equal(Number(pay.body.employee.payment.amount), 8000);
    assert.equal((await api(A, 'POST', '/api/rh/aguinaldo/pay', { employee_id: ana.id, year: 2026 })).body.code, 'ALREADY_PAID');

    const mine = (await api(mesero, 'GET', '/api/rh/me/aguinaldo')).body.aguinaldo;
    assert.equal(mine.amount, 8000);
    assert.equal(Number(mine.paid.amount), 8000);
    assert.equal(mine.daily_base, 400);

    assert.equal((await api(A, 'DELETE', `/api/rh/aguinaldo/${pay.body.employee.payment.id}`)).status, 204);
    // Del año anterior no aparece quien entro despues.
    r = (await api(A, 'GET', '/api/rh/aguinaldo?year=2025')).body;
    assert.equal(r.employees.length, 0);
  });

  test('sin el modulo rh: 402', async () => {
    assert.equal((await api(B, 'GET', '/api/rh/aguinaldo')).status, 402);
    assert.equal((await api(B, 'GET', '/api/rh/payroll/live')).status, 402);
  });
});
