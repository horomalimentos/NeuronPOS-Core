// Motor de promociones (funciones puras, sin base de datos).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { computePromotions, isPromotionActive } from '../services/promotions.js';

const promo = (over) => ({
  id: over.id || 'p1', name: over.name || 'Promo', active: true, applies_pos: true, applies_web: true,
  item_ids: [], category_ids: [], branch_ids: [], days_of_week: [], same_modifiers: false, min_amount: 0, priority: 0, ...over,
});
const line = (menu_item_id, pesos, quantity, extra = {}) => ({ menu_item_id, category_id: 'tacos', unit_cents: pesos * 100, quantity, ...extra });
const total = (r) => r.reduce((s, x) => s + x.cents, 0) / 100;

describe('promociones', () => {
  test('2x1 regala la pieza mas barata de cada par', () => {
    const p = promo({ kind: 'nxm', buy_quantity: 2, pay_quantity: 1, item_ids: ['pastor', 'asada'] });
    assert.equal(total(computePromotions([p], [line('pastor', 85, 1), line('asada', 95, 1)])), 85);
    assert.equal(total(computePromotions([p], [line('pastor', 85, 3)])), 85, 'la tercera se paga');
    assert.equal(total(computePromotions([p], [line('pastor', 85, 4)])), 170);
    assert.equal(total(computePromotions([p], [line('refresco', 30, 4)])), 0, 'otro producto no cuenta');
  });

  test('3x2 por categoria', () => {
    const p = promo({ kind: 'nxm', buy_quantity: 3, pay_quantity: 2, category_ids: ['tacos'] });
    assert.equal(total(computePromotions([p], [line('a', 100, 1), line('b', 90, 1), line('c', 80, 1)])), 80);
  });

  test('paquete: 3 piezas por $200; con piezas identicas si se pide', () => {
    const p = promo({ kind: 'paquete', buy_quantity: 3, bundle_price: 200, item_ids: ['pastor'] });
    assert.equal(total(computePromotions([p], [line('pastor', 85, 3)])), 55);
    assert.equal(total(computePromotions([p], [line('pastor', 85, 2)])), 0);
    const same = promo({ ...p, same_modifiers: true });
    assert.equal(total(computePromotions([same], [line('pastor', 85, 2, { mods_key: 'v' }), line('pastor', 85, 1, { mods_key: 'r' })])), 0);
    assert.equal(total(computePromotions([same], [line('pastor', 85, 3, { mods_key: 'v' })])), 55);
  });

  test('porcentaje en productos y en toda la cuenta; monto con minimo', () => {
    const bebidas = promo({ id: 'b', kind: 'porcentaje', percent: 50, item_ids: ['agua'] });
    const cuenta = promo({ id: 'c', kind: 'porcentaje', percent: 10 });
    const r = computePromotions([bebidas, cuenta], [line('agua', 40, 2), line('taco', 100, 2)]);
    // 50% de 80 = 40; luego 10% de lo que queda (280 - 40 = 240) = 24
    assert.deepEqual(r.map((x) => [x.promotion_id, x.cents]), [['b', 4000], ['c', 2400]]);
    const monto = promo({ kind: 'monto', amount: 50, min_amount: 300 });
    assert.equal(total(computePromotions([monto], [line('taco', 100, 2)])), 0, 'no llega al minimo');
    assert.equal(total(computePromotions([monto], [line('taco', 100, 3)])), 50);
    assert.equal(total(computePromotions([promo({ kind: 'monto', amount: 500 })], [line('taco', 100, 1)])), 100, 'nunca mas que el subtotal');
  });

  test('una pieza no recibe dos descuentos de producto; manda la prioridad', () => {
    const dosx1 = promo({ id: 'nxm', kind: 'nxm', buy_quantity: 2, pay_quantity: 1, item_ids: ['taco'], priority: 1 });
    const mitad = promo({ id: 'pct', kind: 'porcentaje', percent: 50, item_ids: ['taco'], priority: 2 });
    const r = computePromotions([mitad, dosx1], [line('taco', 100, 3)]);
    // 2x1 usa dos tacos (regala 100); el tercero lleva 50%.
    assert.deepEqual(r.map((x) => [x.promotion_id, x.cents]), [['nxm', 10000], ['pct', 5000]]);
  });

  test('regalo: por cada 2 tacos, un refresco gratis si viene en la orden', () => {
    const p = promo({ kind: 'regalo', buy_quantity: 2, item_ids: ['taco'], reward_item_id: 'refresco', reward_quantity: 1 });
    assert.equal(total(computePromotions([p], [line('taco', 90, 4), line('refresco', 30, 3)])), 60);
    assert.equal(total(computePromotions([p], [line('taco', 90, 1), line('refresco', 30, 1)])), 0);
  });

  test('vigencia: canal, sucursal, fechas, dias y horario (incluye cruzar medianoche)', () => {
    const when = { date: '2026-10-09', dow: 5, minutes: 14 * 60 };
    const ok = (over, w = when, extra = {}) => isPromotionActive(promo({ kind: 'monto', amount: 1, ...over }), { when: w, branchId: 'b1', source: 'pos', ...extra });
    assert.equal(ok({}), true);
    assert.equal(ok({ active: false }), false);
    assert.equal(ok({ applies_pos: false }), false);
    assert.equal(ok({ applies_pos: false }, when, { source: 'web' }), true);
    assert.equal(ok({ branch_ids: ['b2'] }), false);
    assert.equal(ok({ starts_on: '2026-10-10' }), false);
    assert.equal(ok({ ends_on: '2026-10-08' }), false);
    assert.equal(ok({ days_of_week: [1, 2] }), false);
    assert.equal(ok({ days_of_week: [5] }), true);
    assert.equal(ok({ start_time: '13:00', end_time: '17:00' }), true);
    assert.equal(ok({ start_time: '18:00', end_time: '23:00' }), false);
    assert.equal(ok({ start_time: '22:00', end_time: '02:00' }, { ...when, minutes: 60 }), true);
  });
});
