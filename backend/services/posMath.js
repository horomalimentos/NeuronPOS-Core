// Calculos del punto de venta: totales de una orden (descuento e impuesto),
// pagos (cambio y propina) y corte de caja. Funciones puras: todo se calcula
// en centavos enteros y se regresa en pesos con 2 decimales, para no
// arrastrar errores de punto flotante (mismo criterio que billing.js).
import { HttpError } from '../utils/http.js';

export const toCents = (v) => Math.round(Number(v || 0) * 100);
export const fromCents = (c) => Math.round(c) / 100;

/** Importe de una linea: cantidad x (precio + modificadores), en centavos. */
export function lineTotalCents({ unit_price, modifiers_total = 0, quantity }) {
  return (toCents(unit_price) + toCents(modifiers_total)) * Number(quantity);
}

/**
 * Descuento en centavos sobre un subtotal en centavos.
 * discount: { type: 'amount' | 'percent', value } o null.
 * Nunca excede el subtotal.
 */
export function discountCents(subtotalCents, discount) {
  if (!discount || !discount.type) return 0;
  const value = Number(discount.value || 0);
  if (!(value > 0)) return 0;
  const raw = discount.type === 'percent'
    ? Math.round((subtotalCents * Math.min(100, value)) / 100)
    : toCents(value);
  return Math.min(Math.max(0, raw), subtotalCents);
}

/**
 * Totales de una orden.
 * items: [{ unit_price, modifiers_total, quantity, voided? }]
 * opts: { discount, taxRatePct, pricesIncludeTax, deliveryFee }
 *
 * - pricesIncludeTax = true (precios con IVA): total = subtotal - descuento y
 *   el impuesto se desglosa: tax = total - total / (1 + tasa).
 * - pricesIncludeTax = false: tax = (subtotal - descuento) * tasa y se suma.
 * - deliveryFee (pedidos a domicilio): se suma al final, sin descuento ni
 *   impuesto (es un cargo fijo por sucursal).
 */
export function calculateOrderTotals(items, {
  discount = null, taxRatePct = 0, pricesIncludeTax = true, deliveryFee = 0,
} = {}) {
  const subtotal = (items || [])
    .filter((it) => !it.voided)
    .reduce((s, it) => s + lineTotalCents(it), 0);
  const disc = discountCents(subtotal, discount);
  const base = subtotal - disc;
  const rate = Number(taxRatePct || 0) / 100;
  let tax;
  let total;
  if (pricesIncludeTax) {
    total = base;
    tax = rate > 0 ? Math.round(base - base / (1 + rate)) : 0;
  } else {
    tax = Math.round(base * rate);
    total = base + tax;
  }
  const fee = Math.max(0, toCents(deliveryFee));
  return {
    subtotal: fromCents(subtotal),
    discount_amount: fromCents(disc),
    tax_amount: fromCents(tax),
    delivery_fee: fromCents(fee),
    total: fromCents(total + fee),
  };
}

/**
 * Porcentaje que representa un descuento sobre el subtotal (para revisar el
 * limite del cajero). Regresa 0..100.
 */
export function discountPercentOf(subtotal, discount) {
  const sub = toCents(subtotal);
  if (sub <= 0) return 0;
  return (discountCents(sub, discount) * 100) / sub;
}

/**
 * Valida y normaliza los pagos de una orden.
 * lines: [{ kind, amount, tip, received }] (kind = tipo del metodo de pago)
 * remaining: saldo pendiente de la cuenta (pesos).
 * Regresa { lines: [{ amount, tip, received, change_given }], applied, change }
 * o lanza HttpError 400 con code.
 *
 * Reglas:
 *  - amount es lo que se abona a la cuenta; la suma no puede pasar del saldo.
 *  - Solo el efectivo admite cambio: received >= amount + tip.
 *  - Otros metodos cobran exacto: received = amount + tip.
 */
