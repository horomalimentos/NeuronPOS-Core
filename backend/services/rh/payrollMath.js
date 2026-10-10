// Calculo de la nomina de un empleado en un periodo. Funciones puras: todo en
// centavos enteros y se regresa en pesos con 2 decimales (mismo criterio que
// posMath.js). Las rutas leen de la BD y le pasan aqui los datos ya leidos.
//
// Reglas (configurables en payroll_settings):
//   - Dia laboral = el empleado tiene horario ese dia de la semana. Sin
//     horario = descanso. Festivo oficial o del restaurante = descanso
//     obligatorio pagado.
//   - Asistencia: hay entrada ese dia (hora local de la sucursal). Los
//     minutos trabajados salen de pares entrada -> salida; la sesion cuenta en
//     el dia de la entrada (turnos nocturnos).
//   - Retardo: primera entrada despues de inicio + tolerancia. Descuento =
//     monto fijo + (opcional, salario diario) minutos tarde a la tarifa por
//     minuto. Justificado = sin descuento.
//   - Falta: dia laboral ya pasado sin entrada. No se paga y se descuenta el
//     monto fijo. Justificada = sin descuento; con goce = se paga el dia.
//   - Salario diario: se pagan los dias trabajados, festivos, faltas con goce
//     y (si pay_rest_days) los descansos. Por hora: los minutos trabajados.
//   - Horas extra: minutos trabajados por encima del turno en dias laborales,
//     en bloques completos. Por semana, las primeras N horas se pagan dobles
//     y el resto triples.
//   - Festivo trabajado / descanso trabajado: el pago del dia mas el factor
//     configurado del salario del dia. Prima dominical: % del salario del dia
//     si trabaja en domingo.
//   - Bonos de puntualidad (sin retardos) y asistencia (sin faltas), y ajustes
//     manuales (bonos, descuentos, abonos de prestamos).
import { toCents, fromCents } from '../posMath.js';
import { addDays, dayOfWeek, eachDay, lastDayOfMonth, localParts, timeToMinutes, minutesToTime, ymd } from './dates.js';

export const FREQUENCIES = ['semanal', 'quincenal', 'mensual'];
export const DOW_LABEL = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

/** Periodo de pago que contiene la fecha dada. */
export function periodRange(frequency, dateStr, weekStartDay = 1) {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (frequency === 'semanal') {
    const diff = (dayOfWeek(dateStr) - weekStartDay + 7) % 7;
    const start = addDays(dateStr, -diff);
    return { start, end: addDays(start, 6) };
  }
  if (frequency === 'quincenal') {
    return d <= 15
      ? { start: ymd(y, m, 1), end: ymd(y, m, 15) }
      : { start: ymd(y, m, 16), end: ymd(y, m, lastDayOfMonth(y, m)) };
  }
  if (frequency === 'mensual') return { start: ymd(y, m, 1), end: ymd(y, m, lastDayOfMonth(y, m)) };
  throw new Error(`Frecuencia desconocida: ${frequency}`);
}

/**
 * Sesiones de trabajo a partir de las checadas (ya sin anuladas). Una
 * entrada abre sesion; la siguiente salida la cierra. Una segunda entrada con
 * sesion abierta o una salida sin entrada se ignoran (y se marcan).
 * Regresa Map fecha -> { first_in, minutes, incomplete, sessions }.
 */
export function workSessions(entries, timeZone) {
  const sorted = [...entries].sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
  const byDate = new Map();
  const day = (date) => {
    if (!byDate.has(date)) byDate.set(date, { first_in: null, minutes: 0, incomplete: false, sessions: 0 });
    return byDate.get(date);
  };
  let open = null;
  for (const e of sorted) {
    if (e.kind === 'entrada') {
      if (open) { day(open.local.date).incomplete = true; continue; }
      const local = localParts(e.occurred_at, timeZone);
      open = { at: new Date(e.occurred_at), local };
      const d = day(local.date);
      if (d.first_in === null) d.first_in = local.minutes;
    } else if (open) {
      const d = day(open.local.date);
      d.minutes += Math.max(0, Math.floor((new Date(e.occurred_at) - open.at) / 60000));
      d.sessions += 1;
      open = null;
    }
  }
  if (open) day(open.local.date).incomplete = true;
  return byDate;
}

function justificationKey(date, kind) { return `${date}|${kind}`; }

