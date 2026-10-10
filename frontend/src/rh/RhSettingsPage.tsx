import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Alert, Button, Field, Modal, PageHeader, Spinner, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDay, formatMXN } from '../lib/format';
import { useAdmin } from '../restaurant/context';
import { ADJUSTMENT_KIND_LABEL, DOW_LABEL, rhCan, todayStr } from './lib';
import type { Adjustment, Area, ClockSettings, Employee, Holiday, PayrollSettings } from './types';

/** Configuracion de RH: reglas de nomina, festivos, bonos y descuentos, checador y areas. */
export default function RhSettingsPage() {
  return (
    <>
      <PageHeader title="Configuración de RH" subtitle="Reglas de nómina, días festivos, bonos y descuentos, checador y áreas." />
      <div className="space-y-6">
        <PayrollSettingsCard />
        <AdjustmentsCard />
        <HolidaysCard />
        <ClockSettingsCard />
        <AreasCard />
      </div>
    </>
  );
}

function Section({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-white">{title}</h2>
          {subtitle && <p className="mt-0.5 text-sm text-gray-400">{subtitle}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

type SettingsForm = Record<keyof PayrollSettings, string | boolean>;

function PayrollSettingsCard() {
  const { me } = useAdmin();
  const isAdmin = rhCan.admin(me.user.role);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api<{ settings: PayrollSettings }>('/rh/settings').then((r) => {
      const s = r.settings as unknown as Record<string, unknown>;
      setForm(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === 'boolean' ? v : String(v ?? '')])) as SettingsForm);
    }).catch((e) => setError(errorMessage(e)));
  }, []);
  if (!form) return <Section title="Reglas de nómina">{error ? <Alert>{error}</Alert> : <Spinner />}</Section>;

  const num = (k: keyof PayrollSettings, label: string, hint?: string, step = '1') => (
    <Field label={label} hint={hint}>
      <input className="input" type="number" step={step} min="0" disabled={!isAdmin} value={String(form[k])} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
    </Field>
  );
  const flag = (k: keyof PayrollSettings, label: string) => (
    <label className="flex items-center gap-3 text-sm text-gray-300">
      <Toggle label={label} checked={Boolean(form[k])} disabled={!isAdmin} onChange={(v) => setForm({ ...form, [k]: v })} /> {label}
    </label>
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(form)) {
        if (['restaurant_id', 'updated_at'].includes(k)) continue;
        body[k] = typeof v === 'boolean' ? v : Number(v);
      }
      await api('/rh/settings', { method: 'PUT', body });
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Reglas de nómina" subtitle={isAdmin ? 'Se aplican al calcular cada periodo.' : 'Solo un administrador puede cambiarlas.'}>
      <form onSubmit={submit} className="space-y-5">
        {error && <Alert>{error}</Alert>}
        {saved && <Alert kind="success">Reglas guardadas. Recalcula los periodos en borrador para aplicarlas.</Alert>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="La semana de nómina empieza en">
            <select className="input" disabled={!isAdmin} value={String(form.week_start_day)} onChange={(e) => setForm({ ...form, week_start_day: e.target.value })}>
              {DOW_LABEL.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          </Field>
          {num('daily_hours', 'Horas de la jornada', 'Salario diario / horas = tarifa por hora.', '0.5')}
          {num('tolerance_minutes', 'Tolerancia (minutos)', 'Después de esto cuenta retardo.')}
        </div>
        <h3 className="text-sm font-semibold text-white">Retardos y faltas</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          {num('tardiness_penalty', 'Descuento fijo por retardo ($)', undefined, '0.01')}
          {num('absence_penalty', 'Descuento por falta ($)', 'Además, el día no se paga.', '0.01')}
          <div className="flex flex-col justify-end gap-3 pb-1">
            {flag('tardiness_proportional', 'Descontar los minutos tarde')}
            {flag('pay_rest_days', 'Pagar el día de descanso')}
          </div>
        </div>
        <h3 className="text-sm font-semibold text-white">Horas extra, festivos y domingos</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="flex items-end pb-1">{flag('overtime_enabled', 'Pagar horas extra')}</div>
          {num('overtime_block_minutes', 'Bloque mínimo (minutos)')}
          {num('overtime_double_weekly_hours', 'Horas dobles por semana', 'Las siguientes se pagan triples.')}
          {num('overtime_double_factor', 'Factor horas dobles', undefined, '0.1')}
          {num('overtime_triple_factor', 'Factor horas triples', undefined, '0.1')}
          {num('holiday_worked_factor', 'Festivo trabajado: factor adicional', '2 = salario doble además del día.', '0.1')}
          {num('rest_day_worked_factor', 'Descanso trabajado: factor adicional', undefined, '0.1')}
          {num('sunday_premium_pct', 'Prima dominical (%)', undefined, '0.01')}
          <div className="flex items-end pb-1">{flag('official_holidays', 'Usar festivos oficiales de México')}</div>
        </div>
        <h3 className="text-sm font-semibold text-white">Bonos por periodo</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          {num('punctuality_bonus', 'Bono de puntualidad ($)', 'Sin retardos en el periodo.', '0.01')}
          {num('attendance_bonus', 'Bono de asistencia ($)', 'Sin faltas en el periodo.', '0.01')}
        </div>
        <h3 className="text-sm font-semibold text-white">Aguinaldo</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          {num('aguinaldo_days', 'Días de aguinaldo por año', 'Mínimo 15 (LFT art. 87); proporcional si no trabajó el año completo.')}
        </div>
        {isAdmin && <div className="flex justify-end"><Button type="submit" loading={saving}>Guardar reglas</Button></div>}
      </form>
    </Section>
  );
}

