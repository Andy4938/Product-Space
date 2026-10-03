// GhostSignal service worker: shows guardian alerts even when no GhostSignal tab is open.
const LINK_CACHE = 'ghostsignal-links';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(`GhostSignal: ${data.title || 'Walk update'}`, {
    body: data.body || 'Open GhostSignal for details.',
    tag: `${data.sessionId || 'ghostsignal'}-${data.tag || 'update'}`,
    renotify: true,
    requireInteraction: Boolean(data.urgent),
    icon: '/favicon.svg',
    vibrate: data.urgent ? [400, 150, 400, 150, 400] : [200],
    data: { sessionId: data.sessionId || null },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const sessionId = event.notification.data && event.notification.data.sessionId;
    const path = sessionId ? `/watch/${encodeURIComponent(sessionId)}` : '/';
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).pathname === path && 'focus' in client) return client.focus();
    }
    // The guardian page stores its full private link (with the key fragment) for this purpose.
    let url = path;
    if (sessionId) {
      const saved = await (await caches.open(LINK_CACHE)).match(`/links/${encodeURIComponent(sessionId)}`);
      if (saved) url = await saved.text();
    }
    return self.clients.openWindow(url);
  })());
});
