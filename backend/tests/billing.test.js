import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateMonthlyTotal, effectivePriceCents, isModuleActive } from '../services/billing.js';

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
