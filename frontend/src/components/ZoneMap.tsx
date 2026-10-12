import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Crosshair, Loader2, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import AddressAutocomplete from './AddressAutocomplete';
import { dotIcon, GOOGLE_MAP_OPTIONS, loadGoogleMaps, useGoogleMaps } from '../lib/googleMaps';

export interface Point { latitude: number; longitude: number }
export interface Tier { radius_km: number; fee: number }

const DEFAULT_CENTER: L.LatLngExpression = [23.6, -102.5];
const TIER_COLORS = ['#16a34a', '#ca8a04', '#ea580c', '#dc2626'];

const dot = (color: string, size = 16) => L.divIcon({
  html: `<div style="background:${color};width:${size}px;height:${size}px;border-radius:50%;border:3px solid white;box-shadow:0 0 4px rgba(0,0,0,.45)"></div>`,
  className: '',
  iconSize: [size + 6, size + 6],
  iconAnchor: [(size + 6) / 2, (size + 6) / 2],
});

type ZoneMapProps = {
  center: Point | null; tiers: Tier[]; pin?: Point | null; onPick?: (p: Point) => void; className?: string;
};

const frameKey = (center: Point | null, tiers: Tier[], pin?: Point | null) =>
  `${center?.latitude},${center?.longitude}|${pin ? 1 : 0}|${Math.max(0, ...tiers.map((t) => t.radius_km))}`;

const tierColor = (i: number, count: number) => TIER_COLORS[Math.min(count - 1 - i, TIER_COLORS.length - 1)];

/**
 * Mapa de una zona de entrega: circulos de los tramos alrededor del centro y,
 * opcional, el pin del domicilio. Al tocar el mapa (o arrastrar el pin) llama
 * onPick con el punto. Usa Google Maps si hay llave; si no, Leaflet + OSM.
 */
export default function ZoneMap({ className = 'h-72', ...props }: ZoneMapProps) {
  const g = useGoogleMaps();
  if (g === undefined) return <div className={`rounded-xl border border-gray-300 bg-gray-100 ${className}`} />;
  return g ? <GoogleZoneMap g={g} className={className} {...props} /> : <LeafletZoneMap className={className} {...props} />;
}

function GoogleZoneMap({ g, center, tiers, pin, onPick, className }: ZoneMapProps & { g: typeof google }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const shapes = useRef<(google.maps.Circle | google.maps.Marker)[]>([]);
  const pick = useRef(onPick);
  pick.current = onPick;
  const framed = useRef('');

  useEffect(() => {
    if (!box.current || map.current) return undefined;
    const m = new g.maps.Map(box.current, GOOGLE_MAP_OPTIONS);
    const click = m.addListener('click', (e: google.maps.MapMouseEvent) => {
      if (e.latLng) pick.current?.({ latitude: e.latLng.lat(), longitude: e.latLng.lng() });
    });
    map.current = m;
    const current = shapes;
    return () => { click.remove(); current.current.forEach((x) => x.setMap(null)); current.current = []; map.current = null; framed.current = ''; };
  }, [g]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    shapes.current.forEach((x) => x.setMap(null));
    shapes.current = [];
    if (center) {
      const c = { lat: center.latitude, lng: center.longitude };
      [...tiers].sort((a, b) => b.radius_km - a.radius_km).forEach((t, i, all) => {
        const color = tierColor(i, all.length);
        shapes.current.push(new g.maps.Circle({
          map: m, center: c, radius: t.radius_km * 1000, strokeColor: color, strokeWeight: 2, fillColor: color, fillOpacity: 0.08, clickable: false,
        }));
      });
      shapes.current.push(new g.maps.Marker({ map: m, position: c, icon: dotIcon(g, '#111827', 14), clickable: false }));
    }
    if (pin) {
      const mk = new g.maps.Marker({ map: m, position: { lat: pin.latitude, lng: pin.longitude }, icon: dotIcon(g, '#ea580c', 20), draggable: Boolean(pick.current) });
      mk.addListener('dragend', () => { const p = mk.getPosition(); if (p) pick.current?.({ latitude: p.lat(), longitude: p.lng() }); });
      shapes.current.push(mk);
    }
    const key = frameKey(center, tiers, pin);
    if (key !== framed.current) {
      framed.current = key;
      const outer = Math.max(1, ...tiers.map((t) => t.radius_km));
      if (center) {
        const bounds = new g.maps.Circle({ center: { lat: center.latitude, lng: center.longitude }, radius: outer * 1000 }).getBounds();
        if (bounds) m.fitBounds(bounds, 10);
      } else if (pin) {
        m.setCenter({ lat: pin.latitude, lng: pin.longitude });
        m.setZoom(16);
      }
    }
  }, [g, center, tiers, pin]);

  return (
    <div className={`relative isolate overflow-hidden rounded-xl border border-gray-300 ${className}`}>
      <div ref={box} className="h-full w-full" />
    </div>
  );
}

