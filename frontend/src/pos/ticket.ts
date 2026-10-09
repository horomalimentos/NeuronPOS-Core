// Ticket imprimible: HTML sencillo de 80 mm con la marca del restaurante. En
// el navegador se imprime con el dialogo de impresion (iframe oculto +
// window.print()); dentro de la app NeuronPOS se manda directo a la
// impresora configurada en la app (ver lib/native.ts).
import { formatMXN } from '../lib/format';
import { nativePrint, type PrintRole } from '../lib/native';
import type { Branch, Restaurant } from '../lib/types';
import { ORDER_TYPE_LABEL, formatDateTime, num } from './lib';
import type { CashSessionDetail, Order, OrderItem, PosSettings } from './types';

const esc = (v: unknown) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const safeColor = (c: string | null | undefined) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '#111111');

function page(title: string, color: string, body: string) {
  return `<!doctype html><html lang="es-MX"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: 80mm auto; margin: 4mm; }
  * { box-sizing: border-box; }
  body { font-family: ui-monospace, 'Courier New', monospace; font-size: 12px; color: #000; margin: 0; width: 72mm; }
  .center { text-align: center; }
  .brand { border-top: 4px solid ${color}; padding-top: 6px; }
  .brand img { max-height: 48px; max-width: 60mm; }
  h1 { font-size: 16px; margin: 4px 0 2px; }
  .muted { color: #444; font-size: 11px; }
  hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { vertical-align: top; padding: 1px 0; }
  td.r { text-align: right; white-space: nowrap; }
  .mod { padding-left: 10px; font-size: 11px; color: #333; }
  .void { text-decoration: line-through; color: #777; }
  .total td { font-size: 15px; font-weight: bold; padding-top: 3px; }
  .pre { white-space: pre-line; }
</style></head><body>${body}</body></html>`;
}

function header(restaurant: Restaurant, branch: Branch | null, settings: PosSettings | null) {
  return `<div class="center brand">
    ${restaurant.logo_url ? `<img src="${esc(restaurant.logo_url)}" alt="">` : ''}
    <h1>${esc(restaurant.name)}</h1>
    ${branch ? `<div class="muted">${esc(branch.name)}${branch.address ? `<br>${esc(branch.address)}` : ''}${branch.phone ? `<br>Tel. ${esc(branch.phone)}` : ''}</div>` : ''}
    ${settings?.ticket_header ? `<div class="pre muted">${esc(settings.ticket_header)}</div>` : ''}
  </div><hr>`;
}

const row = (label: string, value: string, cls = '') => `<tr class="${cls}"><td>${label}</td><td class="r">${value}</td></tr>`;

