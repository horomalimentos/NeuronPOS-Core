// Empleado del mes contra Postgres: 402 sin el modulo, ranking con datos de
// rh (asistencia y puntualidad), pos (ventas), evaluaciones y tareas, cierre
// del mes con premio en la nomina, job idempotente, muro e historial, y
// aislamiento entre restaurantes.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';
import { zonedTimeToUtc } from '../services/rh/dates.js';

describe('empleado del mes', { skip: SKIP_DB }, () => {
  let ctx; let owner; let R; let S; let N; let branch; let tz;
  let ana; let beto; let carla; let mesero; let cajero; let prev;

  const api = (who, method, path, body) => ctx.request(method, path, { token: who.token ?? who, body });

  async function addUser(role, email) {
    const password = 'clave-segura-9';
    const res = await api(R, 'POST', '/api/users', { email, name: role, role, password, branch_ids: [branch.id] });
    const login = await ctx.request('POST', '/api/auth/login', { slug: 'rec', body: { email, password } });
    return { token: login.body.token, id: res.body.user.id };
  }

  async function seed(employee, days) {
    await ctx.withTenant(R.id, async (db) => {
      for (const [date, inT, outT] of days) {
        for (const [kind, t] of [['entrada', inT], ['salida', outT]]) {
          await db.query(
            `INSERT INTO time_entries (restaurant_id, employee_id, branch_id, kind, occurred_at, source) VALUES ($1, $2, $3, $4, $5, 'kiosco')`,
            [R.id, employee.id, branch.id, kind, zonedTimeToUtc(date, t, tz)],
          );
        }
      }
    });
  }

  async function sale(user, total, paidAt, folio) {
    await ctx.withTenant(R.id, (db) => db.query(
      `INSERT INTO orders (restaurant_id, branch_id, folio, order_type, status, total, created_by, paid_at)
       VALUES ($1, $2, $3, 'para_llevar', 'pagada', $4, $5, $6)`,
      [R.id, branch.id, folio, total, user.id, paidAt],
    ));
  }

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    R = await createRestaurant(ctx, owner, 'rec', { modules: ['rh', 'pos', 'empleado_mes'] });
    S = await createRestaurant(ctx, owner, 'solo', { modules: ['empleado_mes'] });
    N = await createRestaurant(ctx, owner, 'nada', { modules: ['rh'] });
    branch = (await api(R, 'GET', '/api/branches')).body.branches[0];
    tz = branch.timezone;
    mesero = await addUser('mesero', 'mesero@rec.test');
    cajero = await addUser('cajero', 'cajero@rec.test');
    const sched = [1, 2, 3, 4, 5].map((d) => ({ day_of_week: d, start_time: '09:00', end_time: '17:00' }));
    const emp = async (body) => (await api(R, 'POST', '/api/employees', {
      branch_id: branch.id, daily_salary: 300, hire_date: '2026-08-24', schedule: sched, ...body,
    })).body.employee;
    ana = await emp({ full_name: 'Ana', user_id: mesero.id });
    beto = await emp({ full_name: 'Beto', user_id: cajero.id });
    carla = await emp({ full_name: 'Carla' });

    // Contratados el 24 de agosto de 2026, lunes a viernes: 6 dias laborales
    // en el mes (24 al 28 y 31). Ana: todos a tiempo; Beto: dos retardos;
    // Carla: falta el 24.
    const week = ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-31'];
    await seed(ana, week.map((d) => [d, '08:58', '17:00']));
    await seed(beto, week.map((d, i) => [d, i < 2 ? '09:30' : '09:00', '17:00']));
    await seed(carla, week.slice(1).map((d) => [d, '09:00', '17:00']));
    await sale(mesero, 600, '2026-08-25T20:00:00Z', 1);
    await sale(mesero, 400, '2026-08-26T20:00:00Z', 2);
    await sale(cajero, 500, '2026-08-27T20:00:00Z', 3);
    await sale(cajero, 9999, '2026-09-02T20:00:00Z', 4); // otro mes: no cuenta
  });
  after(() => ctx?.close());

  test('sin el modulo empleado_mes las rutas responden 402', async () => {
    for (const [m, p] of [
      ['GET', '/api/recognition/settings'], ['PUT', '/api/recognition/settings'], ['GET', '/api/recognition/ranking'],
      ['GET', '/api/recognition/wall'], ['GET', '/api/recognition/history'], ['PUT', '/api/recognition/evaluations'],
      ['GET', '/api/recognition/tasks'], ['POST', '/api/recognition/tasks'], ['POST', '/api/recognition/months/2026/8/close'],
    ]) {
      const res = await api(N, m, p, m === 'GET' ? undefined : {});
      assert.equal(res.status, 402, `${m} ${p}`);
      assert.equal(res.body.module, 'empleado_mes');
    }
  });

  test('evaluaciones del gerente y tareas completadas', async () => {
    for (const [e, score] of [[ana, 80], [beto, 90], [carla, 100]]) {
      const r = await api(R, 'PUT', '/api/recognition/evaluations', { employee_id: e.id, year: 2026, month: 8, score, comment: 'Bien' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    assert.equal((await api(mesero, 'PUT', '/api/recognition/evaluations', { employee_id: ana.id, score: 100 })).status, 403);
    const t1 = (await api(R, 'POST', '/api/recognition/tasks', { employee_id: ana.id, title: 'Inventario de barra', points: 10 })).body.task;
    const t2 = (await api(R, 'POST', '/api/recognition/tasks', { employee_id: beto.id, title: 'Capacitar al nuevo', points: 20 })).body.task;
    const t3 = (await api(R, 'POST', '/api/recognition/tasks', { employee_id: carla.id, title: 'Cancelada', points: 50 })).body.task;
    for (const t of [t1, t2]) assert.equal((await api(R, 'POST', `/api/recognition/tasks/${t.id}/complete`)).body.task.status, 'completada');
    await api(R, 'POST', `/api/recognition/tasks/${t3.id}/cancel`);
    // Se completaron "hoy": se mueven a agosto para el mes que se evalua.
    await ctx.withTenant(R.id, (db) => db.query("UPDATE recognition_tasks SET completed_at = '2026-08-28T18:00:00Z' WHERE status = 'completada'"));
    assert.equal((await api(R, 'POST', `/api/recognition/tasks/${t1.id}/complete`)).status, 404, 'ya no esta pendiente');
  });

  test('ranking en vivo con asistencia, puntualidad, ventas, evaluacion y tareas (determinista)', async () => {
    const r1 = await api(R, 'GET', '/api/recognition/ranking?year=2026&month=8');
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.body.closed, false);
    assert.deepEqual(r1.body.modules, { rh: true, pos: true });
    assert.deepEqual(r1.body.ranking.map((r) => [r.employee_name, r.rank, r.score, r.is_winner]), [
      ['Ana', 1, 91, true], ['Beto', 2, 81.33, false], ['Carla', 3, 81.25, false],
    ]);
    assert.deepEqual(r1.body.ranking[1].components, { attendance: 100, punctuality: 66.67, sales: 50, evaluation: 90, tasks: 100 });
    assert.equal(r1.body.ranking[1].sales, 500);
    const r2 = await api(R, 'GET', '/api/recognition/ranking?year=2026&month=8');
    assert.deepEqual(r2.body.ranking, r1.body.ranking);
  });

  test('cerrar el mes guarda el ranking, el ganador y su bono en la nomina; no se cierra dos veces', async () => {
    const s = await api(R, 'PUT', '/api/recognition/settings', { prize_text: 'Cena para dos', prize_amount: 500, prize_to_payroll: true });
    assert.equal(s.status, 200);
    assert.equal((await api(R, 'POST', '/api/recognition/months/2099/1/close')).body.code, 'MONTH_NOT_FINISHED');
    const close = await api(R, 'POST', '/api/recognition/months/2026/8/close');
    assert.equal(close.status, 201, JSON.stringify(close.body));
    assert.equal(close.body.closed, true);
    const winner = close.body.ranking.find((r) => r.is_winner);
    assert.equal(winner.employee_name, 'Ana');
    assert.ok(winner.adjustment_id);
    const adj = (await api(R, 'GET', `/api/rh/adjustments?employee_id=${ana.id}`)).body.adjustments;
    assert.deepEqual(adj.map((a) => [a.kind, a.concept, a.amount, a.apply_date, a.source]), [
      ['bono', 'Empleado del mes 08/2026', '500.00', '2026-09-01', 'empleado_mes'],
    ]);
    const again = await api(R, 'POST', '/api/recognition/months/2026/8/close');
    assert.equal(again.status, 409);
    // Cerrado: el ranking ya no cambia aunque cambien los datos.
    await api(R, 'PUT', '/api/recognition/settings', { weight_evaluation: 100 });
    const stored = await api(R, 'GET', '/api/recognition/ranking?year=2026&month=8');
    assert.equal(stored.body.closed, true);
    assert.deepEqual(stored.body.ranking.map((r) => [r.employee_name, r.score]), [['Ana', 91], ['Beto', 81.33], ['Carla', 81.25]]);
    assert.equal((await api(R, 'PUT', '/api/recognition/evaluations', { employee_id: ana.id, year: 2026, month: 8, score: 1 })).status, 409);
    await api(R, 'PUT', '/api/recognition/settings', { weight_evaluation: 20 });
  });

  test('el job cierra el mes anterior una sola vez y respeta el cierre automatico', async () => {
    const { runRecognitionCycle, previousMonth } = await import('../services/rh/recognition.js');
    const { localToday } = await import('../services/rh/dates.js');
    await api(S, 'PUT', '/api/recognition/settings', { auto_close: false });
    // Los modulos se contrataron hoy: el job corre con la fecha real y cierra el mes anterior.
    const now = new Date();
    prev = previousMonth(localToday('America/Mexico_City', now));
    const first = await runRecognitionCycle(now);
    assert.deepEqual(first.map((c) => [c.restaurant_id, c.year, c.month]), [[R.id, prev.year, prev.month]]);
    assert.deepEqual(await runRecognitionCycle(now), [], 'idempotente');
    const hist = await api(R, 'GET', '/api/recognition/history');
    assert.deepEqual(hist.body.months.map((m) => [m.year, m.month]), [[prev.year, prev.month], [2026, 8]]);
    assert.equal(hist.body.months[1].winners[0].employee_name, 'Ana');
    assert.equal(hist.body.months[1].prize_text, 'Cena para dos');
    assert.equal(hist.body.months[0].closed_by_name, null, 'lo cerro el job');
  });

  test('muro: cualquier rol ve al ganador y el ranking del mes', async () => {
    const wall = await api(mesero, 'GET', '/api/recognition/wall');
    assert.equal(wall.status, 200);
    assert.deepEqual(wall.body.winners_month, prev);
    assert.ok(Array.isArray(wall.body.current.ranking));
    assert.equal(wall.body.current.ranking[0].components, undefined, 'el muro no expone el desglose');
    assert.equal((await api(mesero, 'GET', '/api/recognition/ranking')).status, 403);
  });

  test('solo empleado_mes (sin rh ni pos): cuentan evaluacion y tareas', async () => {
    const b = (await api(S, 'GET', '/api/branches')).body.branches[0];
    const e = (await api(S, 'POST', '/api/employees', { full_name: 'Sol', branch_id: b.id, hire_date: '2026-01-01' })).body.employee;
    await api(S, 'PUT', '/api/recognition/evaluations', { employee_id: e.id, year: 2026, month: 8, score: 70 });
    const r = await api(S, 'GET', '/api/recognition/ranking?year=2026&month=8');
    assert.deepEqual(r.body.modules, { rh: false, pos: false });
    assert.equal(r.body.ranking[0].score, 46.67);
  });

  test('aislamiento: otro restaurante no ve ni evalua empleados ajenos', async () => {
    const r = await api(S, 'GET', '/api/recognition/ranking?year=2026&month=8');
    assert.deepEqual(r.body.ranking.map((x) => x.employee_name), ['Sol']);
    assert.equal((await api(S, 'PUT', '/api/recognition/evaluations', { employee_id: ana.id, year: 2026, month: 8, score: 1 })).status, 404);
    assert.equal((await api(S, 'POST', '/api/recognition/tasks', { employee_id: ana.id, title: 'x' })).status, 404);
    assert.deepEqual((await api(S, 'GET', '/api/recognition/history')).body.months, []);
    assert.deepEqual((await api(S, 'GET', '/api/recognition/tasks')).body.tasks, []);
    const wall = await api(S, 'GET', '/api/recognition/wall');
    assert.deepEqual(wall.body.winners, []);
  });
});
