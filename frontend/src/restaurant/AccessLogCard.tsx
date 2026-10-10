import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Spinner } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime } from '../pos/lib';

interface Entry { id: string; user_name: string | null; email: string; result: 'ok' | 'contrasena' | 'desactivada'; ip: string | null; user_agent: string | null; created_at: string }
const RESULT = { ok: ['Entró', 'text-emerald-300'], contrasena: ['Contraseña incorrecta', 'text-red-300'], desactivada: ['Cuenta desactivada', 'text-amber-300'] } as const;

/** Usuarios: bitacora de inicios de sesion (correctos y fallidos). */
export default function AccessLogCard() {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [log, setLog] = useState<Entry[] | null>(null);
  useEffect(() => {
    if (!open) return;
    setLog(null);
    api<{ log: Entry[] }>(`/users/access-log${failed ? '?failed=1' : ''}`).then((r) => setLog(r.log)).catch(() => setLog([]));
  }, [open, failed]);
  const device = (ua: string | null) => (ua ? (/\(([^)]*)\)/.exec(ua)?.[1] || ua).slice(0, 60) : '—');
  return (
    <section className="card mt-6 p-5">
      <button className="flex w-full items-center justify-between text-left" onClick={() => setOpen(!open)}>
        <h2 className="flex items-center gap-2 font-semibold text-white"><ShieldCheck className="h-5 w-5 text-brand" /> Bitácora de accesos</h2>
        <span className="text-sm text-brand">{open ? 'Ocultar' : 'Ver'}</span>
      </button>
      {open && (
        <div className="mt-3">
          <label className="mb-2 flex items-center gap-2 text-sm text-gray-300"><input type="checkbox" checked={failed} onChange={(e) => setFailed(e.target.checked)} /> Solo intentos fallidos</label>
          {!log ? <Spinner /> : (
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-gray-800">
                  {log.length === 0 && <tr><td className="py-4 text-center text-gray-500">Sin registros.</td></tr>}
                  {log.map((l) => (
                    <tr key={l.id}>
                      <td className="whitespace-nowrap py-2 pr-3 text-gray-400">{formatDateTime(l.created_at)}</td>
                      <td className="py-2 pr-3 text-white">{l.user_name || l.email}</td>
                      <td className={`whitespace-nowrap py-2 pr-3 ${RESULT[l.result][1]}`}>{RESULT[l.result][0]}</td>
                      <td className="py-2 pr-3 text-xs text-gray-500">{l.ip} · {device(l.user_agent)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
