import { MapPinned, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import ZoneMap, { MapTools, type Point } from '../components/ZoneMap';
import { Alert, Button, Field, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import type { DeliveryZone } from '../site/types';

interface Row { radius_km: string; fee: string }

const DEFAULT_ROWS: Row[] = [{ radius_km: '2', fee: '30' }, { radius_km: '4', fee: '45' }];

/**
 * Zona de entrega de una sucursal (modulo 'zonas_entrega'): centro en el
 * mapa, tramos de distancia con su tarifa y pedido minimo a domicilio.
 */
export default function ZoneEditor({ branch, zone, onSaved }: {
  branch: { id: string; name: string; address: string | null };
  zone: DeliveryZone | null;
  onSaved: (z: DeliveryZone | null) => void;
}) {
  const [center, setCenter] = useState<Point | null>(zone?.center ?? null);
  const [rows, setRows] = useState<Row[]>(zone ? zone.tiers.map((t) => ({ radius_km: String(t.radius_km), fee: String(t.fee) })) : DEFAULT_ROWS);
  const [minOrder, setMinOrder] = useState(String(zone?.min_order ?? 0));
  const [active, setActive] = useState(zone?.active ?? true);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const tiers = rows.map((r) => ({ radius_km: Number(r.radius_km), fee: Number(r.fee) })).filter((t) => t.radius_km > 0);
  const touch = () => setSaved(false);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ zone: DeliveryZone }>(`/online/branches/${branch.id}/zone`, {
        method: 'PUT',
        body: { center, tiers: rows.map((x) => ({ radius_km: Number(x.radius_km), fee: Number(x.fee) })), min_order: Number(minOrder || 0), active },
      });
      setRows(r.zone.tiers.map((t) => ({ radius_km: String(t.radius_km), fee: String(t.fee) })));
      onSaved(r.zone);
      setSaved(true);
    } catch (e) { setError(errorMessage(e)); }
    setBusy(false);
  };
  const remove = async () => {
    if (!window.confirm(`¿Quitar la zona de ${branch.name}? Se vuelve a cobrar el costo de envío fijo.`)) return;
    setBusy(true);
    try {
      await api(`/online/branches/${branch.id}/zone`, { method: 'DELETE' });
      onSaved(null);
      setCenter(null);
      setRows(DEFAULT_ROWS);
    } catch (e) { setError(errorMessage(e)); }
    setBusy(false);
  };

  return (
    <div className="card space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-semibold text-white"><MapPinned className="h-4 w-4 text-brand" /> {branch.name}</h3>
        {zone && (
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <Toggle label="Zona activa" checked={active} onChange={(v) => { setActive(v); touch(); }} /> Activa
          </label>
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-2">
          <MapTools onPoint={(p) => { setCenter(p); touch(); }} near={center} initialQuery={branch.address || ''} />
          <ZoneMap className="h-72" center={center} tiers={tiers} onPick={(p) => { setCenter(p); touch(); }} />
          <p className="text-xs text-gray-500">{center ? 'Toca el mapa para mover el centro (normalmente, la sucursal).' : 'Busca la dirección de la sucursal o toca el mapa para poner el centro.'}</p>
        </div>
        <div className="space-y-3">
          <p className="text-sm font-medium text-gray-300">Tramos (en línea recta desde el centro)</p>
          {rows.map((r, i) => (
            <div key={i} className="flex items-end gap-2">
              <Field label={i === 0 ? 'Hasta (km)' : ''}>
                <input className="input" type="number" min="0.1" max="50" step="0.1" value={r.radius_km}
                  onChange={(e) => { setRows(rows.map((x, j) => (j === i ? { ...x, radius_km: e.target.value } : x))); touch(); }} />
              </Field>
              <Field label={i === 0 ? 'Envío ($)' : ''}>
                <input className="input" type="number" min="0" step="1" value={r.fee}
                  onChange={(e) => { setRows(rows.map((x, j) => (j === i ? { ...x, fee: e.target.value } : x))); touch(); }} />
              </Field>
              <button type="button" className="mb-2.5 text-gray-500 hover:text-red-400 disabled:opacity-30" disabled={rows.length === 1}
                onClick={() => { setRows(rows.filter((_, j) => j !== i)); touch(); }} aria-label="Quitar tramo"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
          {rows.length < 10 && (
            <Button type="button" variant="ghost" className="px-2" onClick={() => {
              const last = rows[rows.length - 1];
              setRows([...rows, { radius_km: String(Number(last?.radius_km || 0) + 2), fee: String(Number(last?.fee || 0) + 15) }]);
              touch();
            }}><Plus className="h-4 w-4" /> Agregar tramo</Button>
          )}
          <Field label="Pedido mínimo a domicilio ($)" hint="0 = el mínimo general.">
            <input className="input" type="number" min="0" step="1" value={minOrder} onChange={(e) => { setMinOrder(e.target.value); touch(); }} />
          </Field>
          {tiers.length > 0 && (
            <p className="text-xs text-gray-500">Fuera de {Math.max(...tiers.map((t) => t.radius_km))} km no se aceptan pedidos. {tiers.map((t) => `≤${t.radius_km} km: ${formatMXN(t.fee)}`).join(' · ')}</p>
          )}
          {error && <Alert>{error}</Alert>}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {saved && <span className="text-sm text-emerald-300">Guardado</span>}
            {zone && <Button type="button" variant="ghost" onClick={() => void remove()} disabled={busy}>Quitar zona</Button>}
            <Button type="button" onClick={() => void save()} loading={busy} disabled={!center}>Guardar zona</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
