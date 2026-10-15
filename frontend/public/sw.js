// Service worker de NeuronPOS: notificaciones push (adaptado de Horom) y, para
// la caja sin internet, una copia del panel para abrirlo sin conexion.
// Las paginas se piden primero a la red (una actualizacion nunca se queda
// atorada) y solo si no hay red se usa la copia; los archivos de /assets
// llevan hash en el nombre, asi que se guardan una vez y no cambian.
// El backend manda { title, body, link, tag, icon, badge, driver, insist, sticky } (services/push.js
// y services/nayoPush.js).

const SHELL = 'npc-shell-v1';
const MAX_ASSETS = 150;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('npc-shell-') && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()),
));

async function trim(cache) {
  const keys = (await cache.keys()).filter((r) => new URL(r.url).pathname.startsWith('/assets/'));
  for (const req of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(req);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // Paginas del panel: red primero; sin red, la ultima copia.
  if (req.mode === 'navigate') {
    if (!url.pathname.startsWith('/admin')) return;
    event.respondWith(fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put('/admin', copy));
      }
      return res;
    }).catch(() => caches.open(SHELL).then((c) => c.match('/admin')).then((hit) => hit || Response.error())));
    return;
  }
  // JS, CSS e imagenes con hash: de la copia si ya estan.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.open(SHELL).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) { await c.put(req, res.clone()); await trim(c); }
      return res;
    }));
  }
});

// Globito con el numero en el icono de la app (Badging API): cuenta los avisos
// que llegan con la app cerrada o en segundo plano; la app lo borra al abrirse
// (mensaje 'clear-badge', lib/pwa.ts).
const BADGE_CACHE = 'npc-badge';
const BADGE_KEY = '/__badge-count';

async function setBadge(next) {
  const cache = await caches.open(BADGE_CACHE);
  const prev = Number(await (await cache.match(BADGE_KEY))?.text()) || 0;
  const n = Math.max(0, typeof next === 'function' ? next(prev) : next);
  await cache.put(BADGE_KEY, new Response(String(n)));
  const nav = self.navigator;
  if (n > 0) await nav.setAppBadge?.(n);
  else await nav.clearAppBadge?.();
}

async function appVisible() {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return list.some((c) => c.visibilityState === 'visible' && c.focused);
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'clear-badge') event.waitUntil(setBadge(0).catch(() => {}));
  // La app ya atendio (o salto) el pedido: quita el aviso y calla sus repeticiones.
  if (event.data?.type === 'close-tag' && typeof event.data.tag === 'string') {
    const { tag } = event.data;
    event.waitUntil(Promise.all([
      self.registration.getNotifications({ tag }).then((list) => list.forEach((n) => n.close())),
      event.data.mute ? mute(tag) : null,
    ]).catch(() => {}));
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: event.data ? event.data.text() : '' };
  }
  const options = {
    body: data.body || '',
    icon: data.icon || undefined,
    // Iconito blanco de la barra de estado (Android).
    badge: data.badge || undefined,
    data: { link: data.link || '/' },
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
  };
  // Los avisos de Nayo se quedan en pantalla hasta que los toquen.
  if (data.driver || data.insist || data.sticky) options.requireInteraction = true;
  // Repartidor y pedido nuevo del restaurante: vibra fuerte. El servidor los
  // vuelve a mandar con la misma etiqueta hasta que alguien atiende el pedido
  // (nayoPush.js, insistNayoPush), asi que siguen sonando.
  if (data.driver || data.insist) options.vibrate = [400, 150, 400, 150, 400, 150, 400];
  event.waitUntil((async () => {
    const visible = await appVisible().catch(() => false);
    // Con la app abierta ella misma suena; la repeticion entra callada.
    // Si el repartidor salto o descarto ese pedido, tambien.
    if (data.insist && (visible || (data.tag && await isMuted(data.tag)))) options.silent = true;
    await Promise.all([
      self.registration.showNotification(data.title || 'Aviso', options),
      visible ? null : setBadge((n) => n + 1).catch(() => {}),
    ]);
  })());
});

// Pedidos disponibles que el repartidor salto (desde la app o deslizando el
// aviso): sus repeticiones ya no suenan. Se guardan en Cache Storage porque el
// service worker no tiene localStorage.
const MUTE_KEY = '/__muted-tags';

async function mutedTags() {
  const cache = await caches.open(BADGE_CACHE);
  try { return JSON.parse(await (await cache.match(MUTE_KEY))?.text() || '[]'); } catch { return []; }
}

async function isMuted(tag) {
  return (await mutedTags()).includes(tag);
}

async function mute(tag) {
  const list = (await mutedTags()).filter((t) => t !== tag).concat(tag).slice(-50);
  await (await caches.open(BADGE_CACHE)).put(MUTE_KEY, new Response(JSON.stringify(list)));
}

self.addEventListener('notificationclose', (event) => {
  const tag = event.notification.tag || '';
  if (tag.startsWith('disponible-')) event.waitUntil(mute(tag).catch(() => {}));
});

// Al tocarla: enfoca una pestana abierta (y la lleva a la pantalla del aviso)
// o abre una nueva.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  setBadge((n) => n - 1).catch(() => {});
  const link = event.notification.data?.link || '/';
  const target = new URL(link.startsWith('/') ? link : `/${link}`, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          if (client.url !== target && 'navigate' in client) return client.focus().then(() => client.navigate(target));
          return client.focus();
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
    }),
  );
});
