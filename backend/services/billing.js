// Calculo del cobro mensual de un restaurante: suma de los modulos que tiene
// contratados (activos hoy), usando el precio personalizado si existe y
// aplicando el descuento porcentual. Todo se calcula en centavos para no
// arrastrar errores de punto flotante.
//
// La comision por domicilios Horom (delivery_settings) es por pedido y NO
// forma parte de la mensualidad.

const toCents = (v) => Math.round(Number(v || 0) * 100);

/** El modulo cuenta como contratado hoy si esta habilitado y dentro de sus fechas. */
export function isModuleActive(row, now = new Date()) {
  if (!row || !row.enabled) return false;
  if (row.started_at && new Date(row.started_at) > now) return false;
  if (row.ends_at && new Date(row.ends_at) <= now) return false;
  return true;
}

/**
 * Precio mensual efectivo de un modulo para un restaurante, en centavos.
 * row: { monthly_price_mxn, custom_price_mxn, discount_pct }
 */
export function effectivePriceCents(row) {
  const base = row.custom_price_mxn !== null && row.custom_price_mxn !== undefined
    ? toCents(row.custom_price_mxn)
    : toCents(row.monthly_price_mxn);
  const discount = Math.min(100, Math.max(0, Number(row.discount_pct || 0)));
  return Math.round((base * (100 - discount)) / 100);
}

/**
 * rows: modulos del restaurante unidos al catalogo
 *   { module_code, name, monthly_price_mxn, custom_price_mxn, discount_pct,
 *     enabled, started_at, ends_at }
 * Regresa { total_mxn, lines: [...] } con montos en pesos (2 decimales).
 */
export function calculateMonthlyTotal(rows, now = new Date()) {
  const lines = [];
  let totalCents = 0;
  for (const row of rows || []) {
    if (!isModuleActive(row, now)) continue;
    const cents = effectivePriceCents(row);
    totalCents += cents;
    lines.push({
      module_code: row.module_code,
      name: row.name,
      catalog_price_mxn: toCents(row.monthly_price_mxn) / 100,
      custom_price_mxn: row.custom_price_mxn === null || row.custom_price_mxn === undefined
        ? null : toCents(row.custom_price_mxn) / 100,
      discount_pct: Number(row.discount_pct || 0),
      amount_mxn: cents / 100,
    });
  }
  return { total_mxn: totalCents / 100, lines };
}

// ---------------------------------------------------------------------------
// Facturas de la suscripcion (Fase 3)
// ---------------------------------------------------------------------------

/**
 * Lineas de una factura: un renglon por modulo vigente con el precio usado
 * (especial o de catalogo), el descuento en pesos y el importe. Todo en
 * centavos; amount = unit - discount siempre cuadra.
 */
export function buildInvoiceLines(rows, now = new Date()) {
  const lines = [];
  let subtotal = 0;
  let discount = 0;
  for (const row of rows || []) {
    if (!isModuleActive(row, now)) continue;
    const hasCustom = row.custom_price_mxn !== null && row.custom_price_mxn !== undefined;
    const unit = hasCustom ? toCents(row.custom_price_mxn) : toCents(row.monthly_price_mxn);
    const amount = effectivePriceCents(row);
    subtotal += unit;
    discount += unit - amount;
    lines.push({
      module_code: row.module_code,
      name: row.name,
      catalog_price_mxn: toCents(row.monthly_price_mxn) / 100,
      custom_price_mxn: hasCustom ? toCents(row.custom_price_mxn) / 100 : null,
      unit_price_mxn: unit / 100,
      discount_pct: Math.min(100, Math.max(0, Number(row.discount_pct || 0))),
      discount_mxn: (unit - amount) / 100,
      amount_mxn: amount / 100,
    });
  }
  return {
    lines,
    subtotal_mxn: subtotal / 100,
    discount_mxn: discount / 100,
    total_mxn: (subtotal - discount) / 100,
  };
}

// Fechas de cobro como 'YYYY-MM-DD' (dia calendario en la zona de cobro).

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const parseYmd = (s) => String(s).slice(0, 10).split('-').map(Number);

/** Fecha local (YYYY-MM-DD) de un instante en una zona horaria. */
export function localDate(date, timeZone = 'America/Mexico_City') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(date));
}

export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function addDays(date, n) {
  const [y, m, d] = parseYmd(date);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Dia de cobro dentro de un mes; en meses cortos, el ultimo dia. */
const anchorIn = (y, m, day) => ymd(y, m, Math.min(day, daysInMonth(y, m)));

/**
 * Periodo de cobro que contiene `today`: empieza en el dia de cobro mas
 * reciente (<= today) y termina el dia anterior al siguiente.
 * Regresa { start, end, next } (end incluido, next = siguiente cobro).
 */
export function billingPeriod(today, billingDay) {
  const day = Math.min(31, Math.max(1, Number(billingDay) || 1));
  let [y, m] = parseYmd(today);
  let start = anchorIn(y, m, day);
  if (start > today) {
    [y, m] = m === 1 ? [y - 1, 12] : [y, m - 1];
    start = anchorIn(y, m, day);
  }
  const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
  const next = anchorIn(ny, nm, day);
  return { start, end: addDays(next, -1), next };
}

/** Dia de cobro efectivo: el configurado o el dia en que se activo. */
export function effectiveBillingDay(restaurant, timeZone) {
  if (restaurant.billing_day) return Number(restaurant.billing_day);
  const ref = restaurant.activated_at || restaurant.trial_ends_at || restaurant.created_at || new Date();
  return Number(localDate(ref, timeZone).slice(8, 10));
}

/** Ultimo dia con servicio antes de suspender: fecha limite + dias de gracia. */
export const suspensionDate = (dueDate, graceDays) => addDays(dueDate, Number(graceDays) + 1);
