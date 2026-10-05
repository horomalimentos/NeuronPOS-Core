// Calculos puros de nomina: periodos, festivos oficiales, asistencia,
// horas extra, festivos, retardos, faltas, bonos y ajustes (en centavos).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mexicanHolidays, holidaysBetween } from '../services/rh/holidays.js';
import {
  analyzeAttendance, applicableAdjustments, calculatePayroll, markOpenShiftsPending, periodRange,
} from '../services/rh/payrollMath.js';
import { localParts, zonedTimeToUtc } from '../services/rh/dates.js';

const TZ = 'America/Mexico_City'; // UTC-6 todo el anio desde 2023
const at = (date, time) => zonedTimeToUtc(date, time, TZ).toISOString();
const shift = (date, inT, outT) => [{ kind: 'entrada', occurred_at: at(date, inT) }, { kind: 'salida', occurred_at: at(date, outT) }];
const cents = (lines, code) => lines.filter((l) => l.code === code).reduce((s, l) => s + l.cents, 0);

const SETTINGS = {
  week_start_day: 1,
  daily_hours: '8.00',
  tolerance_minutes: 10,
  tardiness_penalty: '50.00',
  tardiness_proportional: true,
  absence_penalty: '100.00',
  pay_rest_days: true,
  overtime_enabled: true,
  overtime_block_minutes: 30,
  overtime_double_weekly_hours: 9,
  overtime_double_factor: '2.00',
  overtime_triple_factor: '3.00',
  holiday_worked_factor: '2.00',
  rest_day_worked_factor: '2.00',
  sunday_premium_pct: '25.00',
  official_holidays: true,
  punctuality_bonus: '200.00',
  attendance_bonus: '150.00',
};

const MON_SAT_9_17 = [1, 2, 3, 4, 5, 6].map((d) => ({ day_of_week: d, start_time: '09:00:00', end_time: '17:00:00' }));

test('festivos oficiales de Mexico por regla', () => {
  assert.deepEqual(mexicanHolidays(2026).map((h) => h.date), [
    '2026-01-01', '2026-02-02', '2026-03-16', '2026-05-01', '2026-09-16', '2026-11-16', '2026-12-25',
  ]);
  assert.ok(mexicanHolidays(2030).some((h) => h.date === '2030-10-01'));
  assert.ok(!mexicanHolidays(2026).some((h) => h.date === '2026-10-01'));
  const map = holidaysBetween('2026-09-14', '2026-09-20', { custom: [{ date: '2026-09-15', name: 'Aniversario' }] });
  assert.deepEqual([...map.keys()], ['2026-09-16', '2026-09-15']);
  assert.equal(holidaysBetween('2026-09-14', '2026-09-20', { official: false }).size, 0);
});

test('periodos semanal (con dia de inicio), quincenal y mensual', () => {
  assert.deepEqual(periodRange('semanal', '2026-09-17', 1), { start: '2026-09-14', end: '2026-09-20' });
  assert.deepEqual(periodRange('semanal', '2026-09-14', 1), { start: '2026-09-14', end: '2026-09-20' });
  assert.deepEqual(periodRange('semanal', '2026-09-17', 4), { start: '2026-09-17', end: '2026-09-23' });
  assert.deepEqual(periodRange('semanal', '2026-09-13', 1), { start: '2026-09-07', end: '2026-09-13' });
  assert.deepEqual(periodRange('quincenal', '2026-02-15'), { start: '2026-02-01', end: '2026-02-15' });
  assert.deepEqual(periodRange('quincenal', '2026-02-16'), { start: '2026-02-16', end: '2026-02-28' });
  assert.deepEqual(periodRange('mensual', '2028-02-10'), { start: '2028-02-01', end: '2028-02-29' });
});

test('hora local de la sucursal: la checada de las 23:30 cuenta en su dia local', () => {
  assert.deepEqual(localParts('2026-09-15T05:30:00Z', TZ), { date: '2026-09-14', minutes: 23 * 60 + 30 });
  assert.equal(at('2026-09-14', '09:00'), '2026-09-14T15:00:00.000Z');
});