/**
 * Analiza la asistencia dia por dia (sin dinero). La usan la nomina, el
 * reporte de asistencia y el empleado del mes.
 *   schedule: [{ day_of_week, start_time, end_time }]
 *   entries: [{ kind, occurred_at }] (sin anuladas)
 *   holidays: Map fecha -> nombre
 *   justifications: [{ date, kind, with_pay, note }]
 *   today: fecha local de hoy (los dias posteriores quedan "pendiente")
 */
export function analyzeAttendance({
  from, to, schedule = [], entries = [], holidays = new Map(), justifications = [],
  timeZone, toleranceMinutes = 0, hireDate = null, terminationDate = null, today = null, shiftDays = [],
}) {
  const byDow = new Map(schedule.map((s) => [Number(s.day_of_week), s]));
  // Rol por fecha (modulo turnos): manda sobre el horario fijo de ese dia.
  const roster = new Map(shiftDays.map((d) => [String(d.date).slice(0, 10), d]));
  const sessions = workSessions(entries, timeZone);
  const just = new Map(justifications.map((j) => [justificationKey(String(j.date).slice(0, 10), j.kind), j]));
  const days = [];
  for (const date of eachDay(from, to)) {
    const dow = dayOfWeek(date);
    const assigned = roster.get(date);
    const sched = assigned ? (assigned.is_rest ? null : assigned) : (byDow.get(dow) || null);
    const work = sessions.get(date) || null;
    const holidayName = holidays.get(date) || null;
    const day = {
      date,
      dow,
      type: holidayName ? 'festivo' : (sched ? 'laboral' : 'descanso'),
      holiday_name: holidayName,
      // Turno del rol (null = horario fijo).
      shift_name: assigned ? (assigned.is_rest ? 'Descanso' : assigned.shift_name || 'Turno asignado') : null,
      scheduled_start: sched ? minutesToTime(timeToMinutes(sched.start_time)) : null,
      scheduled_end: sched ? minutesToTime(timeToMinutes(sched.end_time)) : null,
      scheduled_minutes: 0,
      first_in: work?.first_in != null ? minutesToTime(work.first_in) : null,
      minutes_worked: work?.minutes || 0,
      incomplete: Boolean(work?.incomplete),
      worked: Boolean(work && work.first_in !== null),
      late_minutes: 0,
      tardy: false,
      tardy_justified: false,
      absence: false,
      absence_justified: false,
      absence_with_pay: false,
      overtime_minutes: 0,
      status: null,
      note: null,
    };
    if (sched) {
      const s = timeToMinutes(sched.start_time);
      let e = timeToMinutes(sched.end_time);
      if (e <= s) e += 24 * 60;
      day.scheduled_minutes = e - s;
    }
    if ((hireDate && date < hireDate) || (terminationDate && date > terminationDate)) {
      day.status = 'fuera_de_contrato';
      day.worked = false;
      day.minutes_worked = 0;
      days.push(day);
      continue;
    }
    if (today && date > today && !day.worked) {
      day.status = 'pendiente';
      days.push(day);
      continue;
    }
    if (day.type === 'laboral') {
      if (day.worked) {
        day.status = 'trabajado';
        const late = work.first_in - timeToMinutes(sched.start_time);
        if (late > toleranceMinutes) {
          day.late_minutes = late;
          day.tardy = true;
          const j = just.get(justificationKey(date, 'retardo'));
          if (j) { day.tardy_justified = true; day.note = j.note; }
        }
      } else {
        // Hoy todavia no es falta si el turno no ha terminado.
        const j = just.get(justificationKey(date, 'falta'));
        day.absence = true;
        day.status = 'falta';
        if (j) {
          day.absence_justified = true;
          day.absence_with_pay = Boolean(j.with_pay);
          day.status = 'falta_justificada';
          day.note = j.note;
        }
      }
    } else {
      day.status = day.worked ? 'trabajado' : day.type;
    }
    days.push(day);
  }
  return days;
}

/** Si el turno de hoy aun no termina, la "falta" de hoy queda pendiente. */
export function markOpenShiftsPending(days, today, nowMinutes) {
  for (const d of days) {
    if (d.date === today && d.status === 'falta' && !d.absence_justified && d.scheduled_end) {
      const s = timeToMinutes(d.scheduled_start);
      const e = timeToMinutes(d.scheduled_end);
      if (e <= s || nowMinutes < e) {
        d.status = 'pendiente';
        d.absence = false;
      }
    }
  }
  return days;
}

