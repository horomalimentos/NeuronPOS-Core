// Utilidades de domicilios en el frontend: etiquetas, colores, ligas de
// navegacion y llamada, y el envio de ubicacion del repartidor.
import { useEffect, useRef, useState } from 'react';
import type { DeliveryStatus } from './types';

export const DELIVERY_STATUS_LABEL: Record<DeliveryStatus, string> = {
  solicitado: 'Buscando repartidor',
  asignado: 'Asignado',
  recogido: 'Recogido',
  en_camino: 'En camino',
  entregado: 'Entregado',
  fallido: 'No entregado',
  cancelado: 'Cancelado',
};

export const DELIVERY_STATUS_STYLE: Record<DeliveryStatus, string> = {
  solicitado: 'bg-violet-500/15 text-violet-300 ring-violet-500/30',
  asignado: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  recogido: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  en_camino: 'bg-orange-500/15 text-orange-300 ring-orange-500/30',
  entregado: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  fallido: 'bg-red-500/15 text-red-300 ring-red-500/30',
  cancelado: 'bg-gray-500/15 text-gray-300 ring-gray-500/30',
};

/** Siguiente paso que marca el repartidor en su app. */
export const NEXT_DRIVER_STEP: Partial<Record<DeliveryStatus, { status: DeliveryStatus; label: string }>> = {
  asignado: { status: 'recogido', label: 'Ya lo recogí' },
  recogido: { status: 'en_camino', label: 'Salgo en camino' },
  en_camino: { status: 'entregado', label: 'Entregado' },
};

export const ACTIVE: DeliveryStatus[] = ['solicitado', 'asignado', 'recogido', 'en_camino'];

export const telHref = (phone: string | null | undefined) => (phone ? `tel:${phone.replace(/[^+\d]/g, '')}` : undefined);
export const mapsHref = (address: string | null | undefined) =>
  (address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : undefined);
export const wazeHref = (address: string | null | undefined) =>
  (address ? `https://waze.com/ul?q=${encodeURIComponent(address)}&navigate=yes` : undefined);

/** "hace 3 min" para la ultima ubicacion. */
export function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return '—';
  const min = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  return `hace ${Math.round(min / 60)} h`;
}

export interface GeoFix { latitude: number; longitude: number; accuracy: number | null }

/**
 * Mientras `active`, sigue la ubicacion del navegador y la manda con `send`
 * al obtenerla por primera vez y luego cada `everyMs` (20 s por defecto).
 */
export function useLocationSharing(active: boolean, send: (fix: GeoFix) => Promise<unknown>, everyMs = 20000) {
  const [error, setError] = useState('');
  const [lastSent, setLastSent] = useState<Date | null>(null);
  const latest = useRef<GeoFix | null>(null);
  const sendRef = useRef(send);
  useEffect(() => { sendRef.current = send; }, [send]);

  useEffect(() => {
    if (!active) return undefined;
    if (!('geolocation' in navigator)) {
      setError('Este dispositivo no permite compartir la ubicación.');
      return undefined;
    }
    let first = true;
    const push = async () => {
      if (!latest.current) return;
      try {
        await sendRef.current(latest.current);
        setLastSent(new Date());
        setError('');
      } catch {
        setError('No se pudo enviar tu ubicación; se reintentará.');
      }
    };
    const watch = navigator.geolocation.watchPosition(
      (pos) => {
        latest.current = { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy ?? null };
        if (first) { first = false; void push(); }
      },
      (err) => setError(err.code === err.PERMISSION_DENIED
        ? 'Permite el acceso a tu ubicación para que el restaurante y el cliente te vean en el mapa.'
        : 'No se pudo obtener tu ubicación.'),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 },
    );
    const timer = setInterval(() => { void push(); }, everyMs);
    return () => {
      navigator.geolocation.clearWatch(watch);
      clearInterval(timer);
    };
  }, [active, everyMs]);

  return { error, lastSent };
}
