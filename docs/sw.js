// Service Worker for Workflow Dashboard push notifications
// Minimal SW — exists to enable Notification API from the page context

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes('/docs/') && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow('./');
    })
  );
});
