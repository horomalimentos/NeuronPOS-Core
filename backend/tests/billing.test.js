import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, billingPeriod, buildInvoiceLines, calculateMonthlyTotal, effectiveBillingDay, effectivePriceCents,
  isModuleActive, localDate, suspensionDate,
} from '../services/billing.js';

const now = new Date('2026-10-15T12:00:00Z');
const row = (o) => ({
  module_code: 'pos', name: 'Punto de venta', monthly_price_mxn: '500.00', custom_price_mxn: null,
  discount_pct: '0', enabled: true, started_at: null, ends_at: null, ...o,
});

test('precio efectivo: catalogo, precio personalizado y descuento', () => {
  assert.equal(effectivePriceCents(row({})), 50000);
  assert.equal(effectivePriceCents(row({ custom_price_mxn: '350.50' })), 35050);
  assert.equal(effectivePriceCents(row({ custom_price_mxn: '0' })), 0, 'precio personalizado 0 = cortesia');
  assert.equal(effectivePriceCents(row({ discount_pct: '10' })), 45000);
  assert.equal(effectivePriceCents(row({ custom_price_mxn: '99.99', discount_pct: '33.33' })), 6666);
  assert.equal(effectivePriceCents(row({ discount_pct: '150' })), 0, 'descuento se limita a 100%');
});

test('modulo activo segun enabled y fechas', () => {
  assert.equal(isModuleActive(row({}), now), true);
  assert.equal(isModuleActive(row({ enabled: false }), now), false);
  assert.equal(isModuleActive(row({ ends_at: '2026-10-01T00:00:00Z' }), now), false);
  assert.equal(isModuleActive(row({ ends_at: '2026-11-01T00:00:00Z' }), now), true);
  assert.equal(isModuleActive(row({ started_at: '2026-11-01T00:00:00Z' }), now), false);
  assert.equal(isModuleActive(null, now), false);
});

test('total mensual suma solo modulos contratados y vigentes', () => {
  const rows = [
    row({}),                                                                          // 500
    row({ module_code: 'landing', monthly_price_mxn: '300', custom_price_mxn: '250', discount_pct: '10' }), // 225
    row({ module_code: 'rh', monthly_price_mxn: '800', enabled: false }),             // no cuenta
    row({ module_code: 'portal', monthly_price_mxn: '400', ends_at: '2026-09-30T00:00:00Z' }), // vencido
    row({ module_code: 'empleado_mes', monthly_price_mxn: '0.10' }),                  // 0.10
    row({ module_code: 'domicilios', monthly_price_mxn: '0.20' }),                    // 0.20
  ];
  const result = calculateMonthlyTotal(rows, now);
  assert.equal(result.total_mxn, 725.3, 'sin errores de punto flotante (0.1 + 0.2)');
  assert.deepEqual(result.lines.map((l) => l.module_code), ['pos', 'landing', 'empleado_mes', 'domicilios']);
  const landing = result.lines.find((l) => l.module_code === 'landing');
  assert.deepEqual(
    { catalog: landing.catalog_price_mxn, custom: landing.custom_price_mxn, amount: landing.amount_mxn },
    { catalog: 300, custom: 250, amount: 225 },
  );
});

test('total mensual vacio', () => {
  assert.deepEqual(calculateMonthlyTotal([], now), { total_mxn: 0, lines: [] });
  assert.deepEqual(calculateMonthlyTotal(undefined, now), { total_mxn: 0, lines: [] });
});

// ---------------------------------------------------------------------------
// Facturas de suscripcion (fase 3)
// ---------------------------------------------------------------------------

