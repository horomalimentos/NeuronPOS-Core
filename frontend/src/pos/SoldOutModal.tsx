import { Search } from 'lucide-react';
import { useState } from 'react';
import { Alert, Modal } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatTime } from './lib';
import type { Menu, MenuItem } from './types';

const DURATIONS: [number | null, string][] = [[30, '30 min'], [60, '1 h'], [120, '2 h'], [240, '4 h'], [null, 'Hasta reactivar']];

/**
 * Agotados de la sucursal (como en Horom): marcar un producto agotado por un
 * rato (vuelve solo a la hora indicada) o hasta reactivarlo.
 */
export default function SoldOutModal({ menu, branchId, onClose, onChanged }: {
  menu: Menu; branchId: string; onClose: () => void; onChanged: (item: MenuItem) => void;
}) {
  const [search, setSearch] = useState('');
  const [picking, setPicking] = useState<string | null>(null);
  const [error, setError] = useState('');
  async function set(it: MenuItem, available: boolean, minutes?: number | null) {
    setError('');
    try {
      const r = await api<{ available: boolean; available_at: string | null }>(`/pos/items/${it.id}/availability`, {
        method: 'PUT', body: { branch_id: branchId, available, minutes: minutes ?? undefined },
      });
      onChanged({ ...it, available: r.available, available_at: r.available_at });
      setPicking(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  const q = search.trim().toLowerCase();
  const items = menu.items.filter((i) => !q || i.name.toLowerCase().includes(q))
    .sort((a, b) => Number(a.available) - Number(b.available) || a.name.localeCompare(b.name));
  return (
    <Modal title="Agotados" onClose={onClose} wide>
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
          <input className="input pl-9" placeholder="Buscar producto" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <ul className="max-h-[60vh] divide-y divide-gray-800 overflow-y-auto text-sm">
          {items.map((it) => (
            <li key={it.id} className="py-2">
              <div className="flex items-center gap-3">
                <span className="flex-1 text-gray-100">{it.name}
                  {!it.available && <span className="block text-xs text-red-300">Agotado{it.available_at ? ` hasta las ${formatTime(it.available_at)}` : ''}</span>}
                </span>
                {it.available
                  ? <button className="rounded-lg bg-gray-800 px-3 py-1.5 text-gray-200 hover:bg-gray-700" onClick={() => setPicking(picking === it.id ? null : it.id)}>Marcar agotado</button>
                  : <button className="rounded-lg bg-emerald-600/20 px-3 py-1.5 text-emerald-200 hover:bg-emerald-600/30" onClick={() => set(it, true)}>Ya hay</button>}
              </div>
              {picking === it.id && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {DURATIONS.map(([m, l]) => (
                    <button key={l} className="rounded-lg border border-red-500/40 px-3 py-1.5 text-xs text-red-200 hover:bg-red-500/10" onClick={() => set(it, false, m)}>{l}</button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