test('nomina semanal con salario diario: retardo, falta, festivo trabajado, horas extra, permiso con goce y ajustes', () => {
  const period = { start: '2026-09-14', end: '2026-09-20' };
  const entries = [
    ...shift('2026-09-14', '09:05', '17:00'), // a tiempo (5 min < 10 de tolerancia)
    ...shift('2026-09-15', '09:25', '17:00'), // retardo de 25 min
    ...shift('2026-09-16', '09:00', '17:00'), // festivo (16 de septiembre) trabajado
    // 17: falta injustificada
    ...shift('2026-09-18', '09:00', '19:10'), // 130 min extra -> 120 en bloques de 30
    // 19: falta justificada con goce; 20: domingo de descanso
  ];
  const days = analyzeAttendance({
    from: period.start, to: period.end, schedule: MON_SAT_9_17, entries, timeZone: TZ,
    holidays: holidaysBetween(period.start, period.end),
    justifications: [{ date: '2026-09-19', kind: 'falta', with_pay: true, note: 'Cita médica' }],
    toleranceMinutes: 10, hireDate: '2026-01-01', today: '2026-09-21',
  });
  assert.deepEqual(days.map((d) => d.status), [
    'trabajado', 'trabajado', 'trabajado', 'falta', 'trabajado', 'falta_justificada', 'descanso',
  ]);
  const adjustments = applicableAdjustments([
    { id: 'b1', kind: 'bono', concept: 'Ventas', amount: '300.00', recurrence: 'unico', apply_date: '2026-09-18', active: true },
    { id: 'b2', kind: 'bono', concept: 'Otro periodo', amount: '999.00', recurrence: 'unico', apply_date: '2026-09-21', active: true },
    { id: 'p1', kind: 'prestamo', concept: 'Préstamo', amount: '400.00', total_amount: '1000.00', recurrence: 'cada_periodo', start_date: '2026-08-01', active: true },
    { id: 'd1', kind: 'descuento', concept: 'Uniforme', amount: '75.00', recurrence: 'cada_periodo', start_date: '2026-09-01', end_date: '2026-09-30', active: true },
    { id: 'd2', kind: 'descuento', concept: 'Inactivo', amount: '10.00', recurrence: 'cada_periodo', start_date: '2026-09-01', active: false },
  ], period, new Map([['p1', 80000]]));
  // Del prestamo de 1000 ya se descontaron 800: solo quedan 200.
  assert.deepEqual(adjustments.map((a) => [a.adjustment_id, a.cents]), [['b1', 30000], ['p1', 20000], ['d1', 7500]]);

  const r = calculatePayroll({
    employee: { pay_type: 'diario', daily_salary: '400.00', hourly_rate: '0' }, settings: SETTINGS, days, adjustments,
  });
  // Pagados: lun, mar, mie (festivo), vie, sab (con goce) y dom (descanso) = 6 x 400.
  assert.equal(r.days_paid, 6);
  assert.equal(cents(r.lines, 'sueldo'), 240000);
  assert.equal(cents(r.lines, 'horas_extra_dobles'), 20000); // 2 h x 50 x 2
  assert.equal(cents(r.lines, 'horas_extra_triples'), 0);
  assert.equal(cents(r.lines, 'festivo_trabajado'), 80000); // 400 x 2 adicional
  assert.equal(cents(r.lines, 'prima_dominical'), 0);
  assert.equal(cents(r.lines, 'bono_puntualidad'), 0); // tuvo retardo
  assert.equal(cents(r.lines, 'bono_asistencia'), 0); // tuvo falta
  assert.equal(cents(r.lines, 'retardos'), 7083); // 50 + 25 min x 0.8333
  assert.equal(cents(r.lines, 'faltas'), 10000);
  assert.equal(cents(r.lines, 'bono'), 30000);
  assert.equal(cents(r.lines, 'prestamo'), 20000);
  assert.equal(cents(r.lines, 'descuento'), 7500);
  assert.equal(r.gross, 3700);
  assert.equal(r.deductions, 445.83);
  assert.equal(r.net, 3254.17);
  assert.deepEqual(
    [r.days_worked, r.tardies, r.tardy_minutes, r.absences, r.absences_justified, r.holidays, r.holidays_worked, r.rest_days_paid],
    [4, 1, 25, 1, 1, 1, 1, 1],
  );
  assert.equal(r.overtime_minutes_double, 120);
  assert.equal(r.minutes_worked, 475 + 455 + 480 + 610);
});

