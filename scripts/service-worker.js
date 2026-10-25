/* Build placeholders are replaced by build-worker.mjs. No private data belongs in this cache. */
const CACHE = 'agent-interface-__BUILD_ID__';
const STATIC_FILES = __PRECACHE__;
const STATIC_PATHS = new Set(STATIC_FILES);
// Admin-only chunks (terminal and remote desktop) that cost every phone nothing until first use.
const ON_DEMAND_PATHS = new Set(__ON_DEMAND__);

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
  if (ON_DEMAND_PATHS.has(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(url.pathname);
      if (cached) return cached;
      const response = await fetch(request);
      // A retired chunk falls through to the app shell with a 200, which must never be kept as code.
      if (response.ok && !(response.headers.get('content-type') || '').startsWith('text/html'))
        event.waitUntil(cache.put(url.pathname, response.clone()));
      return response;
    })());
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

// The server counts the badge with the push; a payload without one leaves the badge alone.
function showBadge(count) {
  const badges = self.navigator;
  if (!Number.isInteger(count) || count < 0 || !badges?.setAppBadge) return Promise.resolve();
  return (count ? badges.setAppBadge(count) : badges.clearAppBadge()).catch(() => {});
}

// An approval can be declined from the notification. Its push carries a single-use token, since
// a service worker has no session or CSRF token; Review opens the chat like a tap does.
function canAct() {
  return (self.Notification?.maxActions ?? 0) >= 2;
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { /* A malformed payload still opens the app. */ }
  const url = conversationUrl(data.url);
  const declineToken = data.kind === 'approval' && typeof data.declineToken === 'string' && canAct() ? data.declineToken : undefined;
  event.waitUntil(Promise.all([
    self.registration.showNotification(String(data.title || 'WildBots').slice(0, 100), {
      body: String(data.body || 'Your assistant has an update.').slice(0, 240),
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      data: { url, ...(declineToken ? { declineToken } : {}) },
      ...(declineToken ? { actions: [{ action: 'review', title: 'Review' }, { action: 'decline', title: 'Decline' }] } : {}),
    }),
    showBadge(data.badge),
  ]));
});

async function openChat(url) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
  if (existing) {
    if (existing.url !== url) await existing.navigate(url);
    await existing.focus();
  } else {
    await self.clients.openWindow(url);
  }
}

async function decline(notification) {
  const url = conversationUrl(notification.data?.url);
  let declined = false;
  try {
    const response = await fetch('/api/push/actions', {
      method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: notification.data.declineToken }),
    });
    declined = response.ok;
  } catch { /* Offline: say so below. */ }
  if (declined) return;
  await self.registration.showNotification("Couldn't decline", {
    body: 'Open the chat to review the request.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: (notification.tag || 'approval') + ':decline',
    data: { url },
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'decline' && event.notification.data?.declineToken) {
    event.waitUntil(decline(event.notification));
    return;
  }
  event.waitUntil(openChat(conversationUrl(event.notification.data?.url)));
});
