import { CheckCircle2, ChefHat, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, PageHeader, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { nativeInfo } from '../lib/native';
import { useAdmin } from '../restaurant/context';
import BranchSelect from './BranchSelect';
import { ORDER_TYPE_LABEL, formatTime, minutesSince, posCan } from './lib';
import { comandaHtml, printHtml } from './ticket';
import type { Order } from './types';
import { usePosBranch } from './usePosBranch';

const POLL_MS = 5000;

/**
 * Pantalla de cocina (KDS): ordenes enviadas que aun no estan listas. Se
 * actualiza cada 5 segundos. Los articulos agregados despues de marcar lista
 * aparecen resaltados como nuevos.
 */
export default function KitchenPage() {
  const { me } = useAdmin();
  const { branchId, setBranchId, branches } = usePosBranch();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [marking, setMarking] = useState<string | null>(null);
  const canReady = posCan.kitchenReady(me.user.role);
  // Neuron KDS con impresora de comandas: imprime lo que va llegando (ordenes
  // del POS y pedidos en linea). Lo que ya estaba al abrir no se imprime.
  const seen = useRef<Set<string> | null>(null);
  const [printComandas, setPrintComandas] = useState(false);
  useEffect(() => {
    nativeInfo().then((info) => setPrintComandas(Boolean(info?.mode === 'kds' && info.printers.comanda)));
  }, []);
  useEffect(() => {
    if (!orders) return;
    const live = orders.flatMap((o) => (o.items || []).filter((it) => !it.voided_at).map((it) => ({ o, it })));
    if (!seen.current) { seen.current = new Set(live.map(({ it }) => it.id)); return; }
    const fresh = live.filter(({ it }) => !seen.current!.has(it.id));
    fresh.forEach(({ it }) => seen.current!.add(it.id));
    if (!printComandas || !fresh.length) return;
    const branch = branches.find((b) => b.id === branchId) || null;
    for (const o of new Set(fresh.map((f) => f.o))) {
      void printHtml(comandaHtml(o, fresh.filter((f) => f.o === o).map((f) => f.it), branch), 'comanda');
    }
  }, [orders, printComandas, branches, branchId]);
  useEffect(() => { seen.current = null; }, [branchId]);

  const load = useCallback(() => {
    if (!branchId) return;
    api<{ orders: Order[] }>(`/pos/kitchen?branch_id=${branchId}`)
      .then((r) => { setOrders(r.orders); setError(''); setNow(Date.now()); })
      .catch((e) => setError(errorMessage(e)));
  }, [branchId]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function ready(o: Order) {
    setMarking(o.id);
    try {
      await api(`/pos/orders/${o.id}/ready`, { method: 'POST' });
      setOrders((list) => (list || []).filter((x) => x.id !== o.id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setMarking(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Cocina"
        subtitle="Órdenes enviadas a cocina, de la más antigua a la más reciente."
        actions={<>
          <BranchSelect branches={branches} value={branchId} onChange={setBranchId} />
          <Button variant="secondary" onClick={load}><RefreshCw className="h-4 w-4" /> Actualizar</Button>
        </>}
      />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {!orders ? <Spinner /> : orders.length === 0 ? (
        <div className="py-20 text-center text-gray-500"><ChefHat className="mx-auto mb-3 h-10 w-10" />Sin órdenes pendientes.</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {orders.map((o) => {
            const since = o.items?.filter((i) => i.is_new).map((i) => i.sent_at!).sort()[0] || o.sent_at;
            const mins = minutesSince(since, now);
            const tone = mins >= 20 ? 'border-red-600' : mins >= 10 ? 'border-amber-500' : 'border-gray-700';
            return (
              <article key={o.id} className={`card flex flex-col border-t-4 ${tone}`}>
                <header className="flex items-start justify-between border-b border-gray-800 p-4">
                  <div>
                    <h3 className="text-lg font-bold text-white">
                      {o.order_type === 'comedor' ? `Mesa ${o.table_name}` : ORDER_TYPE_LABEL[o.order_type]}
                      {o.source === 'web' && <span className="ml-2 rounded-full bg-brand/20 px-2 py-0.5 align-middle text-xs font-semibold text-brand">En línea</span>}
                    </h3>
                    <p className="text-xs text-gray-400">Folio {o.folio}{o.customer_name && ` · ${o.customer_name}`}</p>
                  </div>
                  <div className="text-right">
                    <p className={`text-lg font-semibold ${mins >= 20 ? 'text-red-400' : mins >= 10 ? 'text-amber-300' : 'text-gray-200'}`}>{mins} min</p>
                    <p className="text-xs text-gray-500">{formatTime(since)}</p>
                  </div>
                </header>
                <ul className="flex-1 space-y-2 p-4">
                  {o.items?.map((it) => (
                    <li key={it.id} className={it.is_new ? '' : 'opacity-40'}>
                      <div className="flex gap-2 text-base">
                        <span className="font-bold text-white">{it.quantity}×</span>
                        <span className="text-white">{it.name}</span>
                      </div>
                      {it.modifiers.map((m, i) => <div key={i} className="pl-7 text-sm text-gray-300">+ {m.name}</div>)}
                      {it.notes && <div className="pl-7 text-sm italic text-amber-200">{it.notes}</div>}
                    </li>
                  ))}
                  {o.notes && <li className="rounded-lg bg-amber-500/10 p-2 text-sm text-amber-200">{o.notes}</li>}
                </ul>
                {canReady && (
                  <div className="border-t border-gray-800 p-3">
                    <Button className="w-full py-3" onClick={() => ready(o)} loading={marking === o.id}>
                      <CheckCircle2 className="h-5 w-5" /> Lista
                    </Button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
