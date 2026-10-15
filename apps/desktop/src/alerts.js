// Nayo Restaurante de escritorio: esta atenta a pedidos de Nayo sin aceptar.
// Pregunta cada pocos segundos a /api/alertas (con el token que entrega la
// pagina con sesion) y, mientras haya alguno, abre una ventana encima de todo
// que suena con el tono de Nayo hasta que el pedido se acepta o se rechaza.
import fs from 'node:fs';
import path from 'node:path';

/** Primer pedido pendiente (o null) de la respuesta de /api/alertas. */
export function firstPending(body) {
  const list = Array.isArray(body?.pending) ? body.pending : [];
  const o = list.find((x) => x && typeof x.id === 'string');
  if (!o) return null;
  return {
    id: o.id,
    title: String(o.title || 'Nuevo pedido').slice(0, 200),
    body: String(o.body || '').slice(0, 300),
    link: typeof o.link === 'string' && o.link.startsWith('/') && !o.link.startsWith('//') ? o.link : '',
  };
}

export function createAlerts({ dir, fetch, onRing, onQuiet, onExpired }) {
  const file = path.join(dir, 'alertas.json');
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* sin token */ }
  let timer = null;
  let failures = 0;
  let ringing = null;

  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    if (cfg) fs.writeFileSync(file, JSON.stringify(cfg));
    else fs.rmSync(file, { force: true });
  };

  const quiet = () => {
    if (!ringing) return;
    ringing = null;
    onQuiet();
  };

  async function poll() {
    timer = null;
    if (!cfg) return;
    try {
      const res = await fetch(`${cfg.api}/api/alertas`, { headers: { Authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(8000) });
      if (res.status === 401) {
        cfg = null;
        save();
        quiet();
        onExpired?.();
        return;
      }
      if (res.ok) {
        failures = 0;
        const next = firstPending(await res.json());
        if (!next) quiet();
        else {
          const fresh = !ringing || ringing.id !== next.id;
          ringing = next;
          onRing(next, fresh);
        }
      } else failures += 1;
    } catch {
      failures += 1; // sin internet: se reintenta
    }
    if (cfg) timer = setTimeout(poll, (failures > 3 ? 20 : cfg.every) * 1000);
  }

  return {
    start(api, token, every) {
      cfg = { api, token: String(token), every: Math.max(5, Math.min(60, Number(every) || 8)) };
      save();
      clearTimeout(timer);
      poll();
    },
    resume() {
      if (cfg && !timer) poll();
    },
    stop() {
      cfg = null;
      save();
      clearTimeout(timer);
      timer = null;
      quiet();
    },
    active: () => Boolean(cfg),
  };
}