/** HTML del ticket de una orden. */
export function orderTicketHtml(order: Order, restaurant: Restaurant, branch: Branch | null, settings: PosSettings | null, change = 0) {
  const items = (order.items || []).map((it) => {
    const cls = it.voided_at ? 'void' : '';
    const mods = it.modifiers.map((m) => `<div class="mod">+ ${esc(m.name)}${num(m.price_delta) ? ` (${formatMXN(m.price_delta)})` : ''}</div>`).join('');
    const notes = it.notes ? `<div class="mod">* ${esc(it.notes)}</div>` : '';
    return `<tr class="${cls}"><td>${it.quantity} x ${esc(it.name)}${mods}${notes}</td><td class="r">${formatMXN(it.line_total)}</td></tr>`;
  }).join('');
  const who = order.order_type === 'comedor'
    ? `Mesa ${esc(order.table_name)}${order.guests ? ` · ${order.guests} pers.` : ''}`
    : ORDER_TYPE_LABEL[order.order_type];
  const customer = [order.customer_name, order.customer_phone, order.customer_address, order.delivery_reference]
    .filter(Boolean).map(esc).join('<br>');
  const web = order.source === 'web'
    ? `<div class="center"><b>PEDIDO EN LÍNEA</b>${order.payment_preference ? `<br>Paga con ${order.payment_preference}${num(order.pay_with) ? ` (${formatMXN(order.pay_with)})` : ''}` : ''}</div>`
    : '';
  const taxLabel = `IVA ${num(order.tax_rate_pct)}%${order.prices_include_tax ? ' (incluido)' : ''}`;
  const payments = (order.payments || []).map((p) => row(
    esc(p.method_name) + (p.reference ? ` <span class="muted">${esc(p.reference)}</span>` : ''),
    formatMXN(num(p.amount) + num(p.tip)),
  )).join('');
  const changeTotal = change || (order.payments || []).reduce((s, p) => s + num(p.change_given), 0);
  const body = `${header(restaurant, branch, settings)}
    <table>
      ${row(`<b>Folio ${order.folio}</b>`, formatDateTime(order.paid_at || order.created_at))}
      ${row(who, order.created_by_name ? esc(order.created_by_name) : '')}
    </table>
    ${web}
    ${customer ? `<div class="muted">${customer}</div>` : ''}
    ${order.notes ? `<div class="muted">Notas: ${esc(order.notes)}</div>` : ''}
    <hr><table>${items}</table><hr>
    <table>
      ${row('Subtotal', formatMXN(order.subtotal))}
      ${num(order.discount_amount) ? row(`Descuento${order.discount_type === 'percent' ? ` ${num(order.discount_value)}%` : ''}`, `-${formatMXN(order.discount_amount)}`) : ''}
      ${row(taxLabel, formatMXN(order.tax_amount))}
      ${num(order.delivery_fee) ? row('Envío', formatMXN(order.delivery_fee)) : ''}
      ${row('TOTAL', formatMXN(order.total), 'total')}
    </table>
    ${payments ? `<hr><table>${payments}
      ${num(order.tip_amount) ? row('Propina', formatMXN(order.tip_amount)) : ''}
      ${changeTotal ? row('Cambio', formatMXN(changeTotal)) : ''}</table>` : ''}
    ${order.status === 'pagada' ? '' : `<hr><div class="center"><b>${order.status === 'cancelada' ? 'CANCELADA' : 'CUENTA - NO ES COMPROBANTE DE PAGO'}</b></div>`}
    <hr><div class="center pre muted">${esc(settings?.ticket_footer || '¡Gracias por su visita!')}</div>`;
  return page(`Ticket ${order.folio}`, safeColor(restaurant.primary_color)!, body);
}

/** HTML del corte de caja. */
export function cashCutHtml(detail: CashSessionDetail, restaurant: Restaurant) {
  const { session, cut, movements } = detail;
  const methods = cut.methods.map((m) => `<tr><td colspan="2"><b>${esc(m.name)}</b> (${m.payments})</td></tr>
    ${row('Esperado', formatMXN(m.expected))}
    ${m.counted !== undefined ? row('Contado', formatMXN(m.counted)) + row('Diferencia', formatMXN(m.difference)) : ''}`).join('');
  const movs = movements.map((m) => row(`${m.kind === 'entrada' ? '+' : '-'} ${esc(m.reason)}`, formatMXN(m.amount))).join('');
  const body = `${header(restaurant, null, null)}
    <div class="center"><b>CORTE DE CAJA</b></div>
    <table>
      ${row('Sucursal', esc(session.branch_name))}
      ${row('Terminal', esc(session.terminal))}
      ${row('Apertura', formatDateTime(session.opened_at))}
      ${row('Abrió', esc(session.opened_by_name))}
      ${session.closed_at ? row('Cierre', formatDateTime(session.closed_at)) + row('Cerró', esc(session.closed_by_name)) : ''}
    </table><hr>
    <table>
      ${row('Fondo inicial', formatMXN(cut.opening_cash))}
      ${row('Entradas', formatMXN(cut.cash_in))}
      ${row('Salidas', formatMXN(cut.cash_out))}
      ${row('Ventas', formatMXN(cut.total_sales))}
      ${row('Propinas', formatMXN(cut.total_tips))}
      ${row('Órdenes cobradas', String(cut.orders_count))}
    </table><hr><table>${methods}</table>
    ${movs ? `<hr><table>${movs}</table>` : ''}
    ${session.notes ? `<hr><div class="pre">${esc(session.notes)}</div>` : ''}
    <hr><table>${row('Efectivo esperado', formatMXN(cut.expected_cash), 'total')}
      ${cut.counted_cash !== undefined ? row('Efectivo contado', formatMXN(cut.counted_cash)) + row('Diferencia', formatMXN(cut.cash_difference)) : ''}</table>`;
  return page('Corte de caja', safeColor(restaurant.primary_color)!, body);
}

