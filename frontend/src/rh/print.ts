// Recibo de nomina y reporte del periodo imprimibles (HTML carta que se
// imprime con el dialogo del navegador, igual que el ticket del POS).
import { formatMXN } from '../lib/format';
import type { Restaurant } from '../lib/types';
import { FREQUENCY_LABEL, PAY_METHOD_LABEL, hours } from './lib';
import type { PayrollItem, PayrollPeriod } from './types';

const esc = (v: unknown) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const safeColor = (c: string | null | undefined) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '#111111');
const day = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
};

function page(title: string, color: string, body: string) {
  return `<!doctype html><html lang="es-MX"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: letter; margin: 14mm; }
  body { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; font-size: 12px; color: #111; margin: 0; }
  .head { border-top: 6px solid ${color}; padding-top: 8px; display: flex; justify-content: space-between; align-items: flex-start; }
  .head img { max-height: 44px; }
  h1 { font-size: 18px; margin: 0; } h2 { font-size: 14px; margin: 16px 0 6px; }
  .muted { color: #555; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th, td { padding: 4px 6px; border-bottom: 1px solid #ddd; text-align: left; vertical-align: top; }
  td.r, th.r { text-align: right; white-space: nowrap; }
  .tot td { font-weight: bold; border-top: 2px solid #111; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .sign { margin-top: 40px; display: flex; justify-content: space-between; }
  .sign div { width: 45%; border-top: 1px solid #111; padding-top: 4px; text-align: center; }
  .break { page-break-after: always; }
</style></head><body>${body}</body></html>`;
}

function receiptBody(item: PayrollItem, period: Pick<PayrollPeriod, 'frequency' | 'start_date' | 'end_date'>, r: Restaurant) {
  const per = item.lines.filter((l) => l.kind === 'percepcion');
  const ded = item.lines.filter((l) => l.kind === 'deduccion');
  const rows = (ls: PayrollItem['lines']) => ls.map((l) => `<tr><td>${esc(l.concept)}</td><td class="r">${formatMXN(l.amount)}</td></tr>`).join('')
    || '<tr><td class="muted">—</td><td></td></tr>';
  return `
  <div class="head">
    <div>
      <h1>${esc(r.name)}</h1>
      <div class="muted">Recibo de nómina ${esc(FREQUENCY_LABEL[period.frequency].toLowerCase())} · ${day(period.start_date)} al ${day(period.end_date)}</div>
    </div>
    ${r.logo_url ? `<img src="${esc(r.logo_url)}" alt="">` : ''}
  </div>
  <h2>${esc(item.employee_name)}</h2>
  <div class="muted">${esc([item.position, item.branch_name].filter(Boolean).join(' · '))} ·
    ${item.pay_type === 'por_hora' ? `${formatMXN(item.hourly_rate)} por hora` : `${formatMXN(item.daily_salary)} diarios`}</div>
  <div class="muted">Días trabajados ${item.days_worked} de ${item.days_scheduled} · Horas ${hours(item.minutes_worked)} ·
    Retardos ${item.tardies} · Faltas ${item.absences} · Festivos ${item.holidays}</div>
  <div class="cols">
    <div><h2>Percepciones</h2><table>${rows(per)}<tr class="tot"><td>Total</td><td class="r">${formatMXN(item.gross)}</td></tr></table></div>
    <div><h2>Deducciones</h2><table>${rows(ded)}<tr class="tot"><td>Total</td><td class="r">${formatMXN(item.deductions)}</td></tr></table></div>
  </div>
  <h2>Neto a pagar: ${formatMXN(item.net)}</h2>
  ${item.paid_at ? `<div class="muted">Pagado ${new Date(item.paid_at).toLocaleString('es-MX')}${item.paid_method ? ` · ${PAY_METHOD_LABEL[item.paid_method]}` : ''}</div>` : ''}
  ${item.signed_at ? `<div class="muted">Aceptado por el empleado el ${new Date(item.signed_at).toLocaleString('es-MX')}</div>` : ''}
  <div class="sign"><div>Firma del empleado</div><div>Firma de quien paga</div></div>`;
}

export function receiptHtml(item: PayrollItem, period: Pick<PayrollPeriod, 'frequency' | 'start_date' | 'end_date'>, r: Restaurant) {
  return page(`Recibo ${item.employee_name}`, safeColor(r.primary_color) as string, receiptBody(item, period, r));
}

/** Todos los recibos del periodo, uno por hoja. */
export function receiptsHtml(items: PayrollItem[], period: PayrollPeriod, r: Restaurant) {
  const body = items.map((i, idx) => `<div class="${idx < items.length - 1 ? 'break' : ''}">${receiptBody(i, period, r)}</div>`).join('');
  return page(`Nómina ${period.start_date}`, safeColor(r.primary_color) as string, body);
}
