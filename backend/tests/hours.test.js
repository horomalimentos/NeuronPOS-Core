// Horarios de sucursal (funciones puras): abierto/cerrado con horario
// normal, nocturno, 24 horas, dias cerrados y zona horaria.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchOpenState, isOpenAt, localParts, normalizeWeek } from '../services/hours.js';

// Lunes 2026-10-05.
const at = (hhmm, { dow = 1, date = '2026-10-05' } = {}) => {
  const [h, m] = hhmm.split(':').map(Number);
  return { dow, minutes: h * 60 + m, date };
};

test('horario normal: abre a la hora de apertura y cierra a la de cierre', () => {
  const hours = [{ weekday: 1, opens_at: '09:00', closes_at: '22:00' }];
  assert.equal(isOpenAt(hours, [], at('08:59')).open, false);
  assert.deepEqual(isOpenAt(hours, [], at('09:00')), { open: true, closes_at: '22:00' });
  assert.equal(isOpenAt(hours, [], at('21:59')).open, true);
  assert.equal(isOpenAt(hours, [], at('22:00')).open, false);
  assert.equal(isOpenAt(hours, [], at('12:00', { dow: 2, date: '2026-10-06' })).open, false, 'sin horario ese dia = cerrado');
});

test('horario nocturno: la madrugada cuenta como parte del dia anterior', () => {
  const hours = [{ weekday: 5, opens_at: '18:00:00', closes_at: '02:00:00' }]; // viernes
  const fri = { dow: 5, date: '2026-10-09' };
  const sat = { dow: 6, date: '2026-10-10' };
  assert.equal(isOpenAt(hours, [], at('17:59', fri)).open, false);
  assert.equal(isOpenAt(hours, [], at('23:30', fri)).open, true);
  assert.deepEqual(isOpenAt(hours, [], at('01:59', sat)), { open: true, closes_at: '02:00' });
  assert.equal(isOpenAt(hours, [], at('02:00', sat)).open, false);
  assert.equal(isOpenAt(hours, ['2026-10-09'], at('01:00', sat)).open, false, 'si el viernes cerro, la madrugada tambien');
});

test('24 horas y dias cerrados', () => {
  const hours = [{ weekday: 1, opens_at: '00:00', closes_at: '00:00' }];
  assert.equal(isOpenAt(hours, [], at('03:00')).open, true);
  assert.equal(isOpenAt(hours, ['2026-10-05'], at('03:00')).open, false);
});

test('fecha y hora local segun la zona horaria de la sucursal', () => {
  const instant = new Date('2026-10-05T05:30:00Z'); // 23:30 del domingo en Cd. Juarez (UTC-6)
  assert.deepEqual(localParts(instant, 'America/Ciudad_Juarez'), { dow: 0, minutes: 23 * 60 + 30, date: '2026-10-04' });
  assert.deepEqual(localParts(instant, 'UTC'), { dow: 1, minutes: 5 * 60 + 30, date: '2026-10-05' });
  const state = branchOpenState({
    hours: [{ weekday: 0, opens_at: '12:00', closes_at: '23:45' }], closures: [], timezone: 'America/Ciudad_Juarez',
  }, instant);
  assert.equal(state.open, true);
  assert.deepEqual(state.today, { opens_at: '12:00', closes_at: '23:45' });
});

test('normalizeWeek valida dias y horas', () => {
  assert.deepEqual(normalizeWeek([{ weekday: 2, opens_at: '9:00', closes_at: '18:30' }]), [
    { weekday: 2, opens_at: '09:00', closes_at: '18:30' },
  ]);
  assert.throws(() => normalizeWeek([{ weekday: 7, opens_at: '09:00', closes_at: '10:00' }]), /Dia/);
  assert.throws(() => normalizeWeek([{ weekday: 1, opens_at: '25:00', closes_at: '10:00' }]), /Hora invalida/);
  assert.throws(() => normalizeWeek([
    { weekday: 1, opens_at: '09:00', closes_at: '10:00' }, { weekday: 1, opens_at: '11:00', closes_at: '12:00' },
  ]), /repetido/);
});
