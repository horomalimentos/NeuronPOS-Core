import { Gift, KeyRound, Plus, Search, Settings2, Users } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Modal, PageHeader, Spinner, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDate, formatMXN } from '../lib/format';
import { formatDateTime } from '../pos/lib';
import { Stat } from '../pos/ReportsPage';
import { canManage, useAdmin } from '../restaurant/context';
import CustomerPicker from './CustomerPicker';
import { KIND_LABEL, fmtPoints, type CustomerDetail, type LoyaltyCustomer, type LoyaltySettings } from './types';

interface Stats {
  customers: number; with_account: number; new_this_month: number; points_outstanding: number; points_outstanding_value: number;
  last_30_days: { earned: number; redeemed: number; redeemed_amount: number };
}

const SORTS = [
  ['recientes', 'Recientes'], ['compras', 'Más compras'], ['puntos', 'Más puntos'], ['ultima', 'Última compra'], ['nombre', 'Nombre'],
] as const;

/** Clientes del restaurante (fichas, historial y puntos) y ajustes del programa de lealtad. */
export default function CustomersPage() {
  const { me } = useAdmin();
  const manager = canManage(me.user.role);
  const [tab, setTab] = useState<'clientes' | 'programa'>('clientes');
  const [list, setList] = useState<LoyaltyCustomer[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('recientes');
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api<{ customers: LoyaltyCustomer[] }>(`/loyalty/customers?limit=200&sort=${sort}&q=${encodeURIComponent(q.trim())}`)
      .then((r) => setList(r.customers)).catch((e) => setError(errorMessage(e)));
    if (manager) api<{ stats: Stats }>('/loyalty/stats').then((r) => setStats(r.stats)).catch(() => {});
  }, [q, sort, manager]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <>
      <PageHeader title="Clientes" subtitle="Quién te compra, cuánto y sus puntos."
        actions={tab === 'clientes' && <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Nuevo cliente</Button>} />
      {manager && (
        <div className="mb-6 flex gap-1 border-b border-gray-800">
          {([['clientes', 'Clientes', Users], ['programa', 'Programa de puntos', Settings2]] as const).map(([k, label, Icon]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm ${tab === k ? 'border-brand text-white' : 'border-transparent text-gray-400 hover:text-white'}`}>
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>
      )}
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}

      {tab === 'programa' ? <ProgramSettings /> : (
        <>
          {stats && (
            <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Clientes" value={fmtPoints(stats.customers)} extra={<span className="text-xs text-gray-500">{stats.with_account} con cuenta en el sitio · {stats.new_this_month} nuevos este mes</span>} />
              <Stat label="Puntos por canjear" value={fmtPoints(stats.points_outstanding)} extra={<span className="text-xs text-gray-500">valen {formatMXN(stats.points_outstanding_value)}</span>} />
              <Stat label="Puntos ganados (30 días)" value={fmtPoints(stats.last_30_days.earned)} />
              <Stat label="Canjeado (30 días)" value={formatMXN(stats.last_30_days.redeemed_amount)} extra={<span className="text-xs text-gray-500">{fmtPoints(stats.last_30_days.redeemed)} puntos</span>} />
            </div>
          )}
          <section className="card overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 border-b border-gray-800 p-3">
              <label className="relative min-w-[12rem] flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
                <input className="input pl-9" placeholder="Nombre, teléfono o correo" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar cliente" />
              </label>
              <select className="input w-auto" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Ordenar">
                {SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            </div>
            {!list ? <Spinner /> : list.length === 0 ? (
              <p className="px-4 py-6 text-sm text-gray-500">{q ? 'Sin resultados.' : 'Todavía no hay clientes. Se agregan en caja al cobrar o cuando se registran en tu sitio.'}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-gray-500">
                      <th className="px-4 py-2 font-medium">Cliente</th>
                      <th className="px-4 py-2 text-right font-medium">Compras</th>
                      <th className="px-4 py-2 text-right font-medium">Gastado</th>
                      <th className="px-4 py-2 text-right font-medium">Última</th>
                      <th className="px-4 py-2 text-right font-medium">Puntos</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/70">
                    {list.map((c) => (
                      <tr key={c.id} className={`cursor-pointer text-gray-200 hover:bg-gray-900/60 ${c.active ? '' : 'opacity-50'}`} onClick={() => setOpenId(c.id)}>
                        <td className="px-4 py-2">
                          <span className="font-medium text-white">{c.name}</span>
                          {c.has_account && <span className="ml-2 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-300">sitio</span>}
                          <span className="block text-xs text-gray-500">{[c.phone, c.email].filter(Boolean).join(' · ')}</span>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">{c.orders}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{formatMXN(c.spent)}</td>
                        <td className="px-4 py-2 text-right text-gray-400">{c.last_order_at ? formatDate(c.last_order_at) : '—'}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtPoints(c.points_balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
      {adding && <CustomerPicker onClose={() => setAdding(false)} onPick={(c) => { setAdding(false); load(); setOpenId(c.id); }} />}
      {openId && <CustomerModal id={openId} manager={manager} onClose={() => setOpenId(null)} onChanged={load} />}
    </>
  );
}

function CustomerModal({ id, manager, onClose, onChanged }: { id: string; manager: boolean; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<CustomerDetail | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [adjust, setAdjust] = useState({ points: '', reason: '' });
  const [form, setForm] = useState({ name: '', phone: '', email: '', notes: '', active: true });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<CustomerDetail>(`/loyalty/customers/${id}`).then(setD).catch((e) => setError(errorMessage(e)));
  }, [id]);

  const run = async (fn: () => Promise<CustomerDetail>) => {
    setBusy(true);
    setError('');
    try { setD(await fn()); onChanged(); return true; } catch (err) { setError(errorMessage(err)); return false; } finally { setBusy(false); }
  };

  const startEdit = () => {
    if (!d) return;
    const c = d.customer;
    setForm({ name: c.name, phone: c.phone || '', email: c.email || '', notes: c.notes || '', active: c.active });
    setEditing(true);
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = { name: form.name, phone: form.phone || null, notes: form.notes || null, active: form.active };
    if (!d?.customer.has_account) body.email = form.email || null;
    if (await run(() => api(`/loyalty/customers/${id}`, { method: 'PATCH', body }))) setEditing(false);
  };
  const doAdjust = async (sign: 1 | -1) => {
    const n = Math.floor(Number(adjust.points));
    if (!n || !adjust.reason.trim()) { setError('Escribe los puntos y el motivo'); return; }
    if (await run(() => api(`/loyalty/customers/${id}/points`, { method: 'POST', body: { points: sign * n, reason: adjust.reason.trim() } }))) {
      setAdjust({ points: '', reason: '' });
    }
  };

  if (!d) return <Modal title="Cliente" onClose={onClose}>{error ? <Alert>{error}</Alert> : <Spinner />}</Modal>;
  const c = d.customer;

  return (
    <Modal title={c.name} onClose={onClose} wide>
      <div className="space-y-5">
        {error && <Alert>{error}</Alert>}
        {editing ? (
          <form onSubmit={save} className="space-y-3">
            <Field label="Nombre"><input className="input" required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Teléfono"><input className="input" type="tel" maxLength={30} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
              <Field label="Correo" hint={c.has_account ? 'Es su usuario del sitio: solo lo cambia el cliente.' : undefined}>
                <input className="input" type="email" maxLength={200} value={form.email} disabled={c.has_account} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </Field>
            </div>
            <Field label="Notas"><textarea className="input" maxLength={1000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Alergias, preferencias…" /></Field>
            <label className="flex items-center gap-3 text-sm text-gray-300"><Toggle checked={form.active} onChange={(v) => setForm({ ...form, active: v })} label="Activo" /> Activo</label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancelar</Button>
              <Button type="submit" loading={busy}>Guardar</Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-start justify-between gap-3 text-sm">
            <div className="text-gray-400">
              <p>{[c.phone, c.email].filter(Boolean).join(' · ') || 'Sin contacto'}</p>
              <p className="text-xs">Cliente desde {formatDate(c.created_at)}{c.has_account ? ' · con cuenta en el sitio' : ''}{c.code_locked ? ' · código bloqueado' : ''}</p>
              {c.notes && <p className="mt-1 text-gray-300">{c.notes}</p>}
            </div>
            {manager && <Button variant="secondary" onClick={startEdit}>Editar</Button>}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[['Compras', String(c.orders)], ['Gastado', formatMXN(c.spent)], ['Puntos', fmtPoints(c.points_balance)], ['Valen', formatMXN(c.points_value)]].map(([k, v]) => (
            <div key={k} className="rounded-xl bg-gray-800/70 p-3"><p className="text-xs text-gray-400">{k}</p><p className="text-lg font-semibold tabular-nums text-white">{v}</p></div>
          ))}
        </div>

        {manager && (
          <div className="flex flex-wrap items-end gap-2 rounded-xl border border-gray-800 p-3">
            <label className="block"><span className="label">Ajustar puntos</span>
              <input className="input w-24" type="number" min="1" step="1" value={adjust.points} onChange={(e) => setAdjust({ ...adjust, points: e.target.value })} /></label>
            <label className="block min-w-[10rem] flex-1"><span className="label">Motivo</span>
              <input className="input" maxLength={200} value={adjust.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} placeholder="Cortesía, corrección…" /></label>
            <Button variant="secondary" onClick={() => doAdjust(1)} disabled={busy}>Sumar</Button>
            <Button variant="secondary" onClick={() => doAdjust(-1)} disabled={busy}>Restar</Button>
          </div>
        )}

        <section>
          <h3 className="mb-2 text-sm font-medium uppercase tracking-wider text-gray-500">Pedidos</h3>
          {d.orders.length === 0 ? <p className="text-sm text-gray-500">Sin pedidos.</p> : (
            <div className="max-h-56 divide-y divide-gray-800/70 overflow-y-auto rounded-xl border border-gray-800 text-sm">
              {d.orders.map((o) => (
                <div key={o.id} className="flex flex-wrap justify-between gap-2 px-3 py-2">
                  <span className="text-gray-200">#{o.folio} · {o.branch_name}{o.source === 'web' ? ' · en línea' : ''}
                    <span className="block text-xs text-gray-500">{formatDateTime(o.paid_at || o.created_at)} · {o.status}</span></span>
                  <span className="text-right tabular-nums text-gray-300">{formatMXN(o.total)}
                    <span className="block text-xs text-gray-500">{[o.points_earned && `+${o.points_earned}`, o.points_redeemed && `−${o.points_redeemed}`].filter(Boolean).join(' / ')}</span></span>
                </div>
              ))}
            </div>
          )}
        </section>
        <section>
          <h3 className="mb-2 text-sm font-medium uppercase tracking-wider text-gray-500">Movimientos de puntos</h3>
          {d.transactions.length === 0 ? <p className="text-sm text-gray-500">Sin movimientos.</p> : (
            <div className="max-h-56 divide-y divide-gray-800/70 overflow-y-auto rounded-xl border border-gray-800 text-sm">
              {d.transactions.map((t) => (
                <div key={t.id} className="flex justify-between gap-2 px-3 py-2">
                  <span className="text-gray-200">{KIND_LABEL[t.kind]}
                    <span className="block text-xs text-gray-500">{[formatDateTime(t.created_at), t.reason, t.created_by_name].filter(Boolean).join(' · ')}</span></span>
                  <span className="text-right tabular-nums">
                    <span className={t.points < 0 ? 'text-red-300' : 'text-emerald-300'}>{t.points > 0 ? '+' : ''}{fmtPoints(t.points)}</span>
                    <span className="block text-xs text-gray-500">quedan {fmtPoints(t.balance_after)}</span></span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}

function ProgramSettings() {
  const [s, setS] = useState<LoyaltySettings | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ settings: LoyaltySettings }>('/loyalty/settings').then((r) => setS(r.settings)).catch((e) => setError(errorMessage(e)));
  }, []);
  if (!s) return error ? <Alert>{error}</Alert> : <Spinner />;
  const set = (patch: Partial<LoyaltySettings>) => { setS({ ...s, ...patch }); setSaved(false); };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ settings: LoyaltySettings }>('/loyalty/settings', { method: 'PATCH', body: s });
      setS(r.settings);
      setSaved(true);
    } catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  };
  const pctBack = s.points_per_peso * s.peso_per_point * 100;
  const toggles: [keyof LoyaltySettings, string, string][] = [
    ['earn_enabled', 'Acumular puntos', 'Al cobrar una orden con cliente.'],
    ['earn_on_web', 'También en pedidos en línea', 'Los pedidos de clientes con cuenta en tu sitio.'],
    ['redeem_enabled', 'Canjear en caja', 'Se usan como pago.'],
    ['require_code', 'Pedir el código del cliente', 'Código de 6 dígitos que cambia cada 5 minutos en su cuenta del sitio. Evita que alguien use puntos ajenos.'],
  ];
  return (
    <form onSubmit={save} className="grid gap-6 lg:grid-cols-2">
      <div className="card space-y-4 p-5">
        <Field label="Nombre del programa" hint="Así lo ven tus clientes: Puntos, Estrellas, Amigos de la casa…">
          <input className="input" maxLength={40} required value={s.program_name} onChange={(e) => set({ program_name: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Puntos por cada $1">
            <input className="input" type="number" min="0" step="any" value={s.points_per_peso} onChange={(e) => set({ points_per_peso: Number(e.target.value) })} />
          </Field>
          <Field label="Valor de 1 punto ($)">
            <input className="input" type="number" min="0.0001" step="any" value={s.peso_per_point} onChange={(e) => set({ peso_per_point: Number(e.target.value) })} />
          </Field>
          <Field label="Mínimo para canjear">
            <input className="input" type="number" min="0" step="1" value={s.min_redeem_points} onChange={(e) => set({ min_redeem_points: Number(e.target.value) })} />
          </Field>
          <Field label="Máximo por cuenta" hint="Vacío = sin tope">
            <input className="input" type="number" min="1" step="1" value={s.max_points_per_order ?? ''}
              onChange={(e) => set({ max_points_per_order: e.target.value ? Number(e.target.value) : null })} />
          </Field>
        </div>
        <Alert kind="success">
          <Gift className="mr-1 inline h-4 w-4" />
          El cliente recupera el <b>{pctBack.toLocaleString('es-MX', { maximumFractionDigits: 2 })}%</b> de lo que gasta.
          Con {formatMXN(100)} gana {fmtPoints(Math.floor(100 * s.points_per_peso))} puntos, que valen {formatMXN(Math.floor(100 * s.points_per_peso) * s.peso_per_point)}.
        </Alert>
      </div>
      <div className="card space-y-4 p-5">
        {toggles.map(([k, label, hint]) => (
          <label key={k} className="flex items-center justify-between gap-3 text-sm text-gray-300">
            <span>{label}<span className="block text-xs text-gray-500">{hint}</span></span>
            <Toggle checked={Boolean(s[k])} onChange={(v) => set({ [k]: v } as Partial<LoyaltySettings>)} label={label} />
          </label>
        ))}
        <p className="flex items-start gap-2 text-xs text-gray-500"><KeyRound className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          Si el cliente se equivoca 5 veces el código se bloquea, y él mismo lo renueva desde su cuenta.</p>
        {error && <Alert>{error}</Alert>}
        <div className="flex items-center justify-end gap-3">
          {saved && <span className="text-sm text-emerald-300">Guardado</span>}
          <Button type="submit" loading={busy}>Guardar</Button>
        </div>
      </div>
    </form>
  );
}