test('lineas de factura: precio especial, descuento y totales que cuadran en centavos', () => {
  const bill = buildInvoiceLines([
    row({}),                                                                            // 500
    row({ module_code: 'landing', name: 'Sitio', monthly_price_mxn: '300', custom_price_mxn: '250', discount_pct: '10' }),
    row({ module_code: 'portal', monthly_price_mxn: '99.99', discount_pct: '33.33' }),  // 99.99 - 33.33 = 66.66
    row({ module_code: 'rh', monthly_price_mxn: '800', enabled: false }),
    row({ module_code: 'domicilios', monthly_price_mxn: '100', custom_price_mxn: '0' }), // cortesia
  ], now);
  assert.deepEqual(bill.lines.map((l) => l.module_code), ['pos', 'landing', 'portal', 'domicilios']);
  const landing = bill.lines[1];
  assert.deepEqual(
    [landing.catalog_price_mxn, landing.custom_price_mxn, landing.unit_price_mxn, landing.discount_mxn, landing.amount_mxn],
    [300, 250, 250, 25, 225],
  );
  assert.deepEqual([bill.lines[2].unit_price_mxn, bill.lines[2].discount_mxn, bill.lines[2].amount_mxn], [99.99, 33.33, 66.66]);
  assert.equal(bill.lines[3].amount_mxn, 0);
  assert.equal(bill.subtotal_mxn, 849.99);
  assert.equal(bill.discount_mxn, 58.33);
  assert.equal(bill.total_mxn, 791.66);
  for (const l of bill.lines) assert.equal(Math.round(l.unit_price_mxn * 100) - Math.round(l.discount_mxn * 100), Math.round(l.amount_mxn * 100));
  // Mismo total que la mensualidad de la fase 1.
  assert.equal(calculateMonthlyTotal([row({}), row({ module_code: 'x', custom_price_mxn: '250', discount_pct: '10' })], now).total_mxn,
    buildInvoiceLines([row({}), row({ module_code: 'x', custom_price_mxn: '250', discount_pct: '10' })], now).total_mxn);
});

test('periodo de cobro segun el dia de cobro', () => {
  assert.deepEqual(billingPeriod('2026-10-15', 5), { start: '2026-10-05', end: '2026-11-04', next: '2026-11-05' });
  assert.deepEqual(billingPeriod('2026-10-05', 5), { start: '2026-10-05', end: '2026-11-04', next: '2026-11-05' });
  assert.deepEqual(billingPeriod('2026-10-04', 5), { start: '2026-09-05', end: '2026-10-04', next: '2026-10-05' });
  assert.deepEqual(billingPeriod('2026-01-02', 15), { start: '2025-12-15', end: '2026-01-14', next: '2026-01-15' });
  // Dia 31: en meses cortos se cobra el ultimo dia.
  assert.deepEqual(billingPeriod('2026-02-28', 31), { start: '2026-02-28', end: '2026-03-30', next: '2026-03-31' });
  assert.deepEqual(billingPeriod('2026-02-27', 31), { start: '2026-01-31', end: '2026-02-27', next: '2026-02-28' });
  assert.deepEqual(billingPeriod('2028-02-29', 30), { start: '2028-02-29', end: '2028-03-29', next: '2028-03-30' });
  assert.deepEqual(billingPeriod('2026-12-20', 1), { start: '2026-12-01', end: '2026-12-31', next: '2027-01-01' });
});

test('dia de cobro: el configurado o el dia en que se activo (zona de cobro)', () => {
  assert.equal(effectiveBillingDay({ billing_day: 10, activated_at: '2026-10-20T12:00:00Z' }, 'America/Mexico_City'), 10);
  assert.equal(effectiveBillingDay({ billing_day: null, activated_at: '2026-10-20T12:00:00Z' }, 'America/Mexico_City'), 20);
  // 02:00 UTC del 21 todavia es el 20 en Ciudad de Mexico.
  assert.equal(effectiveBillingDay({ activated_at: '2026-10-21T02:00:00Z' }, 'America/Mexico_City'), 20);
  assert.equal(localDate('2026-10-21T02:00:00Z', 'America/Mexico_City'), '2026-10-20');
});

test('suspension: fecha limite + dias de gracia', () => {
  assert.equal(addDays('2026-10-28', 5), '2026-11-02');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(suspensionDate('2026-10-05', 5), '2026-10-11', 'con 5 dias de gracia el 10 aun hay servicio');
  assert.equal(suspensionDate('2026-10-05', 0), '2026-10-06');
});
