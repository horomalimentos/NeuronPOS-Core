// Vales y codigos promocionales (modulo "promociones"). El descuento se
// calcula sobre lo que queda despues de las promociones automaticas; el uso se
// cuenta al quedar pagada la orden.
import { localParts } from './hours.js';

const toCents = (v) => Math.round(Number(v || 0) * 100);
export const normalizeCode = (code) => String(code || '').trim().toUpperCase().replace(/\s+/g, '');

export async function findVoucher(db, restaurantId, code) {
  return (await db.query('SELECT * FROM vouchers WHERE restaurant_id = $1 AND code = $2', [restaurantId, normalizeCode(code)])).rows[0] || null;
}

/**
 * ¿Por que no aplica? Regresa el mensaje o null si aplica.
 * ctx: { source, branchId, timezone, baseCents, lines, orderId }
 */
export async function voucherProblem(db, restaurantId, v, ctx) {
  if (!v || !v.active) return 'El vale no existe o ya no esta activo';
  if (ctx.source === 'web' ? !v.applies_web : !v.applies_pos) return ctx.source === 'web' ? 'Este vale solo se usa en el restaurante' : 'Este vale solo se usa en pedidos en linea';
  const today = localParts(new Date(), ctx.timezone || 'America/Mexico_City').date;
  const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  if (v.starts_on && today < day(v.starts_on)) return 'El vale todavia no esta vigente';
  if (v.ends_on && today > day(v.ends_on)) return 'El vale ya vencio';
  if (ctx.baseCents < toCents(v.min_amount)) return `El vale pide una compra minima de $${Number(v.min_amount).toFixed(2)}`;
  if (v.max_uses) {
    const used = (await db.query(
      'SELECT count(*)::int AS n FROM voucher_redemptions WHERE voucher_id = $1 AND restaurant_id = $2 AND ($3::uuid IS NULL OR order_id <> $3)',
      [v.id, restaurantId, ctx.orderId || null],
    )).rows[0].n;
    if (used >= v.max_uses) return 'El vale ya se uso las veces permitidas';
  }
  if (v.kind === 'producto' && !ctx.lines.some((l) => l.menu_item_id === v.menu_item_id && !l.voided)) {
    return 'Agrega a la orden el producto del vale';
  }
  return null;
}

/** Descuento en centavos (nunca mas que baseCents). */
export function voucherDiscountCents(v, { baseCents, lines }) {
  let cents = 0;
  if (v.kind === 'monto') cents = toCents(v.amount);
  else if (v.kind === 'porcentaje') cents = Math.round((baseCents * Number(v.percent)) / 100);
  else {
    const prices = lines.filter((l) => l.menu_item_id === v.menu_item_id && !l.voided).map((l) => toCents(l.unit_price) + toCents(l.modifiers_total));
    cents = prices.length ? Math.min(...prices) : 0;
  }
  return Math.max(0, Math.min(cents, baseCents));
}

/** Cuenta el uso al quedar pagada la orden (una vez). */
export async function redeemOrderVoucher(db, restaurantId, orderId) {
  await db.query(
    `INSERT INTO voucher_redemptions (restaurant_id, voucher_id, order_id, amount)
     SELECT restaurant_id, voucher_id, id, voucher_discount FROM orders
      WHERE id = $1 AND restaurant_id = $2 AND voucher_id IS NOT NULL AND voucher_discount > 0
     ON CONFLICT DO NOTHING`,
    [orderId, restaurantId],
  );
}
