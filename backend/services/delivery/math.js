// Calculos de domicilios en centavos (mismo criterio que posMath.js):
// comision por entrega, corte del repartidor y liquidacion de la flota a un
// restaurante. Funciones puras.
import { fromCents, toCents } from '../posMath.js';

/**
 * Comision por entrega de la flota.
 * fee: { type: 'fixed' | 'percent', value } (delivery_settings u override)
 * subtotal: subtotal de productos de la orden (sin envio ni descuento).
 * Porcentaje: subtotal x valor / 100, redondeado al centavo (mitad hacia arriba).
 */
export function commissionCents(fee, subtotal) {
  const value = toCents(fee?.value); // 12.5 % -> 1250
  if (value <= 0) return 0;
  if (fee.type === 'percent') return Math.round((toCents(subtotal) * Math.min(value, 10000)) / 10000);
  return value;
}

export const commissionAmount = (fee, subtotal) => fromCents(commissionCents(fee, subtotal));

/**
 * Corte de un repartidor: payments = [{ amount, tip }] cobrados en la puerta
 * y todavia sin corte; counted = efectivo que entrega.
 */
export function driverCut(payments, counted) {
  const expected = (payments || []).reduce((s, p) => s + toCents(p.amount) + toCents(p.tip), 0);
  const result = { expected_cash: fromCents(expected), deliveries_count: new Set((payments || []).map((p) => p.order_id)).size };
  if (counted !== undefined && counted !== null) {
    const c = toCents(counted);
    result.counted_cash = fromCents(c);
    result.difference = fromCents(c - expected);
  }
  return result;
}

/**
 * Liquidacion de la flota a un restaurante.
 * cash: [{ id, cash_collected }] entregas con efectivo sin liquidar.
 * commissions: [{ id, commission_amount }] entregas con comision sin
 *   facturar ni liquidar, en orden (las mas viejas primero).
 * Las comisiones se descuentan mientras quepan en el efectivo; las que no
 * quepan se quedan para la siguiente factura. Nunca da un neto negativo.
 */
export function settlementPlan(cash, commissions) {
  const cashCents = (cash || []).reduce((s, r) => s + toCents(r.cash_collected), 0);
  let commissionTotal = 0;
  const commissionIds = [];
  for (const r of commissions || []) {
    const c = toCents(r.commission_amount);
    if (c <= 0) continue;
    if (commissionTotal + c > cashCents) break;
    commissionTotal += c;
    commissionIds.push(r.id);
  }
  return {
    cash_amount: fromCents(cashCents),
    commission_amount: fromCents(commissionTotal),
    net_amount: fromCents(cashCents - commissionTotal),
    cash_ids: (cash || []).filter((r) => toCents(r.cash_collected) > 0).map((r) => r.id),
    commission_ids: commissionIds,
  };
}

/** Suma en pesos de una lista de montos (en centavos por dentro). */
export const sumMoney = (rows, key) => fromCents((rows || []).reduce((s, r) => s + toCents(r[key]), 0));
