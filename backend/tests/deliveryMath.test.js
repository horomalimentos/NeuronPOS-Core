// Fase 5, pruebas unitarias: estados del reparto, comision de la flota,
// corte del repartidor y liquidacion a restaurantes (centavos explicitos).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertTransition, canTransition } from '../services/delivery/flow.js';
import { readLocation } from '../services/delivery/location.js';
import {
  commissionAmount, commissionCents, driverCut, settlementPlan,
} from '../services/delivery/math.js';

describe('estados del reparto', () => {
  test('flujo valido: asignado -> recogido -> en_camino -> entregado', () => {
    assert.ok(canTransition('solicitado', 'asignado'));
    assert.ok(canTransition('asignado', 'recogido'));
    assert.ok(canTransition('recogido', 'en_camino'));
    assert.ok(canTransition('en_camino', 'entregado'));
    assert.ok(canTransition('recogido', 'fallido'));
    assert.ok(canTransition('en_camino', 'fallido'));
    assert.ok(canTransition('asignado', 'cancelado'));
    assert.ok(canTransition('solicitado', 'cancelado'));
  });

  test('saltos y regresos no permitidos', () => {
    const invalid = [
      ['asignado', 'entregado'], ['asignado', 'en_camino'], ['recogido', 'entregado'], ['en_camino', 'recogido'],
      ['entregado', 'fallido'], ['fallido', 'en_camino'], ['cancelado', 'asignado'], ['en_camino', 'cancelado'],
      ['solicitado', 'recogido'], ['entregado', 'entregado'],
    ];
    for (const [from, to] of invalid) {
      assert.equal(canTransition(from, to), false, `${from} -> ${to}`);
      assert.throws(() => assertTransition(from, to), (e) => e.status === 409 && e.code === 'INVALID_TRANSITION');
    }
    assert.throws(() => assertTransition('asignado', 'perdido'), (e) => e.status === 400 && e.code === 'INVALID_STATUS');
  });
});

describe('comision de la flota', () => {
  test('fija: el monto tal cual, sin importar el subtotal', () => {
    assert.equal(commissionCents({ type: 'fixed', value: 35 }, 1000), 3500);
    assert.equal(commissionCents({ type: 'fixed', value: '12.50' }, 0), 1250);
    assert.equal(commissionCents({ type: 'fixed', value: 0 }, 500), 0);
  });

  test('porcentaje del subtotal redondeado al centavo', () => {
    assert.equal(commissionCents({ type: 'percent', value: 10 }, 345), 3450);
    // 12.5 % de 99.99 = 12.49875 -> 12.50
    assert.equal(commissionCents({ type: 'percent', value: 12.5 }, 99.99), 1250);
    // 7.25 % de 133.33 = 9.6664... -> 9.67
    assert.equal(commissionAmount({ type: 'percent', value: '7.25' }, '133.33'), 9.67);
    // 15 % de 0.10 = 0.015 -> 0.02 (mitad hacia arriba)
    assert.equal(commissionCents({ type: 'percent', value: 15 }, 0.1), 2);
    assert.equal(commissionCents({ type: 'percent', value: 100 }, 250), 25000);
  });
});

describe('corte del repartidor', () => {
  test('esperado = cobros + propinas; diferencia = contado - esperado', () => {
    const payments = [
      { order_id: 'a', amount: '245.50', tip: '10.00' },
      { order_id: 'b', amount: '99.99', tip: 0 },
      { order_id: 'b', amount: '0.01', tip: 0 },
    ];
    assert.deepEqual(driverCut(payments), { expected_cash: 355.5, deliveries_count: 2 });
    const cut = driverCut(payments, 350);
    assert.equal(cut.counted_cash, 350);
    assert.equal(cut.difference, -5.5);
    assert.equal(driverCut(payments, '355.60').difference, 0.1);
  });
});

describe('liquidacion de la flota', () => {
  test('efectivo menos comisiones que caben (las mas viejas primero)', () => {
    const plan = settlementPlan(
      [{ id: 'r1', cash_collected: '300.00' }, { id: 'r2', cash_collected: '0.10' }, { id: 'r3', cash_collected: 0 }],
      [{ id: 'r1', commission_amount: '30.00' }, { id: 'r4', commission_amount: '270.05' }, { id: 'r5', commission_amount: '0.05' }],
    );
    // 300.10 de efectivo: 30.00 cabe, 270.05 tambien (300.05) y 0.05 justo completa 300.10.
    assert.equal(plan.cash_amount, 300.1);
    assert.equal(plan.commission_amount, 300.1);
    assert.equal(plan.net_amount, 0);
    assert.deepEqual(plan.cash_ids, ['r1', 'r2']);
    assert.deepEqual(plan.commission_ids, ['r1', 'r4', 'r5']);
  });

  test('una comision que no cabe se queda para la factura (nunca neto negativo)', () => {
    const plan = settlementPlan([{ id: 'r1', cash_collected: 50 }], [
      { id: 'x', commission_amount: 20 }, { id: 'y', commission_amount: 40 }, { id: 'z', commission_amount: 5 },
    ]);
    assert.equal(plan.commission_amount, 20);
    assert.equal(plan.net_amount, 30);
    assert.deepEqual(plan.commission_ids, ['x']);
    const empty = settlementPlan([], [{ id: 'x', commission_amount: 20 }]);
    assert.deepEqual([empty.cash_amount, empty.commission_amount, empty.net_amount], [0, 0, 0]);
    assert.deepEqual(empty.commission_ids, []);
  });
});

describe('ubicacion del repartidor', () => {
  test('valida coordenadas y redondea a 6 decimales', () => {
    assert.deepEqual(readLocation({ latitude: 31.7200001234, longitude: '-106.4245', accuracy: 12.34 }),
      { latitude: 31.72, longitude: -106.4245, accuracy: 12.3 });
    for (const bad of [{}, { latitude: null, longitude: 0 }, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: 'x' },
      { latitude: true, longitude: 1 }]) {
      assert.throws(() => readLocation(bad), (e) => e.code === 'INVALID_LOCATION');
    }
  });
});
