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
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!branchId) return undefined;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = () => { clearTimeout(timer); timer = setTimeout(() => cb.current(), 300); };
    async function run() {
      while (!ctrl.signal.aborted) {
        try {
          const headers: Record<string, string> = { Accept: 'text/event-stream' };
          const token = session.getToken('restaurant');
          if (token) headers.Authorization = `Bearer ${token}`;
          const slug = session.getDevSlug();
          if (slug) headers['X-Restaurant-Slug'] = slug;
          const device = deviceToken();
          if (device) headers['X-Device-Token'] = device;
          const res = await fetch(`/api/live?branch_id=${branchId}`, { headers, signal: ctrl.signal });
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
  }, [branchId]);
}
