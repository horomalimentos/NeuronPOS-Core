// Puntaje del empleado del mes: pesos, componentes que no aplican, ganador
// por sucursal y desempate determinista.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRanking } from '../services/rh/recognitionMath.js';

const W = { attendance: 30, punctuality: 20, sales: 20, evaluation: 20, tasks: 10 };

test('puntaje ponderado con explicacion de cada componente', () => {
  const employees = [
    { id: 'a', full_name: 'Ana', branch_id: 'b1', user_role: 'mesero' },
    { id: 'b', full_name: 'Beto', branch_id: 'b1', user_role: 'cajero' },
    { id: 'c', full_name: 'Carla', branch_id: 'b1', user_role: null },
  ];
  const rows = computeRanking({
    employees,
    weights: W,
    data: {
      attendance: new Map([
        ['a', { scheduled: 6, present: 6, worked: 6, tardies: 0 }],
        ['b', { scheduled: 6, present: 6, worked: 6, tardies: 2 }],
        ['c', { scheduled: 6, present: 5, worked: 5, tardies: 0 }],
      ]),
      sales: new Map([['a', 100000], ['b', 50000]]),
      evaluations: new Map([['a', 80], ['b', 90], ['c', 100]]),
      tasks: new Map([['a', 10], ['b', 20]]),
    },
  });
  assert.deepEqual(rows.map((r) => [r.employee_name, r.rank, r.score, r.is_winner]), [
    ['Ana', 1, 91, true], ['Beto', 2, 81.33, false], ['Carla', 3, 81.25, false],
  ]);
  // Carla no vende (sin usuario de mesero/cajero): el peso de ventas no le cuenta.
  assert.equal(rows[2].components.sales, null);
  assert.deepEqual(rows[1].components, { attendance: 100, punctuality: 66.67, sales: 50, evaluation: 90, tasks: 100 });
});

test('sin rh ni pos solo cuentan evaluacion y tareas', () => {
  const rows = computeRanking({
    employees: [{ id: 'x', full_name: 'X', branch_id: 'b1', user_role: 'mesero' }],
    weights: W,
    data: { attendance: null, sales: null, evaluations: new Map([['x', 70]]), tasks: new Map() },
  });
  // (20 x 70 + 10 x 0) / 30
  assert.equal(rows[0].score, 46.67);
  assert.equal(rows[0].components.attendance, null);
  assert.equal(rows[0].days_worked, null);
});

test('empates: asistencia, puntualidad, nombre y id; mismo resultado sin importar el orden de entrada', () => {
  const employees = [
    { id: '3', full_name: 'Zoe', branch_id: 'b1' },
    { id: '2', full_name: 'Alma', branch_id: 'b1' },
    { id: '1', full_name: 'Alma', branch_id: 'b1' },
    { id: '4', full_name: 'Beto', branch_id: 'b2' },
  ];
  const data = {
    attendance: null, sales: null,
    evaluations: new Map([['1', 90], ['2', 90], ['3', 90], ['4', 50]]),
    tasks: new Map(),
  };
  const weights = { evaluation: 1 };
  const a = computeRanking({ employees, data, weights });
  const b = computeRanking({ employees: [...employees].reverse(), data, weights });
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((r) => [r.branch_id, r.employee_id, r.rank, r.is_winner]), [
    ['b1', '1', 1, true], ['b1', '2', 2, false], ['b1', '3', 3, false], ['b2', '4', 1, true],
  ]);
});

test('minimo de dias trabajados y puntaje cero no ganan', () => {
  const rows = computeRanking({
    employees: [
      { id: 'a', full_name: 'Ana', branch_id: 'b1' },
      { id: 'b', full_name: 'Beto', branch_id: 'b1' },
      { id: 'c', full_name: 'Ciro', branch_id: 'b2' },
    ],
    weights: { attendance: 1, evaluation: 1 },
    minDaysWorked: 10,
    data: {
      attendance: new Map([['a', { scheduled: 4, present: 4, worked: 4, tardies: 0 }], ['b', { scheduled: 20, present: 15, worked: 15, tardies: 0 }]]),
      sales: null,
      evaluations: new Map([['a', 100], ['b', 50]]),
      tasks: new Map(),
    },
  });
  assert.deepEqual(rows.map((r) => [r.employee_name, r.rank, r.score, r.is_winner]), [
    ['Ana', 1, 100, false], ['Beto', 2, 62.5, true], ['Ciro', 1, 0, false],
  ]);
});
