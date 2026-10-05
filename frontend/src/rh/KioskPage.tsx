import { CheckCircle2, Delete, LogIn, LogOut, MapPin, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import BranchSelect from '../pos/BranchSelect';
import { usePosBranch } from '../pos/usePosBranch';
import type { KioskEmployee } from './types';

interface KioskData {
  branch: { id: string; name: string; timezone: string };
  employees: KioskEmployee[];
  restriction: { geo_enabled: boolean; ip_restricted: boolean };
}

interface ClockResult {
  entry: { id: string; kind: 'entrada' | 'salida'; occurred_at: string };
  employee_name: string;
  late_minutes: number;
}

/**
 * Checador de la sucursal (kiosco). Se deja abierto en una tableta con la
 * sesion de un gerente o cajero; cada empleado toca su nombre y teclea su NIP.
 */
export default function KioskPage() {
  const { branchId, setBranchId, branches } = usePosBranch();
  const [data, setData] = useState<KioskData | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<KioskEmployee | null>(null);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; title: string; text: string } | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const resetTimer = useRef<ReturnType<typeof setTimeout>>();

  const load = useCallback(() => {
    if (!branchId) return;
    api<KioskData>(`/rh/kiosk/${branchId}`).then((d) => { setData(d); setError(''); }).catch((e) => setError(errorMessage(e)));
  }, [branchId]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const close = () => { setSelected(null); setPin(''); };
  const showResult = (r: { ok: boolean; title: string; text: string }) => {
    setResult(r);
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setResult(null), r.ok ? 4000 : 6000);
  };

  async function position(): Promise<{ latitude: number; longitude: number } | null> {
    if (!data?.restriction.geo_enabled || !navigator.geolocation) return null;
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 10000 },
      );
    });
  }

  async function submit() {
    if (!selected || pin.length < 4) return;
    setBusy(true);
    try {
      const coords = await position();
      const r = await api<ClockResult>('/rh/kiosk/clock', {
        method: 'POST', body: { branch_id: branchId, employee_id: selected.id, pin, ...(coords || {}) }, noRedirect: true,
      });
      const time = new Date(r.entry.occurred_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
      showResult({
        ok: true,
        title: r.entry.kind === 'entrada' ? `¡Bienvenido, ${r.employee_name.split(' ')[0]}!` : `¡Hasta luego, ${r.employee_name.split(' ')[0]}!`,
        text: `${r.entry.kind === 'entrada' ? 'Entrada' : 'Salida'} registrada a las ${time}.${r.late_minutes ? ` Llegaste ${r.late_minutes} min tarde.` : ''}`,
      });
      close();
      load();
    } catch (err) {
      showResult({ ok: false, title: 'No se registró', text: errorMessage(err) });
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  const press = (d: string) => setPin((p) => (p.length < 6 ? p + d : p));

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Checador</h1>
          <p className="text-sm text-gray-400">Toca tu nombre y escribe tu NIP para registrar tu entrada o salida.</p>
        </div>
        <div className="text-right">
          <div className="text-4xl font-semibold tabular-nums text-white">{clock.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}</div>
          <div className="text-sm capitalize text-gray-400">{clock.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
        </div>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <BranchSelect branches={branches} value={branchId} onChange={setBranchId} />
        {data?.restriction.geo_enabled && <span className="inline-flex items-center gap-1 text-xs text-gray-500"><MapPin className="h-3.5 w-3.5" /> Requiere ubicación</span>}
      </div>
      {result && (
        <div className={`mb-6 flex items-center gap-4 rounded-2xl border p-5 ${result.ok ? 'border-emerald-700 bg-emerald-950/60' : 'border-red-800 bg-red-950/60'}`} role="status">
          {result.ok ? <CheckCircle2 className="h-10 w-10 text-emerald-300" /> : <XCircle className="h-10 w-10 text-red-300" />}
          <div>
            <div className="text-xl font-semibold text-white">{result.title}</div>
            <div className="text-sm text-gray-300">{result.text}</div>
          </div>
        </div>
      )}
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {!data ? <Spinner /> : data.employees.length === 0 ? (
        <div className="card p-8 text-center text-sm text-gray-500">No hay empleados con NIP en esta sucursal. Asígnalos en Recursos humanos → Empleados.</div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {data.employees.map((e) => (
            <button key={e.id} onClick={() => { setSelected(e); setPin(''); }}
              className="card flex flex-col items-start gap-1 p-4 text-left transition hover:border-brand">
              <span className="text-base font-semibold text-white">{e.full_name}</span>
              <span className="text-xs text-gray-500">{e.position || ' '}</span>
              <span className={`mt-1 inline-flex items-center gap-1 text-xs ${e.inside ? 'text-emerald-300' : 'text-gray-500'}`}>
                {e.inside ? <><LogIn className="h-3 w-3" /> Dentro</> : <><LogOut className="h-3 w-3" /> Fuera</>}
              </span>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Teclea tu NIP">
          <div className="card w-full max-w-sm p-6">
            <div className="mb-1 text-center text-lg font-semibold text-white">{selected.full_name}</div>
            <div className="mb-4 text-center text-sm text-gray-400">{selected.inside ? 'Registrar salida' : 'Registrar entrada'}</div>
            {result && !result.ok && (
              <div className="mb-4 rounded-xl border border-red-800 bg-red-950/60 p-3 text-center text-sm text-red-200" role="alert">{result.text}</div>
            )}
            <div className="mb-5 flex justify-center gap-2" aria-label="NIP">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <span key={i} className={`h-4 w-4 rounded-full ${i < pin.length ? 'bg-brand' : i < 4 ? 'bg-gray-700' : 'bg-gray-800'}`} />
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button key={d} onClick={() => press(d)} className="rounded-xl bg-gray-800 py-4 text-2xl font-semibold text-white hover:bg-gray-700">{d}</button>
              ))}
              <button onClick={close} className="rounded-xl py-4 text-sm text-gray-400 hover:bg-gray-800">Cancelar</button>
              <button onClick={() => press('0')} className="rounded-xl bg-gray-800 py-4 text-2xl font-semibold text-white hover:bg-gray-700">0</button>
              <button onClick={() => setPin((p) => p.slice(0, -1))} className="flex items-center justify-center rounded-xl py-4 text-gray-400 hover:bg-gray-800" aria-label="Borrar"><Delete className="h-6 w-6" /></button>
            </div>
            <button onClick={submit} disabled={pin.length < 4 || busy}
              className="mt-4 w-full rounded-xl bg-brand py-3.5 text-lg font-semibold text-brand-contrast disabled:opacity-40">
              {busy ? 'Registrando…' : 'Checar'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
