/* Build placeholders are replaced by build-worker.mjs. No private data belongs in this cache. */
const CACHE = 'agent-interface-__BUILD_ID__';
// What the app needs to open offline: the pages, and the code each page imports on load. Fetched
// while installing, so it is kept to what the first visit loads anyway.
const INSTALL_FILES = __PRECACHE__;
const INSTALL_PATHS = new Set(INSTALL_FILES);
// Lazy screens and libraries that most visits never open. They are wanted offline too, but they
// are fetched in the background when the page asks (a WARM message) instead of racing the first visit.
const WARM_FILES = __WARM__;
// Admin-only chunks (terminal and remote desktop) that cost every phone nothing until first use.
const ON_DEMAND_FILES = __ON_DEMAND__;
// Anything here is served from the cache when it is there, and kept after its first use when not.
const LAZY_PATHS = new Set([...WARM_FILES, ...ON_DEMAND_FILES]);
// Vite names bundles assets/name-HASH.ext after their content, so one URL is one body forever.
// Nothing else qualifies: the pages, sw.js, the manifest and the icons keep one name across
// releases. Mirrors hashedAsset in src/server/static-cache.ts.
const HASHED_ASSET = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;
const WARM_CONNECTIONS = 3;

// A retired chunk falls through to the app shell with a 200, which must never be kept as code.
const usable = (response) => response.ok && !(response.headers.get('content-type') || '').startsWith('text/html');

async function olderCaches() {
  const keys = (await caches.keys()).filter((key) => key.startsWith('agent-interface-') && key !== CACHE);
  return Promise.all(keys.map((key) => caches.open(key)));
}

// Carries a hashed file over from an earlier release's cache, so a release downloads only what changed.
async function reuse(cache, older, path) {
  if (!HASHED_ASSET.test(path)) return false;
  try {
    for (const previous of older) {
      const kept = await previous.match(path);
      if (kept && usable(kept)) { await cache.put(path, kept); return true; }
    }
  } catch { /* An unreadable old cache only means fetching the file. */ }
  return false;
}

// Bundles are what a release retires by name: the server answers a path it does not have with the
// app shell, so an HTML body under assets/ is a chunk that is gone. Pages, icons and the manifest
// keep their names across releases and only need to load; judging them by content type would let
// one unexpected header block every install.
const acceptable = (path, response) => path.startsWith('/assets/') ? usable(response) : response.ok;

async function install() {
  // A rollback while a newer worker waits can install this same release again, beside the worker
  // already serving from this cache. A failed attempt must leave that cache alone.
  const existed = await caches.has(CACHE);
  const cache = await caches.open(CACHE);
  try {
    const older = await olderCaches();
    // Each body is stored as soon as it arrives, as addAll does. A response held unread keeps its
    // connection busy, and over HTTP/1.1 the browser's few connections per host would all be held
    // while the rest of the list waited for one forever.
    await Promise.all(INSTALL_FILES.map(async (path) => {
      if (await reuse(cache, older, path)) return;
      const response = await fetch(path);
      if (!acceptable(path, response)) throw new Error('Cannot install ' + path + ': ' + response.status + ' ' + response.headers.get('content-type'));
      await cache.put(path, response);
    }));
    // Lazy files the last release already holds cost nothing to keep.
    for (const path of [...WARM_FILES, ...ON_DEMAND_FILES]) await reuse(cache, older, path);
  } catch (error) {
    // A bad answer fails the install, and a half-filled cache it created must never pass for this
    // release. The browser retries the install later, and the previous worker keeps serving until then.
    if (!existed) await caches.delete(CACHE);
    throw error;
  }
}

// Best effort, and safe to repeat: files already cached are skipped, so a run the browser cut short
// is finished by the next one. A file this misses is fetched and kept the first time it is used.
async function fetchMissing() {
  const cache = await caches.open(CACHE);
  const queue = WARM_FILES.slice();
  const connection = async () => {
    for (let path = queue.shift(); path; path = queue.shift()) {
      try {
        if (await cache.match(path)) continue;
        const response = await fetch(path, { priority: 'low' });
        if (usable(response)) await cache.put(path, response);
      } catch { /* Offline, or a newer release replaced the file. */ }
    }
  };
  await Promise.all(Array.from({ length: WARM_CONNECTIONS }, connection));
}

// Pages in several tabs ask at once; they share one run.
let warming;
function warm() {
  return warming ??= fetchMissing().finally(() => { warming = undefined; });
}

self.addEventListener('install', (event) => {
  event.waitUntil(install());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('agent-interface-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
  // Warming does not start here: the browser may stop an idle worker once activation ends. It runs
  // under the WARM message below, which keeps the worker alive without delaying activation.
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'WARM') event.waitUntil(warm().catch(() => {}));
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
  if (LAZY_PATHS.has(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(url.pathname);
      if (cached) return cached;
      const response = await fetch(request);
      if (usable(response)) event.waitUntil(cache.put(url.pathname, response.clone()));
      return response;
    })());
    return;
  }
  if (!INSTALL_PATHS.has(url.pathname) || url.pathname === '/index.html') return;
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
