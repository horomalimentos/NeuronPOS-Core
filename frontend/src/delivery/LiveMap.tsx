import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import { dotIcon, GOOGLE_MAP_OPTIONS, useGoogleMaps } from '../lib/googleMaps';

export interface MapPoint {
  id: string;
  latitude: number;
  longitude: number;
  label: string;
  /** Color del punto (CSS). */
  color?: string;
}

// Centro por defecto (Mexico) cuando no hay ningun punto.
const DEFAULT_CENTER: L.LatLngExpression = [23.6, -102.5];

const dot = (color: string) => L.divIcon({
  html: `<div style="background:${color};width:16px;height:16px;border-radius:50%;border:3px solid white;box-shadow:0 0 4px rgba(0,0,0,.45)"></div>`,
  className: '',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

type LiveMapProps = { points: MapPoint[]; className?: string; emptyLabel?: string };

/**
 * Mapa en vivo con un punto por repartidor. Los puntos se mueven sin recrear
 * el mapa; el encuadre cambia solo cuando aparece o desaparece un repartidor.
 * Usa Google Maps si hay llave; si no, Leaflet + OpenStreetMap.
 */
export default function LiveMap({ className = 'h-72', emptyLabel = 'Sin ubicaciones recientes', points }: LiveMapProps) {
  const g = useGoogleMaps();
  return (
    <div className={`relative isolate overflow-hidden rounded-xl border border-gray-800 ${className}`}>
      {g === undefined ? <div className="h-full w-full bg-gray-900" />
        : g ? <GoogleLiveMap g={g} points={points} /> : <LeafletLiveMap points={points} />}
      {points.length === 0 && (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-[500] flex justify-center">
          <span className="rounded-full bg-gray-900/90 px-3 py-1 text-xs text-gray-300">{emptyLabel}</span>
        </div>
      )}
    </div>
  );
}

const pointsKey = (points: MapPoint[]) => points.map((p) => p.id).sort().join(',');

function GoogleLiveMap({ g, points }: { g: typeof google; points: MapPoint[] }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const markers = useRef(new Map<string, google.maps.Marker>());
  const lastKey = useRef('');

  useEffect(() => {
    if (!box.current || map.current) return undefined;
    map.current = new g.maps.Map(box.current, GOOGLE_MAP_OPTIONS);
    const current = markers.current;
    return () => {
      current.forEach((mk) => mk.setMap(null));
      current.clear();
      map.current = null;
      lastKey.current = '';
    };
  }, [g]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const seen = new Set<string>();
    for (const p of points) {
      seen.add(p.id);
      const pos = { lat: p.latitude, lng: p.longitude };
      const label: google.maps.MarkerLabel = { text: p.label, className: 'live-map-label', color: '#f3f4f6', fontSize: '11px', fontWeight: '600' };
      const existing = markers.current.get(p.id);
      if (existing) {
        existing.setPosition(pos);
        existing.setLabel(label);
      } else {
        markers.current.set(p.id, new g.maps.Marker({ map: m, position: pos, icon: dotIcon(g, p.color || '#ea580c'), label }));
      }
    }
    for (const [id, mk] of markers.current) {
      if (!seen.has(id)) {
        mk.setMap(null);
        markers.current.delete(id);
      }
    }
    const key = pointsKey(points);
    if (key !== lastKey.current) {
      lastKey.current = key;
      if (points.length === 1) {
        m.setCenter({ lat: points[0].latitude, lng: points[0].longitude });
        m.setZoom(15);
      } else if (points.length > 1) {
        const b = new g.maps.LatLngBounds();
        points.forEach((p) => b.extend({ lat: p.latitude, lng: p.longitude }));
        m.fitBounds(b, 40);
        if ((m.getZoom() ?? 0) > 16) m.setZoom(16);
      }
    }
  }, [g, points]);

  return <div ref={box} className="h-full w-full" />;
}

function LeafletLiveMap({ points }: { points: MapPoint[] }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef(new Map<string, L.Marker>());
  const lastKey = useRef('');

  useEffect(() => {
    if (!box.current || map.current) return undefined;
    const m = L.map(box.current, { zoomControl: true }).setView(DEFAULT_CENTER, 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 19,
    }).addTo(m);
    map.current = m;
    const current = markers.current;
    return () => {
      m.remove();
      map.current = null;
      current.clear();
      lastKey.current = '';
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const seen = new Set<string>();
    for (const p of points) {
      seen.add(p.id);
      const pos: L.LatLngExpression = [p.latitude, p.longitude];
      const existing = markers.current.get(p.id);
      if (existing) {
        existing.setLatLng(pos);
        existing.setTooltipContent(p.label);
      } else {
        const mk = L.marker(pos, { icon: dot(p.color || '#ea580c') })
          .addTo(m)
          .bindTooltip(p.label, { permanent: true, direction: 'top', offset: [0, -12] });
        markers.current.set(p.id, mk);
      }
    }
    for (const [id, mk] of markers.current) {
      if (!seen.has(id)) {
        mk.remove();
        markers.current.delete(id);
      }
    }
    const key = pointsKey(points);
    if (key !== lastKey.current) {
      lastKey.current = key;
      if (points.length === 1) m.setView([points[0].latitude, points[0].longitude], 15);
      else if (points.length > 1) m.fitBounds(L.latLngBounds(points.map((p) => [p.latitude, p.longitude] as L.LatLngTuple)), { padding: [40, 40], maxZoom: 16 });
    }
  }, [points]);

  return <div ref={box} className="h-full w-full" />;
}