const sumBy = (list, fn) => list.reduce((s, x) => s + fn(x), 0);

/**
 * Ajustes manuales que tocan en el periodo. Para prestamos, appliedCents es
 * Map adjustment_id -> centavos ya descontados en OTROS periodos.
 * Regresa [{ adjustment_id, kind, concept, cents }].
 */
export function applicableAdjustments(adjustments, period, appliedCents = new Map()) {
  const out = [];
  for (const a of adjustments) {
    if (a.active === false) continue;
    const date = (v) => (v ? String(v).slice(0, 10) : null);
    let applies;
    if (a.recurrence === 'unico') {
      const d = date(a.apply_date);
      applies = d >= period.start && d <= period.end;
    } else {
      const s = date(a.start_date);
      const e = date(a.end_date);
      applies = s <= period.end && (!e || e >= period.start);
    }
    if (!applies) continue;
    let cents = toCents(a.amount);
    if (a.kind === 'prestamo') {
      const remaining = toCents(a.total_amount) - (appliedCents.get(a.id) || 0);
      cents = Math.min(cents, Math.max(0, remaining));
      if (cents <= 0) continue;
    }
    out.push({ adjustment_id: a.id, kind: a.kind, concept: a.concept, cents });
  }
  return out;
}

const ADJUSTMENT_LABEL = { bono: 'Bono', descuento: 'Descuento', prestamo: 'Abono a préstamo' };

/**
 * Nomina de un empleado en un periodo.
 *   employee: { pay_type, daily_salary, hourly_rate }
 *   settings: fila de payroll_settings
 *   days: resultado de analyzeAttendance
 *   adjustments: resultado de applicableAdjustments
 */
