import { CalendarHeart, Plus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Field, Modal, PageHeader, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDay, formatMXN } from '../lib/format';
import { posCan } from '../pos/lib';
import { useAdmin } from '../restaurant/context';
import { EVENT_STATUS, type SaleEvent } from './types';

/** Ventas por evento y preventas (modulo "eventos"), como en Horom. */
export default function EventsPage() {
  const { me } = useAdmin();
  const [list, setList] = useState<SaleEvent[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => { api<{ events: SaleEvent[] }>('/events').then((r) => setList(r.events)).catch((e) => setError(errorMessage(e))); }, []);
  useEffect(load, [load]);
  return (
    <>
      <PageHeader title="Eventos y preventas" subtitle="Ventas en un centro de trabajo, preventas de fin de semana, carne asada… con página para que el cliente pida."
        actions={posCan.manage(me.user.role) && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Nuevo evento</Button>} />
      {error && <Alert>{error}</Alert>}
      {!list ? <Spinner /> : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.length === 0 && <p className="card p-8 text-center text-sm text-gray-500 md:col-span-2 xl:col-span-3">Todavía no hay eventos.</p>}
          {list.map((e) => (
            <Link key={e.id} to={`/admin/eventos/${e.id}`} className="card p-4 transition hover:border-brand/60">
              <div className="flex items-start justify-between gap-2">
                <h3 className="flex items-center gap-2 font-semibold text-white"><CalendarHeart className="h-4 w-4 text-brand" /> {e.name}</h3>
                <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${EVENT_STATUS[e.status][1]}`}>{EVENT_STATUS[e.status][0]}</span>
              </div>
              <p className="mt-1 text-sm text-gray-400">{formatDay(e.sale_date)}{e.place && ` · ${e.place}`} · {e.branch_name}</p>
              <p className="mt-2 text-sm text-gray-300">{e.orders} pedido(s) · {formatMXN(e.total || 0)}</p>
            </Link>
          ))}
        </div>
      )}
      {creating && <EventModal onClose={() => setCreating(false)} />}
    </>
  );
}

export function EventModal({ event, onClose, onSaved }: { event?: SaleEvent; onClose: () => void; onSaved?: (e: SaleEvent) => void }) {
  const { me } = useAdmin();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: event?.name || '', place: event?.place || '', description: event?.description || '',
    sale_date: event?.sale_date || '', branch_id: event?.branch_id || me.branches[0]?.id || '',
    order_deadline: event?.order_deadline ? new Date(event.order_deadline).toISOString().slice(0, 16) : '',
    commission_pct: event ? String(Number(event.commission_pct)) : '0', slug: event?.slug || '',
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = {
        name: form.name, place: form.place || null, description: form.description || null, sale_date: form.sale_date,
        order_deadline: form.order_deadline ? new Date(form.order_deadline).toISOString() : null,
        commission_pct: Number(form.commission_pct || 0), ...(event ? { slug: form.slug } : { branch_id: form.branch_id }),
      };
      const r = await api<{ event: SaleEvent }>(event ? `/events/${event.id}` : '/events', { method: event ? 'PATCH' : 'POST', body });
      if (event) onSaved?.(r.event);
      else navigate(`/admin/eventos/${r.event.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return (
    <Modal title={event ? 'Editar evento' : 'Nuevo evento'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Nombre"><input className="input" required maxLength={120} value={form.name} onChange={set('name')} placeholder="Ej. Carne asada Planta Norte" /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Fecha de la venta"><input type="date" className="input" required value={form.sale_date} onChange={set('sale_date')} /></Field>
          <Field label="Pedidos hasta (opcional)"><input type="datetime-local" className="input" value={form.order_deadline} onChange={set('order_deadline')} /></Field>
          <Field label="Lugar (opcional)"><input className="input" maxLength={200} value={form.place} onChange={set('place')} placeholder="Ej. Comedor de la planta" /></Field>
          <Field label="Comisión del vendedor (%)"><input type="number" min="0" max="100" step="0.5" className="input" value={form.commission_pct} onChange={set('commission_pct')} /></Field>
          {!event && me.branches.length > 1 && (
            <Field label="Sucursal que prepara">
              <select className="input" value={form.branch_id} onChange={set('branch_id')}>{me.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
            </Field>
          )}
          {event && <Field label="Dirección de la página" hint={`/evento/${form.slug}`}><input className="input" value={form.slug} onChange={set('slug')} /></Field>}
        </div>
        <Field label="Descripción (sale en la página)"><textarea className="input min-h-20" maxLength={2000} value={form.description} onChange={set('description')} /></Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>{event ? 'Guardar' : 'Crear y agregar productos'}</Button>
        </div>
      </form>
    </Modal>
  );
}
