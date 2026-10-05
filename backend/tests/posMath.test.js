// Calculos del POS: totales con descuento e impuesto, pagos (cambio y
// propina) y corte de caja.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCashCut, calculateOrderTotals, discountPercentOf, normalizePayments,
} from '../services/posMath.js';

const items = [
  { unit_price: '100.00', modifiers_total: '15.00', quantity: 2 }, // 230
  { unit_price: '50.00', modifiers_total: '0', quantity: 1 }, // 50
];

test('totales: precios con IVA incluido (se desglosa)', () => {
  const t = calculateOrderTotals(items, { taxRatePct: 16, pricesIncludeTax: true });
  assert.deepEqual(t, { subtotal: 280, discount_amount: 0, tax_amount: 38.62, delivery_fee: 0, total: 280 });
});

test('totales: IVA encima del subtotal', () => {
  const t = calculateOrderTotals(items, { taxRatePct: 16, pricesIncludeTax: false });
  assert.deepEqual(t, { subtotal: 280, discount_amount: 0, tax_amount: 44.8, delivery_fee: 0, total: 324.8 });
});

test('totales: descuento porcentual y por monto', () => {
  const pct = calculateOrderTotals(items, { discount: { type: 'percent', value: 10 }, taxRatePct: 16, pricesIncludeTax: true });
  assert.deepEqual(pct, { subtotal: 280, discount_amount: 28, tax_amount: 34.76, delivery_fee: 0, total: 252 });
  const amt = calculateOrderTotals(items, { discount: { type: 'amount', value: 30 }, taxRatePct: 16, pricesIncludeTax: false });
  assert.deepEqual(amt, { subtotal: 280, discount_amount: 30, tax_amount: 40, delivery_fee: 0, total: 290 });
});

test('totales: costo de envio se suma al final, sin descuento ni IVA', () => {
  const t = calculateOrderTotals(items, {
    discount: { type: 'percent', value: 10 }, taxRatePct: 16, pricesIncludeTax: false, deliveryFee: '35.50',
  });
  assert.deepEqual(t, { subtotal: 280, discount_amount: 28, tax_amount: 40.32, delivery_fee: 35.5, total: 327.82 });
});

test('totales: el descuento nunca excede el subtotal y los cancelados no cuentan', () => {
  const t = calculateOrderTotals([...items, { unit_price: 999, quantity: 1, voided: true }], {
    discount: { type: 'amount', value: 1000 }, taxRatePct: 16,
  });
  assert.deepEqual(t, { subtotal: 280, discount_amount: 280, tax_amount: 0, delivery_fee: 0, total: 0 });
  assert.equal(calculateOrderTotals([], {}).total, 0);
});

test('totales: redondeo en centavos (sin errores de punto flotante)', () => {
  const t = calculateOrderTotals([{ unit_price: 0.1, quantity: 3 }, { unit_price: 0.2, quantity: 1 }], { taxRatePct: 0 });
  assert.equal(t.total, 0.5);
  const p = calculateOrderTotals([{ unit_price: 33.33, quantity: 1 }], { discount: { type: 'percent', value: 33.33 }, taxRatePct: 16, pricesIncludeTax: false });
  assert.equal(p.discount_amount, 11.11);
  assert.equal(p.tax_amount, 3.56); // 22.22 * 0.16 = 3.5552
  assert.equal(p.total, 25.78);
});

test('porcentaje de descuento (limite del cajero)', () => {
  assert.equal(discountPercentOf(200, { type: 'amount', value: 20 }), 10);
  assert.equal(discountPercentOf(200, { type: 'percent', value: 15 }), 15);
  assert.equal(discountPercentOf(0, { type: 'percent', value: 15 }), 0);
});

test('pagos: efectivo con cambio y propina, tarjeta exacta', () => {
  const r = normalizePayments([
    { kind: 'tarjeta', amount: 100, tip: 15 },
    { kind: 'efectivo', amount: 150, tip: 10, received: 200 },
  ], 250);
  assert.equal(r.applied, 250);
  assert.equal(r.change, 40);
  assert.equal(r.remaining_after, 0);
  assert.deepEqual(r.lines[0], { amount: 100, tip: 15, received: 115, change_given: 0 });
  assert.deepEqual(r.lines[1], { amount: 150, tip: 10, received: 200, change_given: 40 });
});

test('pagos: parciales, sobrepago y reglas de cambio', () => {
  assert.equal(normalizePayments([{ kind: 'efectivo', amount: 50 }], 120).remaining_after, 70);
  assert.throws(() => normalizePayments([{ kind: 'tarjeta', amount: 130 }], 120), { code: 'OVERPAYMENT' });
  assert.throws(() => normalizePayments([{ kind: 'efectivo', amount: 100, received: 90 }], 120), { code: 'INSUFFICIENT_CASH' });
  assert.throws(() => normalizePayments([{ kind: 'tarjeta', amount: 100, received: 150 }], 120), { code: 'CHANGE_NOT_ALLOWED' });
  assert.throws(() => normalizePayments([{ kind: 'tarjeta', amount: 0 }], 120), { code: 'INVALID_PAYMENT' });
});

test('corte de caja: esperado por metodo, fondo, movimientos y diferencias', () => {
  const methods = [
    { id: 'cash', name: 'Efectivo', kind: 'efectivo' },
    { id: 'card', name: 'Tarjeta', kind: 'tarjeta' },
    { id: 'transfer', name: 'Transferencia', kind: 'transferencia' },
  ];
  const payments = [
    { payment_method_id: 'cash', amount: '150.00', tip: '10.00' },
    { payment_method_id: 'cash', amount: '80.50', tip: '0' },
    { payment_method_id: 'card', amount: '100.00', tip: '15.00' },
  ];
  const movements = [{ kind: 'entrada', amount: '100' }, { kind: 'salida', amount: '45.25' }];
  const live = calculateCashCut({ methods, payments, movements, openingCash: '500' });
  assert.equal(live.total_sales, 330.5);
  assert.equal(live.total_tips, 25);
  assert.equal(live.expected_cash, 795.25); // 500 + 150 + 10 + 80.5 + 100 - 45.25
  assert.deepEqual(live.methods.map((m) => m.expected), [795.25, 115, 0]);
  assert.equal(live.counted_cash, undefined);

  const closed = calculateCashCut({
    methods, payments, movements, openingCash: '500', counts: { cash: 790, card: 115, transfer: 0 },
  });
  assert.equal(closed.counted_cash, 790);
  assert.equal(closed.cash_difference, -5.25);
  assert.deepEqual(closed.methods.map((m) => m.difference), [-5.25, 0, 0]);
  assert.equal(closed.total_difference, -5.25);
});