function LeafletZoneMap({ center, tiers, pin, onPick, className }: ZoneMapProps) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const framed = useRef('');

  useEffect(() => {
    if (!box.current || map.current) return undefined;
    const m = L.map(box.current).setView(DEFAULT_CENTER, 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap', maxZoom: 19 }).addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => pick.current?.({ latitude: e.latlng.lat, longitude: e.latlng.lng }));
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    return () => { m.remove(); map.current = null; layer.current = null; framed.current = ''; };
  }, []);

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    if (center) {
      const c: L.LatLngTuple = [center.latitude, center.longitude];
      [...tiers].sort((a, b) => b.radius_km - a.radius_km).forEach((t, i, all) => {
        const color = tierColor(i, all.length);
        L.circle(c, { radius: t.radius_km * 1000, color, weight: 2, fillOpacity: 0.08, interactive: false }).addTo(g);
      });
      L.marker(c, { icon: dot('#111827', 14), interactive: false }).addTo(g);
    }
    if (pin) {
      const mk = L.marker([pin.latitude, pin.longitude], { icon: dot('#ea580c', 20), draggable: Boolean(pick.current) }).addTo(g);
      mk.on('dragend', () => { const p = mk.getLatLng(); pick.current?.({ latitude: p.lat, longitude: p.lng }); });
    }
    // Encuadre: al cambiar el centro o al aparecer el pin por primera vez.
    const key = frameKey(center, tiers, pin);
    if (key !== framed.current) {
      framed.current = key;
      const outer = Math.max(1, ...tiers.map((t) => t.radius_km));
      if (center) m.fitBounds(L.latLng(center.latitude, center.longitude).toBounds(outer * 2000), { padding: [10, 10] });
      else if (pin) m.setView([pin.latitude, pin.longitude], 16);
    }
  }, [center, tiers, pin]);

  return (
    <div className={`relative isolate overflow-hidden rounded-xl border border-gray-300 ${className}`}>
      <div ref={box} className="h-full w-full" />
    </div>
  );
}

/** Busca una direccion con Google (si hay llave) o con Nominatim de OSM. */
async function geocode(q: string, near?: Point | null): Promise<Point | null> {
  const g = await loadGoogleMaps();
  if (g) {
    const req: google.maps.GeocoderRequest = { address: q, componentRestrictions: { country: 'MX' } };
    if (near) {
      const d = 0.3;
      req.bounds = { south: near.latitude - d, west: near.longitude - d, north: near.latitude + d, east: near.longitude + d };
    }
    const { results } = await new g.maps.Geocoder().geocode(req).catch(() => ({ results: [] as google.maps.GeocoderResult[] }));
    const loc = results[0]?.geometry.location;
    return loc ? { latitude: loc.lat(), longitude: loc.lng() } : null;
  }
  const params = new URLSearchParams({ format: 'json', limit: '1', countrycodes: 'mx', q });
  if (near) {
    const d = 0.3;
    params.set('viewbox', `${near.longitude - d},${near.latitude + d},${near.longitude + d},${near.latitude - d}`);
  }
  const r = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { 'Accept-Language': 'es' } });
  const list = (await r.json()) as { lat: string; lon: string }[];
  return list[0] ? { latitude: Number(list[0].lat), longitude: Number(list[0].lon) } : null;
}

/** "Usar mi ubicacion" y busqueda de direccion (solo al presionar Buscar). */
export function MapTools({ onPoint, light = false, near, initialQuery = '' }: {
  onPoint: (p: Point) => void; light?: boolean; near?: Point | null; initialQuery?: string;
}) {
  const [q, setQ] = useState(initialQuery);
  const [busy, setBusy] = useState<'' | 'gps' | 'search'>('');
  const [msg, setMsg] = useState('');
  const gps = () => {
    if (!navigator.geolocation) { setMsg('Tu navegador no comparte la ubicación'); return; }
    setBusy('gps');
    setMsg('');
    navigator.geolocation.getCurrentPosition(
      (pos) => { setBusy(''); onPoint({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }); },
      () => { setBusy(''); setMsg('No pudimos obtener tu ubicación; marca el punto en el mapa'); },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };
  const search = async () => {
    if (q.trim().length < 4) return;
    setBusy('search');
    setMsg('');
    try {
      const p = await geocode(q.trim(), near);
      if (p) onPoint(p);
      else setMsg('No encontramos esa dirección; marca el punto en el mapa');
    } catch {
      setMsg('No se pudo buscar; marca el punto en el mapa');
    }
    setBusy('');
  };
  const input = light ? 'input-light' : 'input';
  const btn = light ? 'btn-outline py-2'
    : 'inline-flex items-center justify-center gap-2 rounded-xl border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm font-semibold text-gray-100 hover:bg-gray-700 disabled:opacity-50';
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-2">
        <div className="flex min-w-[12rem] flex-1 gap-2">
          <div className="min-w-0 flex-1">
            <AddressAutocomplete className={input} light={light} value={q} onChange={setQ} near={near} placeholder="Buscar calle y colonia"
              onPlace={({ point }) => { setMsg(''); onPoint(point); }} onEnter={() => void search()} />
          </div>
          <button type="button" className={btn} onClick={() => void search()} disabled={busy !== ''} aria-label="Buscar">
            {busy === 'search' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          </button>
        </div>
        <button type="button" className={btn} onClick={gps} disabled={busy !== ''}>
          {busy === 'gps' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Crosshair className="h-4 w-4" />} Usar mi ubicación
        </button>
      </div>
      {msg && <p className={`text-xs ${light ? 'text-gray-500' : 'text-gray-400'}`}>{msg}</p>}
    </div>
  );
}
