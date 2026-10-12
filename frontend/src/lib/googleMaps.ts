/// <reference types="google.maps" />
import { useEffect, useState } from 'react';
import { api } from './api';

// Google Maps para los mapas de NeuronPOS y Nayo. La llave (de navegador,
// restringida por dominio) la da el backend en GET /api/public/maps; si no
// hay llave o el script no carga, los mapas siguen con Leaflet + OpenStreetMap.

type Google = typeof google;

let loading: Promise<Google | null> | null = null;

function injectScript(key: string): Promise<Google> {
  return new Promise((resolve, reject) => {
    const w = window as unknown as Record<string, unknown>;
    w.__neuronMapsReady = () => resolve(window.google);
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}`
      + '&language=es&region=MX&v=weekly&loading=async&callback=__neuronMapsReady';
    s.async = true;
    s.onerror = () => reject(new Error('No cargo Google Maps'));
    document.head.appendChild(s);
  });
}

/** Carga Google Maps una sola vez; null si no hay llave o fallo la carga. */
export function loadGoogleMaps(): Promise<Google | null> {
  if (!loading) {
    loading = api<{ google_maps_key: string | null }>('/public/maps', { noRedirect: true })
      .then((r) => (r.google_maps_key ? injectScript(r.google_maps_key) : null))
      .catch(() => null);
  }
  return loading;
}

/** undefined mientras se decide; luego Google Maps o null (usar Leaflet). */
export function useGoogleMaps(): Google | null | undefined {
  const [g, setG] = useState<Google | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void loadGoogleMaps().then((x) => { if (alive) setG(x); });
    return () => { alive = false; };
  }, []);
  return g;
}

/** Punto redondo con borde blanco, como los de Leaflet. */
export function dotIcon(g: Google, color: string, size = 16): google.maps.Symbol {
  return {
    path: g.maps.SymbolPath.CIRCLE,
    scale: size / 2,
    fillColor: color,
    fillOpacity: 1,
    strokeColor: '#ffffff',
    strokeWeight: 3,
    labelOrigin: new g.maps.Point(0, -2.4),
  };
}

export const GOOGLE_MAP_OPTIONS: google.maps.MapOptions = {
  center: { lat: 23.6, lng: -102.5 },
  zoom: 5,
  mapTypeControl: false,
  streetViewControl: false,
  fullscreenControl: false,
  clickableIcons: false,
};
