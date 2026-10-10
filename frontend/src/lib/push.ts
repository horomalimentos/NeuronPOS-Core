// Notificaciones push del navegador (modulo 'push'): registra /sw.js, pide
// permiso y guarda la suscripcion en el backend. Personal y repartidores
// usan su sesion; clientes su sesion o el token del seguimiento.
import { api } from './api';
import type { Realm } from './session';

export type PushTarget = { realm: 'restaurant' } | { realm: 'customer'; token?: string };

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

const paths = (t: PushTarget) => (t.realm === 'customer'
  ? { sub: '/push/customer/subscribe', unsub: '/push/customer/unsubscribe' }
  : { sub: '/push/subscribe', unsub: '/push/unsubscribe' });

/** Activa los avisos en este navegador. Lanza Error con el motivo si no se puede. */
export async function enablePush(target: PushTarget) {
  if (!pushSupported()) throw new Error('Este navegador no recibe notificaciones');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Permite las notificaciones en tu navegador para activarlas');
  const realm: Realm = target.realm;
  const { public_key: key } = await api<{ public_key: string }>('/push/key', { realm, noRedirect: true });
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
  await api(paths(target).sub, { method: 'POST', realm, body: { subscription: sub.toJSON(), token } });
}

/** Deja de mandar avisos de esta cuenta (o pedido) a este navegador. */
export async function disablePush(target: PushTarget) {
  const sub = await currentSubscription();
  if (!sub) return;
  const token = target.realm === 'customer' ? target.token : undefined;
  await api(paths(target).unsub, { method: 'POST', realm: target.realm, body: { endpoint: sub.endpoint, token } }).catch(() => {});
}
