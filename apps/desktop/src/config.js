// Configuracion local de la app: direccion del restaurante e impresoras.
// Se guarda en config.json dentro de la carpeta de datos de la app.
import fs from 'node:fs';
import path from 'node:path';

export const PLATFORM_DOMAIN = 'neuronpos.app';

const emptyPrinter = () => ({ type: 'none', name: '', host: '', port: 9100, paper: 80, drawer: false });

export const DEFAULTS = {
  url: '',
  printers: { ticket: emptyPrinter(), comanda: emptyPrinter() },
};

/**
 * Normaliza lo que escribe el usuario: "tacos", "tacos.neuronpos.app" o una
 * URL completa (tambien dominios propios). Regresa solo el origen https.
 */
export function normalizeUrl(input) {
  let v = String(input || '').trim().toLowerCase();
  if (!v) return '';
  if (/^[a-z0-9-]+$/.test(v)) v = `${v}.${PLATFORM_DOMAIN}`;
  if (!/^https?:\/\//.test(v)) v = `https://${v}`;
  let u;
  try { u = new URL(v); } catch { return ''; }
  const local = u.hostname === 'localhost' || u.hostname.endsWith('.localhost');
  if (u.protocol !== 'https:' && !local) return '';
  return u.origin;
}

function cleanPrinter(p) {
  const d = emptyPrinter();
  if (!p || typeof p !== 'object') return d;
  return {
    type: ['none', 'system', 'network'].includes(p.type) ? p.type : 'none',
    name: String(p.name || '').slice(0, 200),
    host: String(p.host || '').trim().slice(0, 100),
    port: Number.parseInt(p.port, 10) > 0 && Number.parseInt(p.port, 10) < 65536 ? Number.parseInt(p.port, 10) : 9100,
    paper: Number(p.paper) === 58 ? 58 : 80,
    drawer: Boolean(p.drawer),
  };
}

export function sanitize(cfg) {
  return {
    url: normalizeUrl(cfg?.url),
    printers: {
      ticket: cleanPrinter(cfg?.printers?.ticket),
      comanda: cleanPrinter(cfg?.printers?.comanda),
    },
  };
}

export function createStore(dir) {
  const file = path.join(dir, 'config.json');
  let current = structuredClone(DEFAULTS);
  try { current = sanitize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* primera vez */ }
  return {
    get: () => structuredClone(current),
    set(next) {
      current = sanitize(next);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(current, null, 2));
      return structuredClone(current);
    },
  };
}
