// Service worker de NeuronPOS: solo notificaciones push (adaptado de Horom).
// No guarda nada en cache, asi que una actualizacion nunca se queda atorada.
// El backend manda { title, body, link, tag, icon, driver } (services/push.js).

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

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
    data: { link: data.link || '/' },
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
  };
  // Repartidor: vibra fuerte y se queda en pantalla hasta que la toque.
  if (data.driver) {
    options.vibrate = [300, 150, 300, 150, 300];
    options.requireInteraction = true;
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Aviso', options));
});

// Al tocarla: enfoca una pestana abierta (y la lleva a la pantalla del aviso)
// o abre una nueva.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
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
