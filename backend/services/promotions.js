// Motor de promociones (como el de Horom: NxM, paquetes, % y $ de descuento,
// producto de regalo). Lo usan la caja (recalcOrder) y el portal (cotizacion y
// pedido), asi el cliente ve en linea el mismo descuento que se cobra.
//
// Reglas:
//  - Solo cuentan las promociones activas para el canal (caja / en linea), la
//    sucursal, la fecha, el dia y la hora local de la sucursal.
//  - Se aplican por prioridad (menor primero). Cada pieza la usa una sola
//    promocion de productos (no se acumulan dos descuentos sobre el mismo taco).
//  - Las de toda la cuenta (% sin productos, o $) van al final sobre lo que
//    queda. El descuento nunca pasa del subtotal.
// Todo en centavos.
import { localParts } from './hours.js';

const toCents = (v) => Math.round(Number(v || 0) * 100);
const HHMM = (t) => {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
};

/** ¿La promocion aplica ahora? when = { date: 'YYYY-MM-DD', dow: 0-6, minutes }. */
export function isPromotionActive(p, { when, branchId, source }) {
  if (!p.active) return false;
  if (source === 'web' ? !p.applies_web : !p.applies_pos) return false;
  if (p.branch_ids?.length && !p.branch_ids.includes(branchId)) return false;
  const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  if (p.starts_on && when.date < day(p.starts_on)) return false;
  if (p.ends_on && when.date > day(p.ends_on)) return false;
  if (p.days_of_week?.length && !p.days_of_week.includes(when.dow)) return false;
  const start = HHMM(p.start_time);
  const end = HHMM(p.end_time);
  if (start !== null && end !== null && start !== end) {
    const inside = start < end ? when.minutes >= start && when.minutes < end : when.minutes >= start || when.minutes < end;
    if (!inside) return false;
  }
  return true;
}

const scoped = (p) => p.item_ids?.length > 0 || p.category_ids?.length > 0;
const matches = (p, u) => !scoped(p) || p.item_ids.includes(u.menu_item_id) || p.category_ids.includes(u.category_id);

/**
 * promos: promociones ya filtradas con isPromotionActive.
 * lines: [{ menu_item_id, category_id, unit_cents (precio con opciones), quantity, mods_key }]
 * Regresa [{ promotion_id, name, cents }] (solo las que dieron descuento).
 */
export function computePromotions(promos, lines) {
  const units = lines.flatMap((l) => Array.from({ length: l.quantity }, () => ({
    menu_item_id: l.menu_item_id, category_id: l.category_id, cents: l.unit_cents, mods_key: l.mods_key || '', used: false,
  })));
  const subtotal = units.reduce((s, u) => s + u.cents, 0);
  const ordered = [...promos].sort((a, b) => (a.priority || 0) - (b.priority || 0));
  const result = new Map();
  const add = (p, cents) => {
    if (cents > 0) result.set(p.id, { promotion_id: p.id, name: p.name, cents: (result.get(p.id)?.cents || 0) + cents });
  };
  const groupsOf = (p) => {
    const groups = new Map();
    for (const u of units) {
      if (u.used || !matches(p, u)) continue;
      const key = p.same_modifiers ? `${u.menu_item_id}#${u.mods_key}` : 'all';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(u);
    }
    // De mayor a menor precio: en cada juego se regalan las mas baratas.
    for (const g of groups.values()) g.sort((a, b) => b.cents - a.cents);
    return [...groups.values()];
  };

  for (const p of ordered) {
    if (subtotal < toCents(p.min_amount)) continue;
    if (p.kind === 'nxm') {
      const n = p.buy_quantity;
      const free = n - p.pay_quantity;
      for (const g of groupsOf(p)) {
        for (let i = 0; i + n <= g.length; i += n) {
          const set = g.slice(i, i + n);
          set.forEach((u) => { u.used = true; });
          add(p, set.slice(n - free).reduce((s, u) => s + u.cents, 0));
        }
      }
    } else if (p.kind === 'paquete') {
      const n = p.buy_quantity;
      const price = toCents(p.bundle_price);
      for (const g of groupsOf(p)) {
        for (let i = 0; i + n <= g.length; i += n) {
          const set = g.slice(i, i + n);
          const normal = set.reduce((s, u) => s + u.cents, 0);
          if (normal <= price) continue;
          set.forEach((u) => { u.used = true; });
          add(p, normal - price);
        }
      }
    } else if (p.kind === 'porcentaje' && scoped(p)) {
      const rate = Number(p.percent) / 100;
      for (const u of units) {
        if (u.used || !matches(p, u)) continue;
        u.used = true;
        add(p, Math.round(u.cents * rate));
      }
    } else if (p.kind === 'regalo') {
      const bought = units.filter((u) => matches(p, u) && u.menu_item_id !== p.reward_item_id).length;
      const sets = Math.floor(bought / (p.buy_quantity || 1));
      if (!sets) continue;
      const gifts = units
        .filter((u) => !u.used && u.menu_item_id === p.reward_item_id)
        .sort((a, b) => a.cents - b.cents)
        .slice(0, sets * (p.reward_quantity || 1));
      gifts.forEach((u) => { u.used = true; });
      add(p, gifts.reduce((s, u) => s + u.cents, 0));
    }
  }

  // Descuentos a toda la cuenta, sobre lo que queda.
  let left = subtotal - [...result.values()].reduce((s, r) => s + r.cents, 0);
  for (const p of ordered) {
    if (subtotal < toCents(p.min_amount) || left <= 0) continue;
    let cents = 0;
    if (p.kind === 'porcentaje' && !scoped(p)) cents = Math.round(left * (Number(p.percent) / 100));
    else if (p.kind === 'monto') cents = Math.min(toCents(p.amount), left);
    else continue;
    left -= cents;
    add(p, cents);
  }
  return [...result.values()];
}

/**
 * Promociones de una orden o carrito. lines: lineas de priceItems o de
 * order_items ({ menu_item_id, unit_price, modifiers_total, quantity,
 * modifiers | modifier_ids, voided }).
 */
export async function promotionsFor(db, restaurantId, { branchId, source, lines, now = new Date() }) {
  const live = lines.filter((l) => !l.voided);
  if (!live.length) return [];
  const promos = (await db.query(
    'SELECT * FROM promotions WHERE restaurant_id = $1 AND active',
    [restaurantId],
  )).rows;
  if (!promos.length) return [];
  const branch = (await db.query('SELECT timezone FROM branches WHERE id = $1 AND restaurant_id = $2', [branchId, restaurantId])).rows[0];
  const when = localParts(now, branch?.timezone || 'America/Mexico_City');
  const active = promos.filter((p) => isPromotionActive(p, { when, branchId, source }));
  if (!active.length) return [];
  const cats = new Map((await db.query(
    'SELECT id, category_id FROM menu_items WHERE restaurant_id = $1 AND id = ANY($2::uuid[])',
    [restaurantId, [...new Set(live.map((l) => l.menu_item_id))]],
  )).rows.map((r) => [r.id, r.category_id]));
  return computePromotions(active, live.map((l) => ({
    menu_item_id: l.menu_item_id,
    category_id: cats.get(l.menu_item_id) || null,
    unit_cents: toCents(l.unit_price) + toCents(l.modifiers_total),
    quantity: Number(l.quantity),
    mods_key: (l.modifier_ids || (l.modifiers || []).map((m) => m.modifier_id || m.id)).filter(Boolean).sort().join('|'),
  })));
}
