import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import type { Point } from '../components/ZoneMap';
import { dotIcon, GOOGLE_MAP_OPTIONS, useGoogleMaps } from '../lib/googleMaps';

export type PinKind = 'me' | 'pickup' | 'dropoff' | 'offer';
export interface Pin { id: string; kind: PinKind; point: Point; label?: string }
export interface Zone { center: Point; radius_km: number }

const COLOR: Record<PinKind, string> = { me: '#3b82f6', pickup: '#FFC21A', dropoff: '#10b981', offer: '#FFC21A' };
const SIZE: Record<PinKind, number> = { me: 18, pickup: 20, dropoff: 20, offer: 14 };

// Mapa oscuro de Google, al estilo de las apps de reparto.
const DARK: google.maps.MapTypeStyle[] = [
  { elementType: 'geometry', stylers: [{ color: '#1d1b19' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#9a948c' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1d1b19' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#33302c' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#3d3934' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#55504a' }] },
  { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0f1720' }] },
  { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: '#22201d' }] },
];

type Props = { pins: Pin[]; zone: Zone | null; route: Point[]; fit: number; padBottom: number };

/** Que encuadrar: la ruta si hay pedido; si no, el repartidor; si no, su zona. */
function frame(pins: Pin[], zone: Zone | null): Point[] {
  const stops = pins.filter((p) => p.kind !== 'me').map((p) => p.point);
  const me = pins.find((p) => p.kind === 'me')?.point;
  if (stops.length) return me ? [me, ...stops] : stops;
  if (me) return [me];
  if (zone) {
    const d = zone.radius_km / 111;
    return [
      { latitude: zone.center.latitude + d, longitude: zone.center.longitude + d },
      { latitude: zone.center.latitude - d, longitude: zone.center.longitude - d },
    ];
  }
  return [];
}

const frameKey = (pins: Pin[], zone: Zone | null) =>
  `${pins.filter((p) => p.kind !== 'me').map((p) => p.id).sort().join(',')}|${pins.some((p) => p.kind === 'me')}|${zone ? 1 : 0}`;

/**
 * Mapa de pantalla completa de la app del repartidor: su punto, su zona, el
 * restaurante y el cliente del pedido en curso (con la ruta en linea), y los
 * restaurantes con pedidos disponibles. `fit` cambia para volver a centrar.
 */
export default function DriverMap(props: Props) {
  const g = useGoogleMaps();
  if (g === undefined) return <div className="h-full w-full bg-[#1d1b19]" />;
  return g ? <GoogleDriverMap g={g} {...props} /> : <LeafletDriverMap {...props} />;
}

function GoogleDriverMap({ g, pins, zone, route, fit, padBottom }: Props & { g: typeof google }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const shapes = useRef<(google.maps.Marker | google.maps.Circle | google.maps.Polyline)[]>([]);
  const framed = useRef('');

  useEffect(() => {
    if (!box.current || map.current) return undefined;
    map.current = new g.maps.Map(box.current, {
      ...GOOGLE_MAP_OPTIONS, styles: DARK, zoomControl: false, disableDefaultUI: true, gestureHandling: 'greedy', backgroundColor: '#1d1b19',
    });
    const current = shapes;
    return () => { current.current.forEach((s) => s.setMap(null)); current.current = []; map.current = null; framed.current = ''; };
  }, [g]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    shapes.current.forEach((s) => s.setMap(null));
    shapes.current = [];
    if (zone) {
      shapes.current.push(new g.maps.Circle({
        map: m, center: { lat: zone.center.latitude, lng: zone.center.longitude }, radius: zone.radius_km * 1000,
        strokeColor: '#FFC21A', strokeOpacity: 0.35, strokeWeight: 1, fillColor: '#FFC21A', fillOpacity: 0.04, clickable: false,
      }));
    }
    if (route.length > 1) {
      shapes.current.push(new g.maps.Polyline({
        map: m, path: route.map((p) => ({ lat: p.latitude, lng: p.longitude })), strokeOpacity: 0, clickable: false,
        icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.9, strokeColor: '#FFC21A', scale: 3 }, offset: '0', repeat: '14px' }],
      }));
    }
    for (const p of pins) {
      shapes.current.push(new g.maps.Marker({
        map: m, position: { lat: p.point.latitude, lng: p.point.longitude }, icon: dotIcon(g, COLOR[p.kind], SIZE[p.kind]),
        zIndex: p.kind === 'me' ? 1000 : 500, clickable: false, title: p.label,
        label: p.label ? { text: p.label, color: '#ffffff', fontSize: '11px', fontWeight: '700' } : undefined,
      }));
    }
    const key = `${frameKey(pins, zone)}#${fit}`;
    if (key === framed.current) return;
    const pts = frame(pins, zone);
    if (!pts.length) return;
    framed.current = key;
    if (pts.length === 1) {
      m.setCenter({ lat: pts[0].latitude, lng: pts[0].longitude });
      m.setZoom(15);
    } else {
      const b = new g.maps.LatLngBounds();
      pts.forEach((p) => b.extend({ lat: p.latitude, lng: p.longitude }));
      m.fitBounds(b, { top: 90, left: 40, right: 40, bottom: padBottom });
    }
  }, [g, pins, zone, route, fit, padBottom]);

  return <div ref={box} className="h-full w-full" />;
}

