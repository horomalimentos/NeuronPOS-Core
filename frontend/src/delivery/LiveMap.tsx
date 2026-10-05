import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';

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

/**
 * Mapa en vivo (Leaflet + OpenStreetMap) con un punto por repartidor. Los
 * puntos se mueven sin recrear el mapa; el encuadre cambia solo cuando
 * aparece o desaparece un repartidor.
 */
export default function LiveMap({ points, className = 'h-72', emptyLabel = 'Sin ubicaciones recientes' }: {
  points: MapPoint[]; className?: string; emptyLabel?: string;
}) {
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
    const key = points.map((p) => p.id).sort().join(',');
    if (key !== lastKey.current) {
      lastKey.current = key;
      if (points.length === 1) m.setView([points[0].latitude, points[0].longitude], 15);
      else if (points.length > 1) m.fitBounds(L.latLngBounds(points.map((p) => [p.latitude, p.longitude] as L.LatLngTuple)), { padding: [40, 40], maxZoom: 16 });
    }
  }, [points]);

  return (
    <div className={`relative isolate overflow-hidden rounded-xl border border-gray-800 ${className}`}>
      <div ref={box} className="h-full w-full" />
      {points.length === 0 && (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-[500] flex justify-center">
          <span className="rounded-full bg-gray-900/90 px-3 py-1 text-xs text-gray-300">{emptyLabel}</span>
        </div>
      )}
    </div>
  );
}
