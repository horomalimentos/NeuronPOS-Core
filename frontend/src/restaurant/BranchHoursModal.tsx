import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Modal, Spinner, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import type { Branch, BranchClosure, BranchHours } from '../lib/types';
import { WEEKDAYS, WEEK_ORDER } from '../site/hours';

interface Schedule { hours: BranchHours[]; closures: BranchClosure[]; status: { open: boolean } }
interface DayRow { open: boolean; opens_at: string; closes_at: string }

/**
 * Horario semanal y dias cerrados de una sucursal. Se usa en el sitio
 * (abierto/cerrado) y para aceptar pedidos en linea solo con la sucursal
 * abierta. Cierre antes que apertura = cierra despues de medianoche; misma
 * hora = 24 horas.
 */
export default function BranchHoursModal({ branch, onClose }: { branch: Branch; onClose: () => void }) {
  const [days, setDays] = useState<Record<number, DayRow> | null>(null);
  const [closures, setClosures] = useState<BranchClosure[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<Schedule>(`/branches/${branch.id}/hours`)
      .then((s) => {
        const map: Record<number, DayRow> = {};
        for (let d = 0; d < 7; d += 1) {
          const h = s.hours.find((x) => x.weekday === d);
          map[d] = h ? { open: true, opens_at: h.opens_at, closes_at: h.closes_at } : { open: false, opens_at: '09:00', closes_at: '21:00' };
        }
        setDays(map);
        setClosures(s.closures);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [branch.id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!days) return;
    setSaving(true);
    setError('');
    try {
      await api(`/branches/${branch.id}/hours`, {
        method: 'PUT',
        body: {
          hours: Object.entries(days).filter(([, d]) => d.open).map(([w, d]) => ({ weekday: Number(w), opens_at: d.opens_at, closes_at: d.closes_at })),
          closures: closures.filter((c) => c.closed_on).map((c) => ({ closed_on: c.closed_on, reason: c.reason || null })),
        },
      });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  const setDay = (d: number, patch: Partial<DayRow>) => setDays((prev) => (prev ? { ...prev, [d]: { ...prev[d], ...patch } } : prev));

  return (
    <Modal title={`Horario · ${branch.name}`} onClose={onClose} wide>
      {!days ? (error ? <Alert>{error}</Alert> : <Spinner />) : (
        <form onSubmit={submit} className="space-y-5">
          {error && <Alert>{error}</Alert>}
          <p className="text-xs text-gray-500">Zona horaria: {branch.timezone}. Si cierra después de medianoche pon la hora de cierre menor que la de apertura (ej. 18:00 – 02:00); misma hora = 24 horas.</p>
          <div className="space-y-2">
            {WEEK_ORDER.map((d) => {
              const row = days[d];
              return (
                <div key={d} className="flex flex-wrap items-center gap-3">
                  <span className="w-24 text-sm font-medium text-gray-200">{WEEKDAYS[d]}</span>
                  <Toggle label={`Abre el ${WEEKDAYS[d]}`} checked={row.open} onChange={(v) => setDay(d, { open: v })} />
                  {row.open ? (
                    <>
                      <input type="time" className="input w-auto py-1.5" required value={row.opens_at} onChange={(e) => setDay(d, { opens_at: e.target.value })} aria-label={`Abre ${WEEKDAYS[d]}`} />
                      <span className="text-gray-500">a</span>
                      <input type="time" className="input w-auto py-1.5" required value={row.closes_at} onChange={(e) => setDay(d, { closes_at: e.target.value })} aria-label={`Cierra ${WEEKDAYS[d]}`} />
                    </>
                  ) : <span className="text-sm text-gray-500">Cerrado</span>}
                </div>
              );
            })}
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">Días cerrados</h3>
              <Button type="button" variant="ghost" onClick={() => setClosures([...closures, { closed_on: '', reason: '' }])}><Plus className="h-4 w-4" /> Agregar</Button>
            </div>
            {closures.length === 0 && <p className="text-sm text-gray-500">Sin días cerrados próximos.</p>}
            <div className="space-y-2">
              {closures.map((c, i) => (
                <div key={i} className="flex gap-2">
                  <input type="date" className="input w-auto py-1.5" required value={c.closed_on}
                    onChange={(e) => setClosures(closures.map((x, j) => (j === i ? { ...x, closed_on: e.target.value } : x)))} aria-label="Fecha" />
                  <input className="input py-1.5" placeholder="Motivo (opcional)" maxLength={200} value={c.reason || ''}
                    onChange={(e) => setClosures(closures.map((x, j) => (j === i ? { ...x, reason: e.target.value } : x)))} />
                  <button type="button" className="rounded-lg p-2 text-gray-400 hover:text-red-300" onClick={() => setClosures(closures.filter((_, j) => j !== i))} aria-label="Quitar"><Trash2 className="h-4 w-4" /></button>
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
            <Button type="submit" loading={saving}>Guardar horario</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
