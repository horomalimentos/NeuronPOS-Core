// Turnos y rol semanal: catalogo, rol por fecha que manda sobre el horario
// fijo en asistencia y retardos, copiar semana, dias bloqueados por una
// nomina aprobada, el rol del empleado y el modulo requerido.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';

describe('turnos y rol semanal', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B; let branch; let mesero; let ana; let matutino; let nocturno;
  const api = (who, method, p, body) => ctx.request(method, p, { token: who.token ?? who, body });
  const week = async (start) => (await api(A, 'GET', `/api/rh/shifts/week?start=${start}`)).body;
  const anaDays = (w) => w.employees.find((e) => e.id === ana.id).days;
  const attendance = async () => (await api(A, 'GET', `/api/rh/attendance?from=2026-09-07&to=2026-09-13&employee_id=${ana.id}`)).body.employees[0].days;
  const entry = (date, time, kind) => api(A, 'POST', '/api/rh/time-entries', { employee_id: ana.id, kind, date, time, reason: 'prueba' });

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['pos', 'rh', 'turnos'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['rh'] });
    branch = (await api(A, 'GET', '/api/branches')).body.branches[0];
    await api(A, 'POST', '/api/users', { email: 'mesero@alfa.test', name: 'Mesero', role: 'mesero', password: 'clave-segura-9', branch_ids: [branch.id] });
    mesero = (await ctx.request('POST', '/api/auth/login', { slug: 'alfa', body: { email: 'mesero@alfa.test', password: 'clave-segura-9' } })).body;
    ana = (await api(A, 'POST', '/api/employees', {
      full_name: 'Ana López', user_id: mesero.user.id, branch_id: branch.id, daily_salary: 400, hire_date: '2026-01-01',
      schedule: [1, 2, 3, 4, 5].map((d) => ({ day_of_week: d, start_time: '09:00', end_time: '17:00' })),
    })).body.employee;
  });
  after(() => ctx?.close());

  test('sin el modulo turnos: 402 solo en /api/rh/shifts; el resto de RH sigue', async () => {
    assert.equal((await api(B, 'GET', '/api/rh/shifts/week')).status, 402);
    assert.equal((await api(B, 'GET', '/api/rh/settings')).status, 200);
    assert.equal((await api(mesero, 'GET', '/api/rh/shifts/week')).status, 403, 'el mesero no arma el rol');
  });

  test('catalogo de turnos', async () => {
    const m = await api(A, 'POST', '/api/rh/shifts/templates', { name: 'Matutino', start_time: '07:00', end_time: '15:00', color: '#22C55E' });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    matutino = m.body.template;
    nocturno = (await api(A, 'POST', '/api/rh/shifts/templates', { name: 'Nocturno', start_time: '22:00', end_time: '06:00' })).body.template;
    assert.equal(nocturno.color, '#3B82F6');
    assert.equal((await api(A, 'POST', '/api/rh/shifts/templates', { name: 'X', start_time: '07:00', end_time: '07:00' })).status, 400);
    assert.equal((await api(A, 'POST', '/api/rh/shifts/templates', { name: 'X', start_time: '7', end_time: '15:00' })).status, 400);
    assert.equal((await api(A, 'POST', '/api/rh/shifts/templates', { name: 'X', start_time: '07:00', end_time: '15:00', color: 'rojo' })).status, 400);
    const list = (await api(A, 'GET', '/api/rh/shifts/templates')).body.templates;
    assert.deepEqual(list.map((t) => t.name), ['Matutino', 'Nocturno']);
  });

  test('el rol manda sobre el horario fijo en la semana, la asistencia y los retardos', async () => {
    const r = await api(A, 'PUT', '/api/rh/shifts/days', {
      items: [
        { employee_id: ana.id, date: '2026-09-08', shift_id: matutino.id },
        { employee_id: ana.id, date: '2026-09-09', rest: true },
        { employee_id: ana.id, date: '2026-09-12', start_time: '10:00', end_time: '14:00', note: 'Apoyo sábado' },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.saved, 3);

    const d = anaDays(await week('2026-09-07'));
    assert.deepEqual(d.map((x) => x.source), ['fijo', 'rol', 'rol', 'fijo', 'fijo', 'rol', null]);
    assert.deepEqual([d[1].shift_name, d[1].start_time, d[1].color], ['Matutino', '07:00', '#22C55E']);
    assert.equal(d[2].is_rest, true);
    assert.deepEqual([d[5].start_time, d[5].end_time, d[5].note], ['10:00', '14:00', 'Apoyo sábado']);

    // Martes entra 07:20 (su turno es 07:00): retardo de 20 min aunque el fijo es 09:00.
    assert.equal((await entry('2026-09-08', '07:20', 'entrada')).status, 201);
    await entry('2026-09-08', '15:00', 'salida');
    const days = await attendance();
    const tue = days.find((x) => x.date === '2026-09-08');
    assert.deepEqual([tue.type, tue.status, tue.late_minutes, tue.shift_name], ['laboral', 'trabajado', 20, 'Matutino']);
    const wed = days.find((x) => x.date === '2026-09-09');
    assert.deepEqual([wed.type, wed.absence], ['descanso', false], 'descanso del rol: no es falta');
    const sat = days.find((x) => x.date === '2026-09-12');
    assert.deepEqual([sat.type, sat.status, sat.scheduled_minutes], ['laboral', 'falta', 240]);

    // Editar el turno del catalogo no reescribe lo ya asignado.
    await api(A, 'PATCH', `/api/rh/shifts/templates/${matutino.id}`, { start_time: '08:00' });
    assert.equal(anaDays(await week('2026-09-07'))[1].start_time, '07:00');

    // Limpiar un dia vuelve al horario fijo.
    await api(A, 'PUT', '/api/rh/shifts/days', { items: [{ employee_id: ana.id, date: '2026-09-12', clear: true }] });
    assert.equal(anaDays(await week('2026-09-07'))[5].source, null);
    await api(A, 'PUT', '/api/rh/shifts/days', { items: [{ employee_id: ana.id, date: '2026-09-12', start_time: '10:00', end_time: '14:00' }] });
  });

  test('validaciones: turno ajeno o inactivo, empleado de otro restaurante', async () => {
    const empB = (await api(B, 'POST', '/api/employees', { full_name: 'Berta', branch_id: (await api(B, 'GET', '/api/branches')).body.branches[0].id, hire_date: '2026-01-01' })).body.employee;
    const other = await api(A, 'PUT', '/api/rh/shifts/days', { items: [{ employee_id: empB.id, date: '2026-09-08', rest: true }] });
    assert.equal(other.body.code, 'EMPLOYEE_NOT_FOUND');
    const bad = await api(A, 'PUT', '/api/rh/shifts/days', { items: [{ employee_id: ana.id, date: '2026-09-08', shift_id: ana.id }] });
    assert.equal(bad.body.code, 'SHIFT_NOT_FOUND');
    assert.equal((await api(A, 'PUT', '/api/rh/shifts/days', { items: [{ employee_id: ana.id, date: '2026-02-30', rest: true }] })).status, 400);
  });

  test('copiar la semana y el rol del empleado', async () => {
    const c = await api(A, 'POST', '/api/rh/shifts/copy-week', { from: '2026-09-07', to: '2026-09-14' });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.copied, 3);
    const d = anaDays(await week('2026-09-14'));
    assert.deepEqual(d.map((x) => x.source), ['fijo', 'rol', 'rol', 'fijo', 'fijo', 'rol', null]);
    // Sin sobrescribir no toca lo ya asignado; con overwrite si.
    await api(A, 'PUT', '/api/rh/shifts/days', { items: [{ employee_id: ana.id, date: '2026-09-15', shift_id: nocturno.id }] });
    assert.equal((await api(A, 'POST', '/api/rh/shifts/copy-week', { from: '2026-09-07', to: '2026-09-14' })).body.copied, 0);
    assert.equal(anaDays(await week('2026-09-14'))[1].shift_name, 'Nocturno');
    await api(A, 'POST', '/api/rh/shifts/copy-week', { from: '2026-09-07', to: '2026-09-14', overwrite: true });
    assert.equal(anaDays(await week('2026-09-14'))[1].shift_name, 'Matutino');

    const mine = await api(mesero, 'GET', '/api/rh/shifts/mine?start=2026-09-14');
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.equal(mine.body.days.length, 7);
    assert.equal(mine.body.days[2].is_rest, true);
  });

  test('una nomina aprobada bloquea el rol de esos dias; un turno usado se desactiva', async () => {
    const p = (await api(A, 'POST', '/api/rh/payroll/periods', { frequency: 'semanal', date: '2026-09-07' })).body.period;
    await api(A, 'POST', `/api/rh/payroll/periods/${p.id}/calculate`);
    const itemId = (await api(A, 'GET', `/api/rh/payroll/periods/${p.id}`)).body.items[0].id;
    const item = (await api(A, 'GET', `/api/rh/payroll/items/${itemId}`)).body.item;
    assert.equal(item.detail.find((x) => x.date === '2026-09-08').shift_name, 'Matutino', 'el recibo guarda el turno del dia');
    assert.equal((await api(A, 'POST', `/api/rh/payroll/periods/${p.id}/approve`)).status, 200);
    const locked = await api(A, 'PUT', '/api/rh/shifts/days', { items: [{ employee_id: ana.id, date: '2026-09-10', rest: true }] });
    assert.equal(locked.body.code, 'PERIOD_LOCKED');
    assert.equal((await api(A, 'POST', '/api/rh/shifts/copy-week', { from: '2026-09-14', to: '2026-09-07', overwrite: true })).body.code, 'PERIOD_LOCKED');

    assert.equal((await api(A, 'DELETE', `/api/rh/shifts/templates/${matutino.id}`)).body.result, 'desactivado');
    const unused = (await api(A, 'POST', '/api/rh/shifts/templates', { name: 'Mixto', start_time: '12:00', end_time: '20:00' })).body.template;
    assert.equal((await api(A, 'DELETE', `/api/rh/shifts/templates/${unused.id}`)).body.result, 'borrado');
  });

  test('sin el modulo la asistencia vuelve al horario fijo', async () => {
    await api(owner, 'PUT', `/api/platform/restaurants/${A.id}/modules/turnos`, { enabled: false });
    const wed = (await attendance()).find((x) => x.date === '2026-09-09');
    assert.equal(wed.type, 'laboral');
    assert.equal(wed.shift_name, null);
  });
});