function AdjustmentsCard() {
  const [rows, setRows] = useState<Adjustment[] | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => {
    api<{ adjustments: Adjustment[] }>('/rh/adjustments').then((r) => setRows(r.adjustments)).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => {
    load();
    api<{ employees: Employee[] }>('/employees?active=1').then((r) => setEmployees(r.employees)).catch(() => {});
  }, [load]);
  async function toggle(a: Adjustment) {
    try {
      await api(`/rh/adjustments/${a.id}`, { method: 'PATCH', body: { active: !a.active } });
      load();
    } catch (err) { setError(errorMessage(err)); }
  }
  async function remove(a: Adjustment) {
    if (!window.confirm(`¿Borrar "${a.concept}"?`)) return;
    try {
      await api(`/rh/adjustments/${a.id}`, { method: 'DELETE' });
      load();
    } catch (err) { setError(errorMessage(err)); }
  }
  return (
    <Section title="Bonos, descuentos y préstamos" subtitle="Se suman o descuentan en la nómina del periodo que corresponda."
      actions={<Button variant="secondary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Nuevo</Button>}>
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      {!rows ? <Spinner /> : rows.length === 0 ? <p className="text-sm text-gray-500">Sin ajustes.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
              <tr><th className="py-2 pr-3 font-medium">Empleado</th><th className="py-2 pr-3 font-medium">Concepto</th><th className="py-2 pr-3 font-medium">Monto</th><th className="py-2 pr-3 font-medium">Cuándo</th><th className="py-2 pr-3 font-medium">Activo</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="py-2 pr-3 text-white">{a.employee_name}</td>
                  <td className="py-2 pr-3 text-gray-300">{ADJUSTMENT_KIND_LABEL[a.kind]}: {a.concept}{a.source === 'empleado_mes' && <span className="text-xs text-amber-300"> · empleado del mes</span>}</td>
                  <td className="py-2 pr-3 text-gray-300">
                    {formatMXN(a.amount)}{a.kind === 'prestamo' && <div className="text-xs text-gray-500">{formatMXN(a.applied_amount)} de {formatMXN(a.total_amount)}</div>}
                  </td>
                  <td className="py-2 pr-3 text-xs text-gray-400">{a.recurrence === 'unico' ? formatDay(a.apply_date) : `Cada periodo desde ${formatDay(a.start_date)}${a.end_date ? ` hasta ${formatDay(a.end_date)}` : ''}`}</td>
                  <td className="py-2 pr-3"><Toggle label="Activo" checked={a.active} onChange={() => toggle(a)} /></td>
                  <td className="py-2 text-right"><button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-red-300" onClick={() => remove(a)} aria-label="Borrar"><Trash2 className="h-4 w-4" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <AdjustmentModal employees={employees} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); }} />}
    </Section>
  );
}

function AdjustmentModal({ employees, onClose, onSaved }: { employees: Employee[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    employee_id: employees[0]?.id || '', kind: 'bono' as Adjustment['kind'], concept: '', amount: '', recurrence: 'unico' as Adjustment['recurrence'],
    apply_date: todayStr(), start_date: todayStr(), end_date: '', total_amount: '',
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const isLoan = form.kind === 'prestamo';
  const recurrence = isLoan ? 'cada_periodo' : form.recurrence;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api('/rh/adjustments', {
        method: 'POST',
        body: {
          employee_id: form.employee_id, kind: form.kind, concept: form.concept, amount: Number(form.amount), recurrence,
          apply_date: recurrence === 'unico' ? form.apply_date : null,
          start_date: recurrence === 'cada_periodo' ? form.start_date : null,
          end_date: recurrence === 'cada_periodo' && form.end_date ? form.end_date : null,
          total_amount: isLoan ? Number(form.total_amount) : null,
        },
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return (
    <Modal title="Nuevo bono, descuento o préstamo" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Empleado">
          <select className="input" value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })}>
            {employees.map((x) => <option key={x.id} value={x.id}>{x.full_name}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tipo">
            <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Adjustment['kind'] })}>
              {Object.entries(ADJUSTMENT_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Concepto"><input className="input" required value={form.concept} onChange={(e) => setForm({ ...form, concept: e.target.value })} /></Field>
          {isLoan && <Field label="Total prestado ($)"><input className="input" type="number" min="0.01" step="0.01" required value={form.total_amount} onChange={(e) => setForm({ ...form, total_amount: e.target.value })} /></Field>}
          <Field label={isLoan ? 'Abono por periodo ($)' : 'Monto ($)'}><input className="input" type="number" min="0.01" step="0.01" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
        </div>
        {!isLoan && (
          <Field label="Se aplica">
            <select className="input" value={form.recurrence} onChange={(e) => setForm({ ...form, recurrence: e.target.value as Adjustment['recurrence'] })}>
              <option value="unico">Una vez</option>
              <option value="cada_periodo">En cada periodo</option>
            </select>
          </Field>
        )}
        {recurrence === 'unico'
          ? <Field label="En el periodo que incluye el día"><input className="input" type="date" required value={form.apply_date} onChange={(e) => setForm({ ...form, apply_date: e.target.value })} /></Field>
          : (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Desde"><input className="input" type="date" required value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} /></Field>
              {!isLoan && <Field label="Hasta (opcional)"><input className="input" type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} /></Field>}
            </div>
          )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Guardar</Button>
        </div>
      </form>
    </Modal>
  );
}

function HolidaysCard() {
  const { me } = useAdmin();
  const isAdmin = rhCan.admin(me.user.role);
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState<{ official_enabled: boolean; official: Holiday[]; custom: Holiday[] } | null>(null);
  const [form, setForm] = useState({ date: '', name: '' });
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<{ official_enabled: boolean; official: Holiday[]; custom: Holiday[] }>(`/rh/holidays?year=${year}`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [year]);
  useEffect(load, [load]);
  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/rh/holidays', { method: 'POST', body: form });
      setForm({ date: '', name: '' });
      load();
    } catch (err) { setError(errorMessage(err)); }
  }
  async function remove(h: Holiday) {
    try {
      await api(`/rh/holidays/${h.date}`, { method: 'DELETE' });
      load();
    } catch (err) { setError(errorMessage(err)); }
  }
  return (
    <Section title="Días festivos" subtitle="Descanso obligatorio pagado; si se trabaja se paga el factor adicional."
      actions={<select className="input w-auto py-1.5" value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Año">
        {[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}
      </select>}>
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      {!data ? <Spinner /> : (
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-semibold text-white">Oficiales (LFT art. 74){!data.official_enabled && <span className="ml-2 text-xs text-amber-300">desactivados</span>}</h3>
            <ul className="space-y-1 text-sm text-gray-300">
              {data.official.map((h) => <li key={h.date} className="flex justify-between gap-3"><span>{h.name}</span><span className="text-gray-500">{formatDay(h.date)}</span></li>)}
            </ul>
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-white">Del restaurante</h3>
            <ul className="mb-3 space-y-1 text-sm text-gray-300">
              {data.custom.length === 0 && <li className="text-gray-500">Ninguno.</li>}
              {data.custom.map((h) => (
                <li key={h.date} className="flex items-center justify-between gap-3">
                  <span>{h.name} <span className="text-gray-500">· {formatDay(h.date)}</span></span>
                  {isAdmin && <button className="rounded-lg p-1 text-gray-400 hover:text-red-300" onClick={() => remove(h)} aria-label="Quitar"><Trash2 className="h-4 w-4" /></button>}
                </li>
              ))}
            </ul>
            {isAdmin && (
              <form onSubmit={add} className="flex flex-wrap gap-2">
                <input className="input w-40 py-1.5" type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} aria-label="Fecha" />
                <input className="input flex-1 py-1.5" required placeholder="Nombre" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                <Button type="submit" variant="secondary">Agregar</Button>
              </form>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

function ClockSettingsCard() {
  const [rows, setRows] = useState<ClockSettings[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<ClockSettings | null>(null);
  const load = useCallback(() => {
    api<{ branches: ClockSettings[] }>('/rh/clock-settings').then((r) => setRows(r.branches)).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);
  return (
    <Section title="Checador por sucursal" subtitle="Opcional: limitar desde dónde se puede checar (ubicación del dispositivo o red del local).">
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      {!rows ? <Spinner /> : (
        <ul className="divide-y divide-gray-800 text-sm">
          {rows.map((b) => (
            <li key={b.branch_id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <div>
                <div className="text-white">{b.branch_name}</div>
                <div className="text-xs text-gray-500">
                  {b.geo_enabled ? `Geocerca de ${b.radius_meters} m` : 'Sin geocerca'} · {b.allowed_ips.length ? `IPs: ${b.allowed_ips.join(', ')}` : 'Cualquier red'}
                </div>
              </div>
              <Button variant="secondary" onClick={() => setEditing(b)}>Configurar</Button>
            </li>
          ))}
        </ul>
      )}
      {editing && <ClockModal settings={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </Section>
  );
}

function ClockModal({ settings, onClose, onSaved }: { settings: ClockSettings; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    geo_enabled: settings.geo_enabled, latitude: settings.latitude || '', longitude: settings.longitude || '',
    radius_meters: String(settings.radius_meters), allowed_ips: settings.allowed_ips.join('\n'),
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  function here() {
    navigator.geolocation?.getCurrentPosition(
      (p) => setForm((f) => ({ ...f, latitude: p.coords.latitude.toFixed(6), longitude: p.coords.longitude.toFixed(6) })),
      () => setError('No se pudo obtener la ubicación de este dispositivo'),
    );
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api(`/rh/clock-settings/${settings.branch_id}`, {
        method: 'PUT',
        body: {
          geo_enabled: form.geo_enabled, latitude: form.latitude || null, longitude: form.longitude || null,
          radius_meters: Number(form.radius_meters), allowed_ips: form.allowed_ips.split(/[\s,]+/).filter(Boolean),
        },
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return (
    <Modal title={`Checador · ${settings.branch_name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <label className="flex items-center gap-3 text-sm text-gray-300">
          <Toggle label="Geocerca" checked={form.geo_enabled} onChange={(v) => setForm({ ...form, geo_enabled: v })} /> Exigir ubicación dentro del radio
        </label>
        {form.geo_enabled && (
          <div className="grid grid-cols-3 gap-3">
            <Field label="Latitud"><input className="input" value={form.latitude} onChange={(e) => setForm({ ...form, latitude: e.target.value })} /></Field>
            <Field label="Longitud"><input className="input" value={form.longitude} onChange={(e) => setForm({ ...form, longitude: e.target.value })} /></Field>
            <Field label="Radio (m)"><input className="input" type="number" min="10" value={form.radius_meters} onChange={(e) => setForm({ ...form, radius_meters: e.target.value })} /></Field>
            <div className="col-span-3"><Button type="button" variant="ghost" onClick={here}>Usar la ubicación de este dispositivo</Button></div>
          </div>
        )}
        <Field label="IPs permitidas (opcional)" hint="Una por renglón: IP exacta o rango como 192.168.1.0/24. Vacío = cualquier red.">
          <textarea className="input font-mono text-xs" rows={3} value={form.allowed_ips} onChange={(e) => setForm({ ...form, allowed_ips: e.target.value })} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Guardar</Button>
        </div>
      </form>
    </Modal>
  );
}

function AreasCard() {
  const [areas, setAreas] = useState<Area[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<{ areas: Area[] }>('/rh/areas').then((r) => setAreas(r.areas)).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);
  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/rh/areas', { method: 'POST', body: { name } });
      setName('');
      load();
    } catch (err) { setError(errorMessage(err)); }
  }
  async function remove(a: Area) {
    if (!window.confirm(`¿Quitar el área "${a.name}"?`)) return;
    try {
      await api(`/rh/areas/${a.id}`, { method: 'DELETE' });
      load();
    } catch (err) { setError(errorMessage(err)); }
  }
  return (
    <Section title="Áreas" subtitle="Cocina, piso, barra… para agrupar a los empleados.">
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      {!areas ? <Spinner /> : (
        <div className="flex flex-wrap gap-2">
          {areas.map((a) => (
            <span key={a.id} className="inline-flex items-center gap-1 rounded-full bg-gray-800 px-3 py-1 text-sm text-gray-200">
              {a.name} <span className="text-xs text-gray-500">({a.employees})</span>
              <button className="ml-1 text-gray-500 hover:text-red-300" onClick={() => remove(a)} aria-label={`Quitar ${a.name}`}><Trash2 className="h-3.5 w-3.5" /></button>
            </span>
          ))}
        </div>
      )}
      <form onSubmit={add} className="mt-3 flex gap-2">
        <input className="input max-w-xs py-1.5" required placeholder="Nueva área" value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" variant="secondary">Agregar</Button>
      </form>
    </Section>
  );
}
