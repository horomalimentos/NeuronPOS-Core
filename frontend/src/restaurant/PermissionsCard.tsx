import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { ROLE_LABEL } from '../lib/format';
import type { Role } from '../lib/types';

interface Matrix {
  capabilities: { key: string; label: string; defaults: string[] }[];
  roles: Record<string, string[]>;
}
const ROLES: Role[] = ['gerente', 'cajero', 'mesero', 'cocina', 'repartidor'];

/**
 * Permisos por rol (como la pantalla de Permisos de Horom): que puede hacer
 * cada rol en el punto de venta. Solo el administrador los cambia; el
 * administrador siempre puede todo.
 */
export default function PermissionsCard({ isAdmin }: { isAdmin: boolean }) {
  const [m, setM] = useState<Matrix | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');
  useEffect(() => {
    api<Matrix>('/permissions').then(setM).catch((e) => setError(errorMessage(e)));
  }, []);

  async function toggle(role: Role, capability: string, allowed: boolean | null) {
    setSaving(`${role}:${capability}`);
    setError('');
    try {
      setM(await api<Matrix>('/permissions', { method: 'PUT', body: { role, capability, allowed } }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving('');
    }
  }

  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold text-white">Permisos por rol</h2>
      <p className="mb-3 text-sm text-gray-400">Qué puede hacer cada rol en el punto de venta. El administrador siempre puede todo.{!isAdmin && ' Solo un administrador puede cambiarlos.'}</p>
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      {!m ? <Spinner /> : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
              <tr><th className="px-4 py-3 font-medium">Permiso</th>{ROLES.map((r) => <th key={r} className="px-3 py-3 text-center font-medium">{ROLE_LABEL[r]}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {m.capabilities.map((c) => (
                <tr key={c.key}>
                  <td className="px-4 py-2.5 text-gray-200">{c.label}</td>
                  {ROLES.map((r) => {
                    const on = m.roles[r]?.includes(c.key);
                    const custom = on !== c.defaults.includes(r);
                    return (
                      <td key={r} className="px-3 py-2.5 text-center">
                        <div className="inline-flex items-center gap-1">
                          <input type="checkbox" className="h-4 w-4 accent-current" checked={Boolean(on)} disabled={!isAdmin || saving === `${r}:${c.key}`}
                            onChange={(e) => toggle(r, c.key, e.target.checked)} aria-label={`${c.label} para ${ROLE_LABEL[r]}`} />
                          {custom && isAdmin && (
                            <button className="text-amber-300 hover:text-white" onClick={() => toggle(r, c.key, null)} title="Volver al valor por omisión" aria-label="Volver al valor por omisión">
                              <RotateCcw className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-gray-500">Los cambios aplican de inmediato; el usuario los ve al recargar su pantalla. La flecha amarilla regresa un permiso a su valor original.</p>
    </section>
  );
}
