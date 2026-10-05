// Importacion de checadas desde otros relojes checadores.
//
// Interfaz de un adaptador: { code, name, parse(payload) } donde parse
// regresa [{ employee_number, occurred_at, kind?, external_id? }]. Hoy solo
// existe el formato generico (JSON); un reloj de otra marca se agrega como
// otro adaptador sin tocar las rutas. Si el evento no dice si es entrada o
// salida se alterna con la ultima checada del empleado.
import { HttpError } from '../../utils/http.js';
import { nextKind } from './clock.js';

const genericAdapter = {
  code: 'generico',
  name: 'Genérico (JSON)',
  parse(payload) {
    const events = Array.isArray(payload) ? payload : payload?.events;
    if (!Array.isArray(events)) throw new HttpError(400, 'events debe ser una lista', 'INVALID_FIELD');
    return events.map((e) => ({
      employee_number: e?.employee_number == null ? '' : String(e.employee_number).trim(),
      occurred_at: e?.occurred_at,
      kind: e?.kind,
      external_id: e?.external_id == null ? null : String(e.external_id),
    }));
  },
};

export const clockAdapters = new Map([[genericAdapter.code, genericAdapter]]);

export const MAX_IMPORT_EVENTS = 2000;

/**
 * Guarda los eventos como checadas con source 'importado'. Repetidos (mismo
 * external_id, o mismo empleado e instante) se omiten. Regresa
 * { imported, duplicates, rejected: [{ index, reason }] }.
 */
export async function importClockEvents(db, restaurantId, adapterCode, payload, { userId } = {}) {
  const adapter = clockAdapters.get(adapterCode);
  if (!adapter) throw new HttpError(400, `Formato de reloj desconocido: ${adapterCode}`, 'UNKNOWN_ADAPTER');
  const events = adapter.parse(payload);
  if (events.length > MAX_IMPORT_EVENTS) throw new HttpError(400, `Máximo ${MAX_IMPORT_EVENTS} checadas por importación`, 'TOO_MANY_EVENTS');

  const numbers = [...new Set(events.map((e) => e.employee_number).filter(Boolean))];
  const employees = new Map((await db.query(
    `SELECT id, employee_number, branch_id FROM employees
      WHERE restaurant_id = $1 AND employee_number = ANY($2::text[])`,
    [restaurantId, numbers],
  )).rows.map((e) => [e.employee_number, e]));

  const indexed = events.map((e, index) => ({ ...e, index, at: new Date(e.occurred_at) }))
    .sort((a, b) => a.at - b.at);
  const result = { imported: 0, duplicates: 0, rejected: [] };
  for (const ev of indexed) {
    const emp = employees.get(ev.employee_number);
    if (!emp) { result.rejected.push({ index: ev.index, reason: 'Número de empleado desconocido' }); continue; }
    if (Number.isNaN(ev.at.getTime())) { result.rejected.push({ index: ev.index, reason: 'Fecha inválida' }); continue; }
    if (ev.kind !== undefined && ev.kind !== null && !['entrada', 'salida'].includes(ev.kind)) {
      result.rejected.push({ index: ev.index, reason: 'Tipo inválido' });
      continue;
    }
    const externalId = ev.external_id || `${adapter.code}:${ev.employee_number}:${ev.at.toISOString()}`;
    let kind = ev.kind;
    if (!kind) {
      const last = (await db.query(
        `SELECT kind, occurred_at FROM time_entries
          WHERE restaurant_id = $1 AND employee_id = $2 AND NOT voided AND occurred_at < $3
          ORDER BY occurred_at DESC LIMIT 1`,
        [restaurantId, emp.id, ev.at],
      )).rows[0];
      kind = nextKind(last, ev.at);
    }
    const ins = await db.query(
      `INSERT INTO time_entries (restaurant_id, employee_id, branch_id, kind, occurred_at, source, external_id, created_by)
       VALUES ($1, $2, $3, $4, $5, 'importado', $6, $7)
       ON CONFLICT (restaurant_id, source, external_id) DO NOTHING`,
      [restaurantId, emp.id, emp.branch_id, kind, ev.at, externalId, userId || null],
    );
    if (ins.rowCount) result.imported += 1;
    else result.duplicates += 1;
  }
  return result;
}