const dot = (color: string, size: number) => L.divIcon({
  html: `<div style="background:${color};width:${size}px;height:${size}px;border-radius:50%;border:3px solid white;box-shadow:0 0 6px rgba(0,0,0,.6)"></div>`,
  className: '',
  iconSize: [size + 6, size + 6],
  iconAnchor: [(size + 6) / 2, (size + 6) / 2],
});

function LeafletDriverMap({ pins, zone, route, fit, padBottom }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const framed = useRef('');

  useEffect(() => {
    if (!box.current || map.current) return undefined;
    const m = L.map(box.current, { zoomControl: false, attributionControl: true }).setView([23.6, -102.5], 5);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19, subdomains: 'abcd',
    }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    return () => { m.remove(); map.current = null; layer.current = null; framed.current = ''; };
  }, []);

  useEffect(() => {
    const m = map.current;
    const lg = layer.current;
    if (!m || !lg) return;
    lg.clearLayers();
    if (zone) {
      L.circle([zone.center.latitude, zone.center.longitude], {
        radius: zone.radius_km * 1000, color: '#FFC21A', opacity: 0.35, weight: 1, fillOpacity: 0.04, interactive: false,
      }).addTo(lg);
    }
    if (route.length > 1) {
      L.polyline(route.map((p) => [p.latitude, p.longitude] as L.LatLngTuple), { color: '#FFC21A', weight: 3, dashArray: '6 8', interactive: false }).addTo(lg);
    }
    for (const p of pins) {
      const mk = L.marker([p.point.latitude, p.point.longitude], { icon: dot(COLOR[p.kind], SIZE[p.kind]), interactive: false, zIndexOffset: p.kind === 'me' ? 1000 : 0 });
      if (p.label) mk.bindTooltip(p.label, { permanent: true, direction: 'top', offset: [0, -12] });
      mk.addTo(lg);
    }
    const key = `${frameKey(pins, zone)}#${fit}`;
    if (key === framed.current) return;
    const pts = frame(pins, zone);
    if (!pts.length) return;
    framed.current = key;
    if (pts.length === 1) m.setView([pts[0].latitude, pts[0].longitude], 15);
    else {
      m.fitBounds(L.latLngBounds(pts.map((p) => [p.latitude, p.longitude] as L.LatLngTuple)), {
        paddingTopLeft: [40, 90], paddingBottomRight: [40, padBottom], maxZoom: 16,
      });
    }
  }, [pins, zone, route, fit, padBottom]);

  return <div ref={box} className="h-full w-full" />;
}