/** HTML de la comanda para cocina: solo lo que se acaba de enviar, en grande. */
export function comandaHtml(order: Order, items: OrderItem[], branch: Branch | null) {
  const who = order.order_type === 'comedor'
    ? `Mesa ${esc(order.table_name)}`
    : ORDER_TYPE_LABEL[order.order_type];
  const lines = items.map((it) => `<div class="it"><b>${it.quantity} x ${esc(it.name)}</b>
    ${it.modifiers.map((m) => `<div class="mod">+ ${esc(m.name)}</div>`).join('')}
    ${it.notes ? `<div class="mod">* ${esc(it.notes)}</div>` : ''}</div>`).join('');
  const body = `<div class="center"><h1>${who}</h1>
      <div>Folio ${order.folio}${order.source === 'web' ? ' · EN LÍNEA' : ''}</div>
      <div class="muted">${formatDateTime(items[0]?.sent_at || order.sent_at || order.created_at)}${branch ? ` · ${esc(branch.name)}` : ''}</div></div><hr>
    ${order.customer_name ? `<div>${esc(order.customer_name)}</div>` : ''}
    ${lines}
    ${order.notes ? `<hr><div class="pre">Notas: ${esc(order.notes)}</div>` : ''}
    ${order.created_by_name ? `<hr><div class="muted">Mesero: ${esc(order.created_by_name)}</div>` : ''}`;
  return page(`Comanda ${order.folio}`, '#000000', body).replace('</style>', `
  h1 { font-size: 22px; }
  .it { font-size: 16px; margin: 6px 0; }
  .it .mod { font-size: 14px; color: #000; }
</style>`);
}

/** Articulos del ultimo envio a cocina (todos comparten la misma hora de envio). */
export function lastSentItems(order: Order): OrderItem[] {
  const live = (order.items || []).filter((it) => it.sent_at && !it.voided_at);
  const last = live.map((it) => it.sent_at!).sort().pop();
  return last ? live.filter((it) => it.sent_at === last) : [];
}

/**
 * Imprime un HTML. En la app NeuronPOS va directo a su impresora; si no hay
 * app (o no tiene impresora para ese uso) se usa el dialogo del navegador.
 * Las comandas solo se imprimen en la app: en el navegador no se abre nada.
 */
export async function printHtml(html: string, role: PrintRole = 'ticket', opts: { openDrawer?: boolean } = {}) {
  try {
    if (await nativePrint(role, html, opts)) return;
  } catch (err) {
    window.alert(`No se pudo imprimir: ${err instanceof Error ? err.message : err}`);
    return;
  }
  if (role === 'comanda') return;
  printInBrowser(html);
}

/** Imprime un HTML con el dialogo del navegador usando un iframe oculto. */
function printInBrowser(html: string) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  document.body.appendChild(frame);
  const doc = frame.contentWindow?.document;
  if (!doc) return;
  doc.open();
  doc.write(html);
  doc.close();
  const go = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 1000);
  };
  // Espera a que cargue el logo (si hay) antes de imprimir.
  const imgs = Array.from(doc.images);
  if (imgs.length === 0) setTimeout(go, 50);
  else Promise.all(imgs.map((img) => (img.complete ? null : new Promise((r) => { img.onload = r; img.onerror = r; })))).then(go);
}
