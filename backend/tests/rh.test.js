// Recursos humanos y nomina de punta a punta contra Postgres: 402 sin el
// modulo, empleados, checador (NIP, bloqueo, sucursal, IP y geocerca),
// correcciones auditadas, prenomina (calculo, idempotencia, aprobar, firmar,
// pagar desde caja, cerrar, CSV) y aislamiento entre restaurantes (API y RLS).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DB, createRestaurant, ownerToken, setupDb } from './helpers.js';
import { zonedTimeToUtc } from '../services/rh/dates.js';

const NEW_TABLES = [
  'hr_areas', 'employees', 'employee_schedules', 'hr_clock_settings', 'time_entries', 'time_entry_audit',
  'attendance_justifications', 'payroll_settings', 'hr_holidays', 'payroll_adjustments', 'payroll_periods',
  'payroll_items', 'payroll_item_lines', 'payroll_receipt_signatures', 'recognition_settings',
  'recognition_evaluations', 'recognition_tasks', 'recognition_months', 'recognition_results',
];

describe('recursos humanos y nomina', { skip: SKIP_DB }, () => {
  let ctx; let owner; let A; let B; let C; let D;
  let branchA; let branchA2; let branchB; let tz;
  let mesero; let gerente; let meseroUser;
  let ana; let otro; let empB;

  const api = (who, method, path, body, extra = {}) => ctx.request(method, path, { token: who.token ?? who, body, ...extra });
  const cents = (lines, code) => lines.filter((l) => l.code === code).reduce((s, l) => s + Math.round(Number(l.amount) * 100), 0);

  async function addUser(R, slug, role, email, branchIds) {
    const password = 'clave-segura-9';
    const res = await api(R, 'POST', '/api/users', { email, name: `${role} ${slug}`, role, password, branch_ids: branchIds });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const login = await ctx.request('POST', '/api/auth/login', { slug, body: { email, password } });
    return { token: login.body.token, id: res.body.user.id };
  }

  /** Inserta checadas (hora local de la sucursal) directo en la BD. */
  async function insertShifts(R, employeeId, branchId, shifts) {
    await ctx.withTenant(R.id, async (db) => {
      for (const [date, inT, outT] of shifts) {
        for (const [kind, t] of [['entrada', inT], ['salida', outT]]) {
          if (!t) continue;
          await db.query(
            `INSERT INTO time_entries (restaurant_id, employee_id, branch_id, kind, occurred_at, source)
             VALUES ($1, $2, $3, $4, $5, 'kiosco')`,
            [R.id, employeeId, branchId, kind, zonedTimeToUtc(date, t, tz)],
          );
        }
      }
    });
  }

  before(async () => {
    ctx = await setupDb();
    owner = await ownerToken(ctx);
    A = await createRestaurant(ctx, owner, 'alfa', { modules: ['rh', 'pos'] });
    B = await createRestaurant(ctx, owner, 'beta', { modules: ['rh'] });
    C = await createRestaurant(ctx, owner, 'gamma', { modules: ['pos'] });
    D = await createRestaurant(ctx, owner, 'delta', { modules: ['empleado_mes'] });
    branchA = (await api(A, 'GET', '/api/branches')).body.branches[0];
    tz = branchA.timezone;
    branchA2 = (await api(A, 'POST', '/api/branches', { name: 'Sucursal Norte' })).body.branch;
    branchB = (await api(B, 'GET', '/api/branches')).body.branches[0];
    mesero = await addUser(A, 'alfa', 'mesero', 'mesero@alfa.test', [branchA.id]);
    meseroUser = mesero.id;
    gerente = await addUser(A, 'alfa', 'gerente', 'gerente@alfa.test', [branchA.id]);
  });
  after(() => ctx?.close());

  describe('requireModule', () => {
    test('sin el modulo rh todas las rutas de /api/rh responden 402', async () => {
      for (const [m, p] of [
        ['GET', '/api/rh/me'], ['GET', '/api/rh/settings'], ['GET', `/api/rh/kiosk/${branchA.id}`],
        ['POST', '/api/rh/kiosk/clock'], ['GET', '/api/rh/time-entries?from=2026-09-01&to=2026-09-02'],
        ['POST', '/api/rh/time-entries'], ['GET', '/api/rh/attendance?from=2026-09-01&to=2026-09-02'],
        ['POST', '/api/rh/justifications'], ['GET', '/api/rh/adjustments'], ['POST', '/api/rh/payroll/periods'],
        ['GET', '/api/rh/payroll/periods'], ['GET', '/api/rh/holidays'], ['PUT', '/api/rh/clock-settings/x'],
      ]) {
        const res = await api(C, m, p, m === 'GET' ? undefined : {});
        assert.equal(res.status, 402, `${m} ${p}`);
        assert.equal(res.body.code, 'MODULE_NOT_ENABLED');
        assert.equal(res.body.module, 'rh');
      }
      // Solo empleado_mes tampoco abre /api/rh.
      assert.equal((await api(D, 'GET', '/api/rh/settings')).status, 402);
      assert.equal((await ctx.request('GET', '/api/rh/settings')).status, 401, 'sin sesion');
    });

    test('/api/employees pide rh o empleado_mes', async () => {
      const res = await api(C, 'GET', '/api/employees');
      assert.equal(res.status, 402);
      assert.equal(res.body.code, 'MODULE_NOT_ENABLED');
      assert.equal((await api(D, 'GET', '/api/employees')).status, 200);
      assert.equal((await api(A, 'GET', '/api/employees')).status, 200);
    });

    test('suspendido: 402 aunque tenga rh', async () => {
      await ctx.request('POST', `/api/platform/restaurants/${B.id}/suspend`, { token: owner });
      const res = await api(B, 'GET', '/api/rh/settings');
      assert.equal(res.status, 402);
      assert.equal(res.body.code, 'RESTAURANT_SUSPENDED');
      await ctx.request('POST', `/api/platform/restaurants/${B.id}/reactivate`, { token: owner });
    });
  });

  describe('empleados', () => {
    test('alta con usuario ligado, horario y NIP; sin login tambien', async () => {
      const res = await api(A, 'POST', '/api/employees', {
        full_name: 'Ana López', user_id: meseroUser, branch_id: branchA.id, position: 'Mesera',
        pay_type: 'diario', daily_salary: 400, payment_frequency: 'semanal', hire_date: '2026-01-01',
        rfc: 'loaa800101abc', employee_number: '101', pin: '1234',
        schedule: [1, 2, 3, 4, 5, 6].map((d) => ({ day_of_week: d, start_time: '09:00', end_time: '17:00' })),
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      ana = res.body.employee;
      assert.equal(ana.rfc, 'LOAA800101ABC');
      assert.equal(ana.has_pin, true);
      assert.equal(ana.schedule.length, 6);
      assert.equal(ana.pin_hash, undefined, 'el hash nunca sale por la API');

      const o = await api(A, 'POST', '/api/employees', {
        full_name: 'Omar Ruiz', branch_id: branchA2.id, daily_salary: 300, hire_date: '2026-01-01', pin: '5555',
      });
      assert.equal(o.status, 201);
      otro = o.body.employee;
      assert.equal(otro.user_id, null);
      empB = (await api(B, 'POST', '/api/employees', { full_name: 'Berta', branch_id: branchB.id, daily_salary: 350, hire_date: '2026-01-01', pin: '9999' })).body.employee;
    });

    test('validaciones: usuario ya ligado, NIP invalido, sucursal ajena, solo admin/gerente', async () => {
      const dup = await api(A, 'POST', '/api/employees', { full_name: 'X', user_id: meseroUser, branch_id: branchA.id, hire_date: '2026-01-01' });
      assert.equal(dup.status, 409);
      assert.equal(dup.body.code, 'USER_ALREADY_LINKED');
      const badPin = await api(A, 'PUT', `/api/employees/${otro.id}/pin`, { pin: '12' });
      assert.equal(badPin.body.code, 'INVALID_PIN');
      const foreign = await api(A, 'POST', '/api/employees', { full_name: 'X', branch_id: branchB.id, hire_date: '2026-01-01' });
      assert.equal(foreign.status, 400);
      assert.equal(foreign.body.code, 'BRANCH_NOT_FOUND');
      assert.equal((await api(mesero, 'GET', '/api/employees')).status, 403);
      assert.equal((await api(gerente, 'GET', '/api/employees')).status, 200);
    });
  });

  describe('checador', () => {
    test('NIP incorrecto, bloqueo tras 5 intentos y desbloqueo al cambiarlo', async () => {
      for (let i = 1; i <= 4; i += 1) {
        const r = await api(mesero, 'POST', '/api/rh/kiosk/clock', { branch_id: branchA.id, employee_id: ana.id, pin: '0000' });
        assert.equal(r.status, 401);
        assert.equal(r.body.code, 'INVALID_PIN');
      }
      const fifth = await api(mesero, 'POST', '/api/rh/kiosk/clock', { branch_id: branchA.id, employee_id: ana.id, pin: '0000' });
      assert.equal(fifth.status, 423);
      const right = await api(mesero, 'POST', '/api/rh/kiosk/clock', { branch_id: branchA.id, employee_id: ana.id, pin: '1234' });
      assert.equal(right.status, 423, 'bloqueado aunque el NIP sea correcto');
      assert.equal(right.body.code, 'PIN_LOCKED');
      assert.equal((await api(A, 'PUT', `/api/employees/${ana.id}/pin`, { pin: '4321' })).status, 200);
    });

    test('entrada y salida por kiosco; repetida en menos de un minuto se rechaza', async () => {
      const list = await api(mesero, 'GET', `/api/rh/kiosk/${branchA.id}`);
      assert.equal(list.status, 200);
      assert.deepEqual(list.body.employees.map((e) => e.full_name), ['Ana López']);
      assert.equal(list.body.employees[0].pin_hash, undefined);

      const inRes = await api(mesero, 'POST', '/api/rh/kiosk/clock', { branch_id: branchA.id, employee_id: ana.id, pin: '4321' });
      assert.equal(inRes.status, 201, JSON.stringify(inRes.body));
      assert.equal(inRes.body.entry.kind, 'entrada');
      const again = await api(mesero, 'POST', '/api/rh/kiosk/clock', { branch_id: branchA.id, employee_id: ana.id, pin: '4321' });
      assert.equal(again.status, 409);
      assert.equal(again.body.code, 'CLOCK_DUPLICATE');
      await ctx.withTenant(A.id, (db) => db.query(
        "UPDATE time_entries SET occurred_at = occurred_at - interval '3 hours' WHERE id = $1", [inRes.body.entry.id],
      ));
      const out = await api(mesero, 'POST', '/api/rh/kiosk/clock', { branch_id: branchA.id, employee_id: ana.id, pin: '4321' });
      assert.equal(out.status, 201);
      assert.equal(out.body.entry.kind, 'salida');
    });

    test('restriccion por sucursal: empleado de otra sucursal o usuario sin acceso', async () => {
      const wrongBranch = await api(A, 'POST', '/api/rh/kiosk/clock', { branch_id: branchA.id, employee_id: otro.id, pin: '5555' });
      assert.equal(wrongBranch.status, 404);
      const noAccess = await api(mesero, 'POST', '/api/rh/kiosk/clock', { branch_id: branchA2.id, employee_id: otro.id, pin: '5555' });
      assert.equal(noAccess.status, 403);
      assert.equal(noAccess.body.code, 'BRANCH_FORBIDDEN');
      assert.equal((await api(mesero, 'GET', `/api/rh/kiosk/${branchA2.id}`)).status, 403);
    });

    test('restriccion por IP y por geocerca', async () => {
      let r = await api(A, 'PUT', `/api/rh/clock-settings/${branchA2.id}`, { allowed_ips: ['10.0.0.0/8'] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      r = await api(A, 'POST', '/api/rh/kiosk/clock', { branch_id: branchA2.id, employee_id: otro.id, pin: '5555' });
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'CLOCK_IP_NOT_ALLOWED');

      // Geocerca en el Zocalo de la CDMX, radio 100 m, y la IP ya permitida.
      await api(A, 'PUT', `/api/rh/clock-settings/${branchA2.id}`, {
        allowed_ips: ['127.0.0.1'], geo_enabled: true, latitude: 19.432608, longitude: -99.133209, radius_meters: 100,
      });
      r = await api(A, 'POST', '/api/rh/kiosk/clock', { branch_id: branchA2.id, employee_id: otro.id, pin: '5555' });
      assert.equal(r.body.code, 'CLOCK_LOCATION_REQUIRED');
      r = await api(A, 'POST', '/api/rh/kiosk/clock', { branch_id: branchA2.id, employee_id: otro.id, pin: '5555', latitude: 19.4400, longitude: -99.1400 });
      assert.equal(r.body.code, 'CLOCK_OUT_OF_RANGE');
      r = await api(A, 'POST', '/api/rh/kiosk/clock', { branch_id: branchA2.id, employee_id: otro.id, pin: '5555', latitude: 19.4330, longitude: -99.1335 });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.entry.kind, 'entrada');
      const bad = await api(A, 'PUT', `/api/rh/clock-settings/${branchA2.id}`, { allowed_ips: ['no-es-ip'] });
      assert.equal(bad.status, 400);
    });

    test('correcciones manuales con motivo y bitacora (crear, editar, anular)', async () => {
      const noReason = await api(gerente, 'POST', '/api/rh/time-entries', { employee_id: ana.id, kind: 'entrada', date: '2026-09-01', time: '09:00' });
      assert.equal(noReason.status, 400);
      assert.equal((await api(mesero, 'POST', '/api/rh/time-entries', { employee_id: ana.id, kind: 'entrada', date: '2026-09-01', time: '09:00', reason: 'x' })).status, 403);

      const created = await api(gerente, 'POST', '/api/rh/time-entries', {
        employee_id: ana.id, kind: 'entrada', date: '2026-09-01', time: '09:00', reason: 'Olvidó checar',
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const id = created.body.entry.id;
      assert.equal(created.body.entry.source, 'manual');
      const edited = await api(gerente, 'PATCH', `/api/rh/time-entries/${id}`, { date: '2026-09-01', time: '08:55', reason: 'Hora real según cámara' });
      assert.equal(edited.status, 200);
      const voided = await api(A, 'POST', `/api/rh/time-entries/${id}/void`, { reason: 'Duplicada' });
      assert.equal(voided.body.entry.voided, true);
      const log = await api(A, 'GET', `/api/rh/time-entries/${id}/audit`);
      assert.deepEqual(log.body.audit.map((a) => [a.action, a.reason]), [
        ['crear', 'Olvidó checar'], ['editar', 'Hora real según cámara'], ['anular', 'Duplicada'],
      ]);
      assert.equal(log.body.audit[1].before.occurred_at, zonedTimeToUtc('2026-09-01', '09:00', tz).toISOString());
      assert.equal(log.body.audit[1].after.occurred_at, zonedTimeToUtc('2026-09-01', '08:55', tz).toISOString());
      assert.equal(log.body.audit[1].user_name, 'gerente alfa');
    });

    test('importacion generica de otro reloj (sin duplicar)', async () => {
      const events = [
        { employee_number: '101', occurred_at: zonedTimeToUtc('2026-08-03', '09:00', tz).toISOString() },
        { employee_number: '101', occurred_at: zonedTimeToUtc('2026-08-03', '17:00', tz).toISOString() },
        { employee_number: '999', occurred_at: '2026-08-03T15:00:00Z' },
      ];
      const r1 = await api(A, 'POST', '/api/rh/time-entries/import', { events });
      assert.deepEqual([r1.body.imported, r1.body.duplicates, r1.body.rejected.length], [2, 0, 1]);
      const r2 = await api(A, 'POST', '/api/rh/time-entries/import', { events });
      assert.deepEqual([r2.body.imported, r2.body.duplicates], [0, 2]);
      const list = await api(A, 'GET', `/api/rh/time-entries?from=2026-08-03&to=2026-08-03&employee_id=${ana.id}`);
      assert.deepEqual(list.body.entries.map((e) => [e.kind, e.source]), [['salida', 'importado'], ['entrada', 'importado']]);
      assert.equal((await api(gerente, 'POST', '/api/rh/time-entries/import', { events })).status, 403);
    });
  });

  describe('prenomina', () => {
    let period; let item; let loanId;

    test('configuracion, justificacion y ajustes', async () => {
      const s = await api(A, 'PUT', '/api/rh/settings', {
        tolerance_minutes: 10, tardiness_penalty: 50, tardiness_proportional: true, absence_penalty: 100,
        pay_rest_days: true, overtime_block_minutes: 30, overtime_double_weekly_hours: 9, holiday_worked_factor: 2,
        sunday_premium_pct: 25, punctuality_bonus: 200, attendance_bonus: 150, week_start_day: 1,
      });
      assert.equal(s.status, 200, JSON.stringify(s.body));
      assert.equal((await api(gerente, 'PUT', '/api/rh/settings', { tolerance_minutes: 5 })).status, 403);

      await insertShifts(A, ana.id, branchA.id, [
        ['2026-09-14', '09:05', '17:00'],
        ['2026-09-15', '09:25', '17:00'],
        ['2026-09-16', '09:00', '17:00'],
        ['2026-09-18', '09:00', '19:10'],
      ]);
      const j = await api(gerente, 'POST', '/api/rh/justifications', {
        employee_id: ana.id, date: '2026-09-19', kind: 'falta', note: 'Cita médica', with_pay: true,
      });
      assert.equal(j.status, 201, JSON.stringify(j.body));
      const adj = async (body) => {
        const r = await api(A, 'POST', '/api/rh/adjustments', { employee_id: ana.id, ...body });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        return r.body.adjustment;
      };
      await adj({ kind: 'bono', concept: 'Ventas', amount: 300, recurrence: 'unico', apply_date: '2026-09-18' });
      loanId = (await adj({ kind: 'prestamo', concept: 'Préstamo personal', amount: 400, total_amount: 1000, start_date: '2026-09-14' })).id;
      await adj({ kind: 'descuento', concept: 'Uniforme', amount: 75, recurrence: 'cada_periodo', start_date: '2026-09-01', end_date: '2026-09-20' });

      const att = await api(A, 'GET', `/api/rh/attendance?from=2026-09-14&to=2026-09-20&employee_id=${ana.id}`);
      assert.deepEqual(att.body.employees[0].days.map((d) => d.status), [
        'trabajado', 'trabajado', 'trabajado', 'falta', 'trabajado', 'falta_justificada', 'descanso',
      ]);
      assert.equal(att.body.employees[0].summary.tardies, 1);
    });

    test('generar el periodo calcula cada recibo con montos exactos', async () => {
      const res = await api(gerente, 'POST', '/api/rh/payroll/periods', { frequency: 'semanal', date: '2026-09-16' });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.created, true);
      period = res.body.period;
      assert.deepEqual([period.start_date, period.end_date, period.status], ['2026-09-14', '2026-09-20', 'borrador']);

      const detail = await api(A, 'GET', `/api/rh/payroll/periods/${period.id}`);
      assert.deepEqual(detail.body.items.map((i) => i.employee_name), ['Ana López', 'Omar Ruiz']);
      item = detail.body.items[0];
      assert.equal(cents(item.lines, 'sueldo'), 240000); // 6 dias x 400
      assert.equal(cents(item.lines, 'horas_extra_dobles'), 20000);
      assert.equal(cents(item.lines, 'festivo_trabajado'), 80000);
      assert.equal(cents(item.lines, 'retardos'), 7083);
      assert.equal(cents(item.lines, 'faltas'), 10000);
      assert.equal(cents(item.lines, 'bono'), 30000);
      assert.equal(cents(item.lines, 'prestamo'), 40000);
      assert.equal(cents(item.lines, 'descuento'), 7500);
      assert.equal(cents(item.lines, 'bono_puntualidad') + cents(item.lines, 'bono_asistencia'), 0);
      assert.deepEqual([item.gross, item.deductions, item.net], ['3700.00', '645.83', '3054.17']);
      assert.deepEqual([item.days_worked, item.tardies, item.absences, item.absences_justified, item.holidays_worked], [4, 1, 1, 1, 1]);
      // Omar no tiene horario: todos sus dias son descanso pagado (6 + el festivo).
      const omar = detail.body.items[1];
      assert.deepEqual([omar.absences, omar.rest_days_paid, omar.holidays, omar.gross, omar.net], [0, 6, 1, '2100.00', '2100.00']);
      assert.equal(detail.body.period.total_net, '5154.17');
    });

    test('es idempotente: generar otra vez regresa el mismo y recalcular no duplica', async () => {
      const again = await api(A, 'POST', '/api/rh/payroll/periods', { frequency: 'semanal', date: '2026-09-20' });
      assert.equal(again.status, 200);
      assert.equal(again.body.created, false);
      assert.equal(again.body.period.id, period.id);
      const recalc = await api(A, 'POST', `/api/rh/payroll/periods/${period.id}/calculate`);
      assert.equal(recalc.status, 200);
      assert.equal(recalc.body.items.length, 2);
      assert.equal(recalc.body.items[0].lines.length, item.lines.length);
      assert.equal(recalc.body.period.total_net, '5154.17');
      const count = await ctx.withTenant(A.id, async (db) => (await db.query(
        'SELECT count(*)::int AS n FROM payroll_periods WHERE restaurant_id = $1', [A.id],
      )).rows[0].n);
      assert.equal(count, 1);
    });

    test('el prestamo se descuenta por periodos hasta cubrir el total', async () => {
      const w2 = (await api(A, 'POST', '/api/rh/payroll/periods', { frequency: 'semanal', date: '2026-09-21' })).body.period;
      const w3 = (await api(A, 'POST', '/api/rh/payroll/periods', { frequency: 'semanal', date: '2026-09-28' })).body.period;
      const w4 = (await api(A, 'POST', '/api/rh/payroll/periods', { frequency: 'semanal', date: '2026-10-05' })).body.period;
      const loanOf = async (p) => {
        const d = await api(A, 'GET', `/api/rh/payroll/periods/${p.id}`);
        return cents(d.body.items.find((i) => i.employee_id === ana.id).lines, 'prestamo');
      };
      assert.deepEqual([await loanOf(w2), await loanOf(w3), await loanOf(w4)], [40000, 20000, 0]);
      const adjs = await api(A, 'GET', `/api/rh/adjustments?employee_id=${ana.id}`);
      assert.equal(adjs.body.adjustments.find((a) => a.id === loanId).applied_amount, '1000.00');
      assert.equal((await api(A, 'DELETE', `/api/rh/adjustments/${loanId}`)).status, 409, 'aplicado: no se borra');
    });

    test('aprobar bloquea recalculos y correcciones de esos dias', async () => {
      assert.equal((await api(gerente, 'POST', `/api/rh/payroll/periods/${period.id}/approve`)).status, 403);
      const ok = await api(A, 'POST', `/api/rh/payroll/periods/${period.id}/approve`);
      assert.equal(ok.status, 200);
      assert.equal(ok.body.period.status, 'aprobada');
      const recalc = await api(A, 'POST', `/api/rh/payroll/periods/${period.id}/calculate`);
      assert.equal(recalc.status, 409);
      assert.equal(recalc.body.code, 'PERIOD_LOCKED');
      const fix = await api(A, 'POST', '/api/rh/time-entries', { employee_id: ana.id, kind: 'entrada', date: '2026-09-17', time: '09:00', reason: 'x' });
      assert.equal(fix.status, 409);
      assert.equal(fix.body.code, 'PERIOD_LOCKED');
      const just = await api(A, 'POST', '/api/rh/justifications', { employee_id: ana.id, date: '2026-09-17', kind: 'falta', note: 'x' });
      assert.equal(just.body.code, 'PERIOD_LOCKED');
    });

    test('el empleado ve y firma su recibo; los borradores no se ven', async () => {
      const me = await api(mesero, 'GET', '/api/rh/me');
      assert.equal(me.status, 200);
      assert.equal(me.body.employee.full_name, 'Ana López');
      assert.equal(me.body.employee.daily_salary, undefined);
      const att = await api(mesero, 'GET', '/api/rh/me/attendance?from=2026-09-14&to=2026-09-20');
      assert.equal(att.body.summary.days_worked, 4);
      assert.equal(att.body.entries.length, 8);

      const list = await api(mesero, 'GET', '/api/rh/me/receipts');
      assert.deepEqual(list.body.receipts.map((r) => r.start_date), ['2026-09-14'], 'solo el aprobado');
      const r = await api(mesero, 'GET', `/api/rh/me/receipts/${item.id}`);
      assert.equal(r.body.item.net, '3054.17');
      const w2Item = (await ctx.withTenant(A.id, async (db) => (await db.query(
        "SELECT i.id FROM payroll_items i JOIN payroll_periods p ON p.id = i.period_id WHERE p.start_date = '2026-09-21' AND i.employee_id = $1", [ana.id],
      )).rows[0]));
      assert.equal((await api(mesero, 'GET', `/api/rh/me/receipts/${w2Item.id}`)).status, 404);
      assert.equal((await api(gerente, 'GET', '/api/rh/me')).body.code, 'NOT_AN_EMPLOYEE');

      assert.equal((await api(mesero, 'POST', `/api/rh/me/receipts/${item.id}/sign`, {})).body.code, 'ACCEPT_REQUIRED');
      const sign = await api(mesero, 'POST', `/api/rh/me/receipts/${item.id}/sign`, { accept: true });
      assert.equal(sign.status, 201);
      assert.ok(sign.body.item.signed_at);
      assert.equal(sign.body.item.net_at_signing, '3054.17');
      assert.equal((await api(mesero, 'POST', `/api/rh/me/receipts/${item.id}/sign`, { accept: true })).status, 409);
      // Firmado: ya no se puede reabrir.
      const reopen = await api(A, 'POST', `/api/rh/payroll/periods/${period.id}/reopen`);
      assert.equal(reopen.body.code, 'PERIOD_HAS_ACTIVITY');
    });

    test('pagar desde la caja registra la salida de efectivo; cerrar exige todo pagado', async () => {
      const open = await api(A, 'POST', '/api/pos/cash-sessions/open', { branch_id: branchA.id, opening_cash: 5000 });
      assert.equal(open.status, 201);
      const sessionId = open.body.session.id;
      const pay = await api(A, 'POST', `/api/rh/payroll/items/${item.id}/pay`, { method: 'caja', cash_session_id: sessionId });
      assert.equal(pay.status, 200, JSON.stringify(pay.body));
      const cash = await api(A, 'GET', `/api/pos/cash-sessions/${sessionId}`);
      assert.deepEqual(cash.body.movements.map((m) => [m.kind, m.amount]), [['salida', '3054.17']]);
      assert.match(cash.body.movements[0].reason, /Nómina Ana López \(2026-09-14 al 2026-09-20\)/);
      assert.equal(cash.body.cut.expected_cash, 5000 - 3054.17);
      assert.equal((await api(A, 'POST', `/api/rh/payroll/items/${item.id}/pay`, { method: 'efectivo' })).body.code, 'ITEM_ALREADY_PAID');

      const close = await api(A, 'POST', `/api/rh/payroll/periods/${period.id}/close`);
      assert.equal(close.status, 409);
      assert.equal(close.body.code, 'PERIOD_UNPAID');
      const all = await api(A, 'POST', `/api/rh/payroll/periods/${period.id}/pay-all`, { method: 'transferencia' });
      assert.equal(all.body.paid, 1);
      const closed = await api(A, 'POST', `/api/rh/payroll/periods/${period.id}/close`);
      assert.equal(closed.status, 200);
      assert.equal(closed.body.period.status, 'cerrada');
      assert.deepEqual(closed.body.items.map((i) => i.paid_method), ['caja', 'transferencia']);
    });

    test('reporte CSV del periodo', async () => {
      const res = await api(A, 'GET', `/api/rh/payroll/periods/${period.id}/export.csv`);
      assert.equal(res.status, 200);
      const text = String(res.body);
      assert.match(text, /^﻿Nómina semanal del 2026-09-14 al 2026-09-20/);
      assert.match(text, /Ana López,Mesera,.*,3700.00,645.83,3054.17,Sí,caja,Sí/);
      assert.match(text, /TOTAL,.*,5800.00,645.83,5154.17/);
    });

    test('sin el modulo POS no se paga desde caja', async () => {
      const p = (await api(B, 'POST', '/api/rh/payroll/periods', { frequency: 'semanal', date: '2026-09-16' })).body.period;
      // Sin horario: todos los dias son descanso pagado.
      const d = await api(B, 'GET', `/api/rh/payroll/periods/${p.id}`);
      assert.equal(d.body.items[0].net, '2450.00');
      await api(B, 'POST', `/api/rh/payroll/periods/${p.id}/approve`);
      const pay = await api(B, 'POST', `/api/rh/payroll/items/${d.body.items[0].id}/pay`, { method: 'caja', cash_session_id: d.body.items[0].id });
      assert.equal(pay.status, 402);
      assert.equal(pay.body.module, 'pos');
    });
  });

  describe('aislamiento entre restaurantes', () => {
    test('B no ve ni toca empleados, checadas, ajustes ni nominas de A', async () => {
      assert.deepEqual((await api(B, 'GET', '/api/employees')).body.employees.map((e) => e.full_name), ['Berta']);
      assert.equal((await api(B, 'GET', `/api/employees/${ana.id}`)).status, 404);
      assert.equal((await api(B, 'PATCH', `/api/employees/${ana.id}`, { position: 'X' })).status, 404);
      assert.equal((await api(B, 'PUT', `/api/employees/${ana.id}/pin`, { pin: '1111' })).status, 404);
      assert.equal((await api(B, 'GET', '/api/rh/time-entries?from=2026-08-01&to=2026-09-30')).body.entries.length, 0);
      assert.equal((await api(B, 'GET', '/api/rh/adjustments')).body.adjustments.length, 0);
      const periods = (await api(B, 'GET', '/api/rh/payroll/periods')).body.periods;
      assert.ok(periods.every((p) => !p.id || p.employees_count === 1));
      assert.equal((await api(B, 'GET', `/api/rh/payroll/periods/${(await api(A, 'GET', '/api/rh/payroll/periods')).body.periods[0].id}`)).status, 404);
      assert.equal((await api(B, 'POST', '/api/rh/kiosk/clock', { branch_id: branchA.id, employee_id: ana.id, pin: '4321' })).status, 404);
      assert.equal((await api(B, 'POST', '/api/rh/time-entries', { employee_id: ana.id, kind: 'entrada', date: '2026-09-01', time: '09:00', reason: 'x' })).status, 404);
      assert.equal((await api(B, 'POST', '/api/rh/justifications', { employee_id: ana.id, date: '2026-09-01', kind: 'falta', note: 'x' })).status, 404);
      assert.equal((await api(B, 'POST', '/api/rh/adjustments', { employee_id: ana.id, kind: 'bono', concept: 'x', amount: 1, apply_date: '2026-09-01' })).status, 404);
      assert.equal((await api(B, 'PUT', `/api/rh/clock-settings/${branchA.id}`, {})).status, 404);
      // El token de A no sirve en el tenant de B.
      const cross = await ctx.request('GET', '/api/rh/settings', { token: A.token, slug: 'beta' });
      assert.equal(cross.status, 403);
      assert.equal(cross.body.code, 'TENANT_MISMATCH');
    });

    test('RLS: cada tabla nueva falla cerrado y bloquea escrituras cruzadas', async () => {
      for (const t of NEW_TABLES) {
        const seen = await ctx.withTenant(B.id, async (db) => (await db.query(
          `SELECT count(*)::int AS n FROM ${t} WHERE restaurant_id = $1`, [A.id],
        )).rows[0].n);
        assert.equal(seen, 0, `${t}: B no ve filas de A`);
        const outside = (await ctx.pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
        assert.equal(outside, 0, `${t}: sin contexto no se ve nada`);
      }
      const own = await ctx.withTenant(A.id, async (db) => (await db.query('SELECT count(*)::int AS n FROM payroll_items')).rows[0].n);
      assert.ok(own > 0);
      await assert.rejects(
        ctx.withTenant(B.id, (db) => db.query(
          "INSERT INTO hr_areas (restaurant_id, name) VALUES ($1, 'Cocina')", [A.id],
        )),
        /row-level security/,
      );
      await assert.rejects(
        ctx.withTenant(B.id, (db) => db.query(
          `INSERT INTO time_entries (restaurant_id, employee_id, branch_id, kind, occurred_at) VALUES ($1, $2, $3, 'entrada', now())`,
          [A.id, ana.id, branchA.id],
        )),
        /row-level security/,
      );
      // Una fila de B no puede apuntar a un empleado de A (llave compuesta).
      await assert.rejects(
        ctx.withTenant(B.id, (db) => db.query(
          `INSERT INTO time_entries (restaurant_id, employee_id, branch_id, kind, occurred_at) VALUES ($1, $2, $3, 'entrada', now())`,
          [B.id, ana.id, branchB.id],
        )),
        /foreign key|violates/,
      );
    });
  });
});