export function normalizePayments(lines, remaining) {
  const remainingCents = toCents(remaining);
  let applied = 0;
  let change = 0;
  const out = (lines || []).map((l) => {
    const amount = toCents(l.amount);
    const tip = toCents(l.tip);
    if (amount < 0 || tip < 0) throw codeError('Los montos no pueden ser negativos', 'INVALID_PAYMENT');
    if (amount + tip <= 0) throw codeError('Cada pago debe tener un monto mayor a cero', 'INVALID_PAYMENT');
    let received = amount + tip;
    if (l.kind === 'efectivo') {
      if (l.received !== undefined && l.received !== null && l.received !== '') {
        received = toCents(l.received);
        if (received < amount + tip) throw codeError('El efectivo recibido no cubre el pago', 'INSUFFICIENT_CASH');
      }
    } else if (l.received !== undefined && l.received !== null && l.received !== '' && toCents(l.received) !== amount + tip) {
      throw codeError('Solo los pagos en efectivo pueden dar cambio', 'CHANGE_NOT_ALLOWED');
    }
    applied += amount;
    change += received - amount - tip;
    return {
      amount: fromCents(amount),
      tip: fromCents(tip),
      received: fromCents(received),
      change_given: fromCents(received - amount - tip),
    };
  });
  if (applied > remainingCents) {
    throw codeError('Los pagos exceden el saldo de la cuenta', 'OVERPAYMENT');
  }
  return {
    lines: out,
    applied: fromCents(applied),
    change: fromCents(change),
    remaining_after: fromCents(remainingCents - applied),
  };
}

/**
 * Corte de caja.
 * methods:   [{ id, name, kind }]
 * payments:  [{ payment_method_id, amount, tip }]   (pagos del turno)
 * movements: [{ kind: 'entrada' | 'salida', amount }]
 * openingCash: fondo inicial
 * counts:    { [payment_method_id]: contado } (opcional, al cerrar)
 *
 * Esperado por metodo = suma(amount + tip). Para efectivo ademas:
 *   fondo + entradas - salidas.
 */
export function calculateCashCut({ methods, payments, movements, openingCash = 0, counts = null }) {
  const byMethod = new Map(methods.map((m) => [m.id, { sales: 0, tips: 0, count: 0 }]));
  for (const p of payments || []) {
    if (!byMethod.has(p.payment_method_id)) byMethod.set(p.payment_method_id, { sales: 0, tips: 0, count: 0 });
    const acc = byMethod.get(p.payment_method_id);
    acc.sales += toCents(p.amount);
    acc.tips += toCents(p.tip);
    acc.count += 1;
  }
  const entradas = (movements || []).filter((m) => m.kind === 'entrada').reduce((s, m) => s + toCents(m.amount), 0);
  const salidas = (movements || []).filter((m) => m.kind === 'salida').reduce((s, m) => s + toCents(m.amount), 0);
  const opening = toCents(openingCash);

  let totalSales = 0;
  let totalTips = 0;
  let expectedCash = 0;
  let countedCash = null;
  const lines = methods.map((m) => {
    const acc = byMethod.get(m.id);
    let expected = acc.sales + acc.tips;
    if (m.kind === 'efectivo') expected += opening + entradas - salidas;
    totalSales += acc.sales;
    totalTips += acc.tips;
    const line = {
      payment_method_id: m.id,
      name: m.name,
      kind: m.kind,
      payments: acc.count,
      sales: fromCents(acc.sales),
      tips: fromCents(acc.tips),
      expected: fromCents(expected),
    };
    if (counts) {
      // Los puntos no se cuentan: lo esperado es lo contado.
      const counted = m.kind === 'puntos' ? expected : toCents(counts[m.id] ?? 0);
      line.counted = fromCents(counted);
      line.difference = fromCents(counted - expected);
      if (m.kind === 'efectivo') countedCash = (countedCash ?? 0) + counted;
    }
    if (m.kind === 'efectivo') expectedCash += expected;
    return line;
  });

  const result = {
    opening_cash: fromCents(opening),
    cash_in: fromCents(entradas),
    cash_out: fromCents(salidas),
    total_sales: fromCents(totalSales),
    total_tips: fromCents(totalTips),
    expected_cash: fromCents(expectedCash),
    methods: lines,
  };
  if (counts) {
    result.counted_cash = fromCents(countedCash ?? 0);
    result.cash_difference = fromCents((countedCash ?? 0) - expectedCash);
    result.total_difference = fromCents(lines.reduce((s, l) => s + toCents(l.difference), 0));
  }
  return result;
}

// Error 400 con codigo: la API lo responde tal cual.
const codeError = (message, code) => new HttpError(400, message, code);