test('nomina por hora: horas extra dobles y triples por semana, descanso trabajado en domingo y bonos', () => {
  const period = { start: '2026-09-21', end: '2026-09-27' };
  const schedule = [1, 2, 3, 4, 5].map((d) => ({ day_of_week: d, start_time: '08:00', end_time: '16:00' }));
  const entries = [
    ...shift('2026-09-21', '08:00', '19:00'), // 180 extra
    ...shift('2026-09-22', '07:55', '18:00'), // 125 extra -> 120
    ...shift('2026-09-23', '08:00', '16:00'),
    ...shift('2026-09-24', '08:00', '16:00'),
    ...shift('2026-09-25', '08:00', '16:00'),
    ...shift('2026-09-27', '10:00', '14:00'), // domingo de descanso trabajado
  ];
  const settings = { ...SETTINGS, overtime_double_weekly_hours: 2 };
  const days = analyzeAttendance({ from: period.start, to: period.end, schedule, entries, timeZone: TZ, toleranceMinutes: 10, today: '2026-09-28' });
  const r = calculatePayroll({ employee: { pay_type: 'por_hora', daily_salary: '0', hourly_rate: '60.00' }, settings, days });
  // 660 + 605 + 480 x 3 + 240 = 2945 min; extra 300 -> base 2645 min.
  assert.equal(r.minutes_worked, 2945);
  assert.equal(r.overtime_minutes_double, 120);
  assert.equal(r.overtime_minutes_triple, 180);
  assert.equal(cents(r.lines, 'sueldo'), 264500); // 2645/60 x 60
  assert.equal(cents(r.lines, 'horas_extra_dobles'), 24000);
  assert.equal(cents(r.lines, 'horas_extra_triples'), 54000);
  assert.equal(cents(r.lines, 'descanso_trabajado'), 48000); // 4 h x 60 x 2
  assert.equal(cents(r.lines, 'prima_dominical'), 6000); // 25 % de 240
  assert.equal(cents(r.lines, 'bono_puntualidad'), 20000);
  assert.equal(cents(r.lines, 'bono_asistencia'), 15000);
  assert.equal(r.gross, 4315);
  assert.equal(r.net, 4315);
  assert.equal(r.days_paid, 0);
});

test('retardo justificado no descuenta; descuento fijo sin proporcional; dias fuera de contrato y futuros', () => {
  const period = { start: '2026-09-14', end: '2026-09-20' };
  const entries = [...shift('2026-09-15', '09:40', '17:00'), ...shift('2026-09-16', '09:30', '17:00')];
  const days = analyzeAttendance({
    from: period.start, to: period.end, schedule: MON_SAT_9_17, entries, timeZone: TZ,
    justifications: [{ date: '2026-09-15', kind: 'retardo', note: 'Tráfico' }],
    toleranceMinutes: 10, hireDate: '2026-09-15', today: '2026-09-17',
  });
  // 14: antes de contratarse; 17 en adelante: pendientes (hoy = 17 sin checada aun).
  assert.deepEqual(days.map((d) => d.status), [
    'fuera_de_contrato', 'trabajado', 'trabajado', 'falta', 'pendiente', 'pendiente', 'pendiente',
  ]);
  markOpenShiftsPending(days, '2026-09-17', 12 * 60);
  assert.equal(days[3].status, 'pendiente', 'el turno de hoy aun no termina');
  const r = calculatePayroll({
    employee: { pay_type: 'diario', daily_salary: '300.00' },
    settings: { ...SETTINGS, holiday_worked_factor: '0', tardiness_proportional: false, official_holidays: false, punctuality_bonus: '0', attendance_bonus: '100' },
    days,
  });
  assert.equal(r.tardies, 1);
  assert.equal(cents(r.lines, 'retardos'), 5000); // solo el del 16 y sin proporcional
  assert.equal(cents(r.lines, 'sueldo'), 60000);
  assert.equal(cents(r.lines, 'bono_asistencia'), 10000);
  assert.equal(r.net, 650);
});

test('las deducciones nunca dejan el neto negativo', () => {
  const days = analyzeAttendance({ from: '2026-09-14', to: '2026-09-14', schedule: MON_SAT_9_17, timeZone: TZ, today: '2026-09-30' });
  const r = calculatePayroll({
    employee: { pay_type: 'diario', daily_salary: '100.00' },
    settings: { ...SETTINGS, absence_penalty: '150.00', pay_rest_days: false },
    days,
    adjustments: [{ adjustment_id: 'x', kind: 'descuento', concept: 'Daño', cents: 5000 }],
  });
  assert.equal(r.gross, 0);
  assert.equal(r.deductions, 200);
  assert.equal(r.net, 0);
  assert.equal(r.uncollected, 200);
});
