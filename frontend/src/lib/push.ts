// Notificaciones push del navegador (modulo 'push'): registra /sw.js, pide
// permiso y guarda la suscripcion en el backend. Personal y repartidores
// usan su sesion; clientes su sesion o el token del seguimiento.
import { nayoPath } from '../marketplace/nayoUrl';
import { api } from './api';
import type { NayoApp } from './pwa';
import type { Realm } from './session';

// Nayo: avisos de la plataforma (routes/marketplace.js /push/*), con la
// sesion de cada app: cliente (nayo), repartidor (fleet) o personal (restaurant).
export type PushTarget = { realm: 'restaurant' } | { realm: 'customer'; token?: string } | { realm: 'nayo'; app: NayoApp };

export const pushSupported = () =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** iPhone/iPad solo reciben avisos si el sitio se agrego a la pantalla de inicio. */
export const needsHomeScreen = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) && !('PushManager' in window);

async function registration() {
  return navigator.serviceWorker.register('/sw.js');
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

function keyBytes(base64url: string) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const NAYO = {
  cliente: { realm: 'nayo', sub: '/marketplace/push/cliente', unsub: '/marketplace/push/cliente/off' },
  repartidor: { realm: 'fleet', sub: '/marketplace/push/repartidor', unsub: '/marketplace/push/repartidor/off' },
  restaurante: { realm: 'restaurant', sub: '/marketplace/push/subscribe', unsub: '/marketplace/push/unsubscribe' },
} as const;

function route(t: PushTarget): { realm: Realm; key: string; sub: string; unsub: string } {
  if (t.realm === 'nayo') return { ...NAYO[t.app], key: '/marketplace/push/key' };
  if (t.realm === 'customer') return { realm: 'customer', key: '/push/key', sub: '/push/customer/subscribe', unsub: '/push/customer/unsubscribe' };
  return { realm: 'restaurant', key: '/push/key', sub: '/push/subscribe', unsub: '/push/unsubscribe' };
}

// Los avisos de Nayo van a otra lista que los de NeuronPOS: aqui se recuerda
// en que app de Nayo se activaron en este navegador.
const nayoFlag = (t: PushTarget) => (t.realm === 'nayo' ? `npc_push_nayo_${t.app}` : null);
function setFlag(t: PushTarget, on: boolean) {
  const k = nayoFlag(t);
  if (!k) return;
  try { if (on) localStorage.setItem(k, '1'); else localStorage.removeItem(k); } catch { /* sin almacenamiento */ }
}
/** Si los avisos de esta cuenta/app estan activos en este navegador. */
export async function pushIsOn(t: PushTarget) {
  const s = await currentSubscription();
  if (!s || Notification.permission !== 'granted') return false;
  const k = nayoFlag(t);
  if (!k) return true;
  try { return localStorage.getItem(k) === '1'; } catch { return false; }
}

/** Activa los avisos en este navegador. Lanza Error con el motivo si no se puede. */
export async function enablePush(target: PushTarget) {
  if (!pushSupported()) throw new Error('Este navegador no recibe notificaciones');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Permite las notificaciones en tu navegador para activarlas');
  const r = route(target);
  const { public_key: key } = await api<{ public_key: string }>(r.key, { realm: r.realm, noRedirect: true });
  const reg = await registration();
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && sub.options.applicationServerKey) {
    const current = new Uint8Array(sub.options.applicationServerKey);
    const wanted = keyBytes(key);
    if (current.length !== wanted.length || current.some((b, i) => b !== wanted[i])) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  if (!sub) {
    // Sin conexion con el servicio de push del navegador, subscribe() se queda esperando.
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('No se pudieron activar los avisos. Revisa tu conexión e intenta de nuevo.')), 20000);
    });
    sub = await Promise.race([reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }), timeout]);
  }
  const token = target.realm === 'customer' ? target.token : undefined;
  // El cliente de Nayo en neuronpos.app abre sus avisos bajo /nayo.
  const linkBase = target.realm === 'nayo' && target.app === 'cliente' ? nayoPath('').replace(/\/$/, '') : undefined;
  await api(r.sub, { method: 'POST', realm: r.realm, body: { subscription: sub.toJSON(), token, link_base: linkBase } });
  setFlag(target, true);
}

/** Deja de mandar avisos de esta cuenta (o pedido) a este navegador. */
export async function disablePush(target: PushTarget) {
  setFlag(target, false);
  const sub = await currentSubscription();
  if (!sub) return;
  const token = target.realm === 'customer' ? target.token : undefined;
  const r = route(target);
  await api(r.unsub, { method: 'POST', realm: r.realm, body: { endpoint: sub.endpoint, token } }).catch(() => {});
}