export function calculatePayroll({ employee, settings, days, adjustments = [], weekStartDay = 1 }) {
  const s = settings;
  const hourly = employee.pay_type === 'por_hora';
  const dailyC = toCents(employee.daily_salary);
  // Tarifa por hora en centavos (puede tener fraccion: se redondea al final de cada concepto).
  const rateC = hourly ? toCents(employee.hourly_rate) : dailyC / Number(s.daily_hours || 8);
  const valueOfMinutes = (min, factor = 1) => Math.round((rateC * min * factor) / 60);
  const dayValue = (d) => (hourly ? valueOfMinutes(d.minutes_worked) : dailyC);
  const block = Math.max(1, Number(s.overtime_block_minutes || 1));

  // Horas extra por dia laboral (bloques completos), repartidas por semana.
  for (const d of days) {
    if (s.overtime_enabled && d.type === 'laboral' && d.worked && d.minutes_worked > d.scheduled_minutes) {
      d.overtime_minutes = Math.floor((d.minutes_worked - d.scheduled_minutes) / block) * block;
    }
  }
  const doubleCap = Number(s.overtime_double_weekly_hours || 0) * 60;
  let otDouble = 0;
  let otTriple = 0;
  const usedByWeek = new Map();
  for (const d of days) {
    if (!d.overtime_minutes) continue;
    const week = periodRange('semanal', d.date, weekStartDay).start;
    const used = usedByWeek.get(week) || 0;
    const dbl = Math.min(d.overtime_minutes, Math.max(0, doubleCap - used));
    usedByWeek.set(week, used + dbl);
    d.overtime_double = dbl;
    d.overtime_triple = d.overtime_minutes - dbl;
    otDouble += dbl;
    otTriple += d.overtime_minutes - dbl;
  }

  const active = days.filter((d) => !['fuera_de_contrato', 'pendiente'].includes(d.status));
  const worked = active.filter((d) => d.worked);
  const holidaysAll = active.filter((d) => d.type === 'festivo');
  const holidaysWorked = holidaysAll.filter((d) => d.worked);
  const restWorked = active.filter((d) => d.type === 'descanso' && d.worked);
  const restPaid = active.filter((d) => d.type === 'descanso' && (s.pay_rest_days || d.worked));
  const laboralWorked = active.filter((d) => d.type === 'laboral' && d.worked);
  const paidAbsences = active.filter((d) => d.absence_with_pay);
  const absences = active.filter((d) => d.absence && !d.absence_justified);
  const justifiedAbsences = active.filter((d) => d.absence && d.absence_justified);
  const tardies = active.filter((d) => d.tardy && !d.tardy_justified);
  const minutesWorked = sumBy(worked, (d) => d.minutes_worked);

  const lines = [];
  const add = (kind, code, concept, cents, adjustmentId = null) => {
    if (cents > 0) lines.push({ kind, code, concept, cents: Math.round(cents), adjustment_id: adjustmentId });
  };

  // Sueldo base.
  let daysPaid = 0;
  if (hourly) {
    const regular = minutesWorked - otDouble - otTriple;
    add('percepcion', 'sueldo', `Sueldo: ${fmtHours(regular)} h`, valueOfMinutes(regular));
  } else {
    daysPaid = laboralWorked.length + holidaysAll.length + paidAbsences.length + restPaid.length;
    add('percepcion', 'sueldo', `Sueldo: ${daysPaid} día${daysPaid === 1 ? '' : 's'}`, dailyC * daysPaid);
  }
  add('percepcion', 'horas_extra_dobles', `Horas extra dobles: ${fmtHours(otDouble)} h`, valueOfMinutes(otDouble, Number(s.overtime_double_factor)));
  add('percepcion', 'horas_extra_triples', `Horas extra triples: ${fmtHours(otTriple)} h`, valueOfMinutes(otTriple, Number(s.overtime_triple_factor)));
  add('percepcion', 'festivo_trabajado', `Festivo trabajado: ${holidaysWorked.length}`,
    sumBy(holidaysWorked, (d) => Math.round(dayValue(d) * Number(s.holiday_worked_factor))));
  add('percepcion', 'descanso_trabajado', `Descanso trabajado: ${restWorked.length}`,
    sumBy(restWorked, (d) => Math.round(dayValue(d) * Number(s.rest_day_worked_factor))));
  const sundays = worked.filter((d) => d.dow === 0);
  add('percepcion', 'prima_dominical', `Prima dominical: ${sundays.length}`,
    sumBy(sundays, (d) => Math.round((dayValue(d) * Number(s.sunday_premium_pct)) / 100)));
  if (worked.length > 0 && tardies.length === 0) add('percepcion', 'bono_puntualidad', 'Bono de puntualidad', toCents(s.punctuality_bonus));
  if (worked.length > 0 && absences.length === 0) add('percepcion', 'bono_asistencia', 'Bono de asistencia', toCents(s.attendance_bonus));

  // Retardos: monto fijo + minutos tarde (solo salario diario: por hora no se pagan).
  const tardyCents = sumBy(tardies, (d) => toCents(s.tardiness_penalty)
    + (!hourly && s.tardiness_proportional ? valueOfMinutes(d.late_minutes) : 0));
  add('deduccion', 'retardos', `Retardos: ${tardies.length} (${sumBy(tardies, (d) => d.late_minutes)} min)`, tardyCents);
  add('deduccion', 'faltas', `Faltas: ${absences.length}`, absences.length * toCents(s.absence_penalty));

  for (const a of adjustments) {
    add(a.kind === 'bono' ? 'percepcion' : 'deduccion', a.kind, `${ADJUSTMENT_LABEL[a.kind]}: ${a.concept}`, a.cents, a.adjustment_id);
  }

  const gross = sumBy(lines.filter((l) => l.kind === 'percepcion'), (l) => l.cents);
  const deductions = sumBy(lines.filter((l) => l.kind === 'deduccion'), (l) => l.cents);
  const net = Math.max(0, gross - deductions);

  return {
    days_scheduled: active.filter((d) => d.type === 'laboral').length,
    days_worked: worked.length,
    days_paid: daysPaid,
    rest_days_paid: hourly ? 0 : restPaid.length,
    holidays: holidaysAll.length,
    holidays_worked: holidaysWorked.length,
    absences: absences.length,
    absences_justified: justifiedAbsences.length,
    tardies: tardies.length,
    tardy_minutes: sumBy(tardies, (d) => d.late_minutes),
    minutes_worked: minutesWorked,
    overtime_minutes_double: otDouble,
    overtime_minutes_triple: otTriple,
    lines: lines.map((l) => ({ ...l, amount: fromCents(l.cents) })),
    gross: fromCents(gross),
    deductions: fromCents(deductions),
    net: fromCents(net),
    // Lo que no se pudo descontar porque las deducciones superan las percepciones.
    uncollected: fromCents(Math.max(0, deductions - gross)),
    days,
  };
}

function fmtHours(min) {
  const h = min / 60;
  return Number.isInteger(h) ? String(h) : h.toFixed(2);
}
