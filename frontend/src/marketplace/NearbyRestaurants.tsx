import { Bike, Clock, MapPin, Search, Store, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import ZoneMap, { MapTools, type Point } from '../components/ZoneMap';
import { Alert, Button, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useNayoLive } from '../lib/live';
import { locationStore, useStore } from './customer';
import { CUISINE_EMOJI, etaText, REASON_LABEL, type NearbyRestaurant } from './lib';
import { nayoPath } from './nayoUrl';

const POLL_MS = 60000;

/** Sin acentos ni mayusculas, para buscar "cafeteria" y encontrar "Cafetería". */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * ¿Donde te entregamos? y los restaurantes cercanos, como en las apps de
 * reparto: buscador, filtros por tipo de comida y tarjetas con foto.
 */
export default function NearbyRestaurants() {
  const location = useStore(locationStore);
  const [picking, setPicking] = useState<Point | null>(null);
  const [editing, setEditing] = useState(!location);
  const [list, setList] = useState<NearbyRestaurant[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [cuisine, setCuisine] = useState<string | null>(null);

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
  // Al instante cuando un repartidor se conecta o desconecta (la consulta cada minuto queda de respaldo).
  useNayoLive(load);

  // Al abrir "¿Dónde te entregamos?", el mapa se pone solo en tu ubicación
  // (si el navegador da permiso; si no, queda como estaba).
  useEffect(() => {
    if (!(editing || !location) || picking || !navigator.geolocation) return undefined;
    let alive = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => { if (alive) setPicking((cur) => cur ?? { latitude: pos.coords.latitude, longitude: pos.coords.longitude }); },
      () => {},
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
    return () => { alive = false; };
    // Solo al abrir el selector, no cada que se mueve el pin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, location]);

  const cuisines = useMemo(() => [...new Set((list || []).map((r) => r.cuisine).filter((c): c is string => Boolean(c)))].sort(), [list]);
  const shown = useMemo(() => {
    const q = fold(query.trim());
    return (list || []).filter((r) => (!cuisine || r.cuisine === cuisine)
      && (!q || fold([r.name, r.cuisine, r.description].filter(Boolean).join(' ')).includes(q)));
  }, [list, query, cuisine]);

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

  const open = shown.filter((r) => r.can_order);
  const closed = shown.filter((r) => !r.can_order);
  return (
    <section className="space-y-5">
      <div className="space-y-3">
        <button type="button" onClick={() => setEditing(true)}
          className="inline-flex max-w-full items-center gap-2 rounded-full bg-gray-800/80 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700">
          <MapPin className="h-4 w-4 shrink-0 text-brand" /> <span className="truncate">Entregar en tu ubicación</span>
          <span className="font-semibold text-brand">Cambiar</span>
        </button>
        <label className="relative block">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-500" />
          <input className="w-full rounded-full border border-gray-800 bg-gray-900 py-3 pl-12 pr-10 text-white placeholder:text-gray-500 focus:border-brand focus:outline-none"
            value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Busca restaurantes o comida" aria-label="Buscar" />
          {query && (
            <button type="button" onClick={() => setQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-gray-400 hover:text-white" aria-label="Borrar búsqueda">
              <X className="h-4 w-4" />
            </button>
          )}
        </label>
        {cuisines.length > 1 && (
          <div className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 pb-1">
            <CuisineChip label="Todo" emoji="🍽️" active={!cuisine} onClick={() => setCuisine(null)} />
            {cuisines.map((c) => <CuisineChip key={c} label={c} emoji={CUISINE_EMOJI[c] || '🍴'} active={cuisine === c} onClick={() => setCuisine(cuisine === c ? null : c)} />)}
          </div>
        )}
      </div>

      {error && <Alert>{error}</Alert>}
      {!list ? (!error && <Spinner />) : list.length === 0 ? (
        <p className="card p-6 text-center text-sm text-gray-400">Todavía no hay restaurantes de Nayo cerca de ti.</p>
      ) : (
        <>
          {list.every((r) => !r.can_order) && list.some((r) => r.reason === 'sin_repartidor') && (
            <div className="flex items-center gap-2 rounded-xl border border-amber-700/60 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
              <Bike className="h-5 w-5" /> No hay repartidores conectados en tu zona en este momento. Intenta en unos minutos.
            </div>
          )}
          {shown.length === 0 && <p className="py-6 text-center text-sm text-gray-400">No encontramos nada con esa búsqueda.</p>}
          {open.length > 0 && (
            <div>
              <h2 className="mb-3 text-xl font-bold text-white">{cuisine || 'Restaurantes cerca de ti'}</h2>
              <div className="grid gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
                {open.map((r) => <RestaurantCard key={r.branch_id} r={r} />)}
              </div>
            </div>
          )}
          {closed.length > 0 && (
            <div>
              <h2 className="mb-3 text-lg font-semibold text-gray-400">No disponibles por ahora</h2>
              <div className="grid gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
                {closed.map((r) => <RestaurantCard key={r.branch_id} r={r} />)}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function CuisineChip({ label, emoji, active, onClick }: { label: string; emoji: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className="flex w-16 shrink-0 flex-col items-center gap-1">
      <span className={`flex h-14 w-14 items-center justify-center rounded-full text-2xl transition ${active ? 'bg-brand ring-2 ring-brand ring-offset-2 ring-offset-gray-950' : 'bg-gray-800 hover:bg-gray-700'}`}>{emoji}</span>
      <span className={`w-full truncate text-center text-xs ${active ? 'font-semibold text-white' : 'text-gray-400'}`}>{label}</span>
    </button>
  );
}

/** Portada del restaurante: su foto de portada, o las fotos de sus platillos. */
export function RestaurantCover({ r, className = '' }: { r: NearbyRestaurant; className?: string }) {
  const photos = r.photos || [];
  if (r.cover_url) return <img src={r.cover_url} alt="" className={`h-full w-full object-cover ${className}`} loading="lazy" />;
  if (photos.length >= 3) {
    return (
      <div className={`grid h-full w-full grid-cols-3 grid-rows-2 gap-0.5 ${className}`}>
        <img src={photos[0]} alt="" className="col-span-2 row-span-2 h-full w-full object-cover" loading="lazy" />
        <img src={photos[1]} alt="" className="h-full w-full object-cover" loading="lazy" />
        <img src={photos[2]} alt="" className="h-full w-full object-cover" loading="lazy" />
      </div>
    );
  }
  if (photos.length) return <img src={photos[0]} alt="" className={`h-full w-full object-cover ${className}`} loading="lazy" />;
  return (
    <div className={`flex h-full w-full items-center justify-center bg-gradient-to-br from-gray-800 to-gray-900 ${className}`}>
      {r.logo_url ? <img src={r.logo_url} alt="" className="h-20 w-20 rounded-2xl object-cover" /> : <Store className="h-12 w-12 text-gray-600" />}
    </div>
  );
}

function RestaurantCard({ r }: { r: NearbyRestaurant }) {
  const body = (
    <article className={`group ${r.can_order ? '' : 'opacity-60 grayscale-[40%]'}`}>
      <div className="relative aspect-[16/9] overflow-hidden rounded-2xl bg-gray-900">
        <div className={`h-full w-full transition duration-300 ${r.can_order ? 'group-hover:scale-105' : ''}`}><RestaurantCover r={r} /></div>
        {!r.can_order && r.reason && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <span className="rounded-full bg-gray-950/90 px-3 py-1 text-sm font-semibold text-white">{REASON_LABEL[r.reason]}</span>
          </div>
        )}
      </div>
      <div className="mt-2 flex items-start gap-3">
        {r.logo_url && <img src={r.logo_url} alt="" className="relative -mt-7 h-12 w-12 shrink-0 rounded-full border-2 border-gray-950 object-cover shadow-lg" />}
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-bold text-white">{r.name}</h3>
          <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-gray-400">
            {r.cuisine && <span>{CUISINE_EMOJI[r.cuisine] || ''} {r.cuisine}</span>}
            {r.cuisine && <span aria-hidden>·</span>}
            <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {etaText(r.prep_minutes)}</span>
            {r.distance_km !== null && <><span aria-hidden>·</span><span>{r.distance_km.toFixed(1)} km</span></>}
          </p>
          {r.description && <p className="truncate text-xs text-gray-500">{r.description}</p>}
        </div>
      </div>
    </article>
  );
  return r.can_order ? <Link to={nayoPath(`/r/${r.branch_id}`)} className="block">{body}</Link> : body;
}
