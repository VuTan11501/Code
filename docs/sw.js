// Service Worker for Workflow Dashboard push notifications
// Minimal SW — exists to enable Notification API from the page context
// and to route notification clicks to the relevant run URL.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Fetch handler — required for PWA installability. Network-only (no caching).
self.addEventListener('fetch', () => {});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If an existing window matches the target, focus it.
      for (const client of clientList) {
        try {
          if (client.url === targetUrl && 'focus' in client) return client.focus();
        } catch {}
      }
      // Otherwise focus any dashboard window and navigate, or open a new one.
      for (const client of clientList) {
        if (client.url.includes('/docs/') || client.url.endsWith('/')) {
          if ('navigate' in client) {
            return client.navigate(targetUrl).then(() => client.focus()).catch(() => client.focus());
          }
          if ('focus' in client) return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
