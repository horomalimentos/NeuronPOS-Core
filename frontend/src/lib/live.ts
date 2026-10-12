import { useEffect, useRef } from 'react';
import { deviceToken } from './api';
import { session } from './session';

/**
 * Avisos en vivo de la sucursal (Server-Sent Events con el token en el header).
 * Llama onChange (agrupado ~300 ms) cuando algo cambia en caja, cocina o
 * pedidos en linea; se reconecta solo. Las pantallas siguen consultando cada
 * pocos segundos como respaldo.
 */
export function useLive(branchId: string | null | undefined, onChange: () => void) {
  useEventStream(branchId ? `/api/live?branch_id=${branchId}` : null, () => {
    const headers: Record<string, string> = {};
    const token = session.getToken('restaurant');
    if (token) headers.Authorization = `Bearer ${token}`;
    const slug = session.getDevSlug();
    if (slug) headers['X-Restaurant-Slug'] = slug;
    const device = deviceToken();
    if (device) headers['X-Device-Token'] = device;
    return headers;
  }, onChange);
}

/**
 * Nayo en vivo para clientes (sin cuenta): llama onChange cuando un
 * repartidor se conecta o desconecta, o un restaurante publica o pausa.
 */
export function useNayoLive(onChange: () => void) {
  useEventStream('/api/marketplace/live', () => ({}), onChange);
}

/** Lee un canal SSE con fetch (para poder mandar headers) y se reconecta solo. */
function useEventStream(url: string | null, headersFor: () => Record<string, string>, onChange: () => void) {
  const cb = useRef(onChange);
  cb.current = onChange;
  const hdr = useRef(headersFor);
  hdr.current = headersFor;
  useEffect(() => {
    if (!url) return undefined;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = () => { clearTimeout(timer); timer = setTimeout(() => cb.current(), 300); };
    async function run() {
      while (!ctrl.signal.aborted) {
        try {
          const res = await fetch(url as string, { headers: { Accept: 'text/event-stream', ...hdr.current() }, signal: ctrl.signal });
          if (!res.ok || !res.body) throw new Error(String(res.status));
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += value;
            const parts = buf.split('\n\n');
            buf = parts.pop() || '';
            if (parts.some((p) => p.startsWith('event: '))) fire();
          }
        } catch {
          if (ctrl.signal.aborted) return;
        }
        // Se corto: espera y reconecta.
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    void run();
    return () => { ctrl.abort(); clearTimeout(timer); };
  }, [url]);
}
