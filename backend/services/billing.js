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
