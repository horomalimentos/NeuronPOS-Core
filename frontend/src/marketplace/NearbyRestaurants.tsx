import { Bike, Clock, MapPin, Store } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import ZoneMap, { MapTools, type Point } from '../components/ZoneMap';
import { Alert, Button, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatMXN } from '../lib/format';
import { locationStore, useStore } from './customer';
import { REASON_LABEL, type NearbyRestaurant } from './lib';

const POLL_MS = 60000;

/** ¿Donde te entregamos? y la lista de restaurantes cercanos. */
export default function NearbyRestaurants() {
  const location = useStore(locationStore);
  const [picking, setPicking] = useState<Point | null>(null);
  const [editing, setEditing] = useState(!location);
  const [list, setList] = useState<NearbyRestaurant[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    if (!location) return;
    api<{ restaurants: NearbyRestaurant[] }>(`/marketplace/restaurants?lat=${location.latitude}&lng=${location.longitude}`, { noRedirect: true })
      .then((r) => { setList(r.restaurants); setError(''); })
      .catch((e) => setError(errorMessage(e)));
  }, [location]);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  if (editing || !location) {
    return (
      <section className="card space-y-3 p-5">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><MapPin className="h-5 w-5 text-brand" /> ¿Dónde te entregamos?</h2>
        <MapTools onPoint={setPicking} near={picking || location} />
        <ZoneMap className="h-56" center={null} tiers={[]} pin={picking || location} onPick={setPicking} />
        <div className="flex justify-end gap-2">
          {location && <Button variant="ghost" onClick={() => setEditing(false)}>Cancelar</Button>}
          <Button disabled={!(picking || location)} onClick={() => { locationStore.set(picking || location); setEditing(false); setPicking(null); }}>
            Ver restaurantes cerca
          </Button>
        </div>
      </section>
    );
  }

  const orderable = (list || []).filter((r) => r.can_order);
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-white">Restaurantes cerca de ti</h2>
        <button type="button" onClick={() => setEditing(true)} className="flex items-center gap-1 text-sm text-gray-400 hover:text-white">
          <MapPin className="h-4 w-4" /> Cambiar ubicación
        </button>
      </div>
      {error && <Alert>{error}</Alert>}
      {!list ? (!error && <Spinner />) : list.length === 0 ? (
        <p className="card p-6 text-center text-sm text-gray-400">Todavía no hay restaurantes de NeuronPOS Delivery cerca de ti.</p>
      ) : (
        <>
          {orderable.length === 0 && list.some((r) => r.reason === 'sin_repartidor') && (
            <div className="mb-3 flex items-center gap-2 rounded-xl border border-amber-700/60 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
              <Bike className="h-5 w-5" /> No hay repartidores conectados en tu zona en este momento. Intenta en unos minutos.
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((r) => <RestaurantCard key={r.branch_id} r={r} />)}
          </div>
        </>
      )}
    </section>
  );
}

function RestaurantCard({ r }: { r: NearbyRestaurant }) {
  const body = (
    <article className={`card h-full overflow-hidden transition ${r.can_order ? 'hover:border-brand/60' : 'opacity-60'}`}>
      <div className="flex h-28 items-center justify-center bg-gradient-to-br from-gray-800 to-gray-900">
        {r.cover_url ? <img src={r.cover_url} alt="" className="h-full w-full object-cover" />
          : r.logo_url ? <img src={r.logo_url} alt="" className="h-16 w-16 rounded-xl object-cover" />
            : <Store className="h-10 w-10 text-gray-600" />}
      </div>
      <div className="space-y-1 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold text-white">{r.name}</h3>
          {!r.can_order && r.reason && <span className="shrink-0 rounded-full bg-gray-800 px-2 py-0.5 text-xs text-gray-300">{REASON_LABEL[r.reason]}</span>}
        </div>
        {(r.cuisine || r.description) && <p className="line-clamp-2 text-sm text-gray-400">{[r.cuisine, r.description].filter(Boolean).join(' · ')}</p>}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-gray-400">
          <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {r.prep_minutes + 15} min aprox.</span>
          {r.delivery_fee !== null && <span>Envío {formatMXN(r.delivery_fee)}</span>}
          {r.distance_km !== null && <span>{r.distance_km.toFixed(1)} km</span>}
        </p>
      </div>
    </article>
  );
  return r.can_order ? <Link to={`/delivery/r/${r.branch_id}`}>{body}</Link> : body;
}
