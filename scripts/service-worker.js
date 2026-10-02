/* Build placeholders are replaced by build-worker.mjs. No private data belongs in this cache. */
const CACHE = 'agent-interface-__BUILD_ID__';
const STATIC_FILES = __PRECACHE__;
const STATIC_PATHS = new Set(STATIC_FILES);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(STATIC_FILES)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('agent-interface-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Never intercept authenticated endpoints, including streams and downloads.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')) {
    event.respondWith(fetch(request).catch(async () => {
      const shell = await (await caches.open(CACHE)).match('/index.html');
      return shell || Response.error();
    }));
    return;
  }
  if (!STATIC_PATHS.has(url.pathname) || url.pathname === '/index.html') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    return (await cache.match(url.pathname)) || fetch(request);
  })());
});

function conversationUrl(value) {
  try {
    const url = new URL(value || '/', self.location.origin);
    if (url.origin !== self.location.origin) return self.location.origin + '/';
    if(url.pathname !== '/') return self.location.origin + '/';
    if(url.searchParams.get('view') === 'today') return self.location.origin + '/?view=today';
    const bot = url.searchParams.get('bot');
    const routine = url.searchParams.get('routine');
    return self.location.origin + '/' + (bot ? '?bot=' + encodeURIComponent(bot) + (routine ? '&routine=' + encodeURIComponent(routine) : '') : '');
  } catch {
    return self.location.origin + '/';
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { /* A malformed payload still opens the app. */ }
  event.waitUntil(self.registration.showNotification(String(data.title || 'Agent Interface').slice(0, 100), {
    body: String(data.body || 'Your assistant has an update.').slice(0, 240),
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: typeof data.tag === 'string' ? data.tag : undefined,
    data: { url: conversationUrl(data.url) },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = conversationUrl(event.notification.data?.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      if (existing.url !== url) await existing.navigate(url);
      await existing.focus();
    } else {
      await self.clients.openWindow(url);
    }
  })());
});
