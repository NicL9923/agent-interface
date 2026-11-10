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

// A note in this release's cache that the server now has another shell. It lives and dies with the
// cache, so a stopped and restarted worker still sees it, and the next release starts without one.
// No request is ever answered from it: the fetch handler serves only the files listed above.
const OUTDATED = '/.shell-outdated';

// Today's rule, and the rule once the cached shell is known to be out of date: the server's shell,
// or this release's copy when the network fails.
async function networkShell(request, cache) {
  try { return await fetch(request); } catch { return (await cache.match('/index.html')) || Response.error(); }
}

// Compares the server's shell with this release's copy after the copy has answered. The server sends
// index.html as the file on disk, with nothing added per request, so the same release always sends
// the same text. Bodies are compared rather than ETags, which change whenever the file is copied.
// A different text notes it and runs the update check now. Anything but a 200, such as a redirect
// (not followed, so it is not ok), a refusal, a server error or no network, says nothing about the
// release and changes nothing: no window reloads and the worker stays.
async function revalidate(cache, copy) {
  try {
    const response = await fetch('/index.html', { cache: 'no-store', redirect: 'manual' });
    if (!response.ok) return;
    if (await response.text() === await copy.text()) return;
    await cache.put(OUTDATED, new Response(''));
  } catch { return; }
  await self.registration.update().catch(() => {});
}

// The app shell opens from this release's cache, which install fills all or nothing, so the page and
// every file it loads first come from one release, and a slow network never delays opening. Once the
// worker has seen a newer shell on the server, it opens the network's instead, so a person sees an
// old release at most once after a deploy, even when the new worker never manages to install.
async function openShell(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match('/index.html');
  if (!cached || await cache.match(OUTDATED)) return networkShell(event.request, cache);
  // Copied before the page reads the body, which can only be read once.
  event.waitUntil(revalidate(cache, cached.clone()));
  return cached;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Never intercept authenticated endpoints, including streams and downloads.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')) {
    event.respondWith(openShell(event));
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

// How long an open window has to say it switched to the chat. A live page answers within a few
// milliseconds (at most 2.1 ms over 30 tries in Chromium), or after the task it is busy with, so this
// allows a quarter-second stall. It must stay well under a second: Firefox lets a worker open or
// focus a window for one second after a tap, and on a second tap the fallbacks below, the last of
// which opens a new window, run after this wait.
const OPEN_ACK_MS = 250;
// How long the worker keeps listening after that, for a page that was busy and opens the chat late.
// Its answer then closes the notification the worker brought back for a second tap.
const OPEN_LATE_MS = 10_000;

// Answers heard, counted by window and address, so a tap can tell whether the page opened the chat
// for an earlier tap while this one waited.
const answered = new Map();
const answerKey = (client, url) => client.id + ' ' + url;

// Asks an open window to switch to the chat in place, as a click in it would, without reloading the
// app. Resolves true once the page says it did, however late within OPEN_LATE_MS, and false after
// that. src/app/worker-opens.ts answers it.
function askToOpen(client, url) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const done = (opened) => { clearTimeout(timer); channel.port1.close(); resolve(opened); };
    const timer = setTimeout(() => done(false), OPEN_LATE_MS);
    channel.port1.onmessage = () => {
      answered.set(answerKey(client, url), (answered.get(answerKey(client, url)) ?? 0) + 1);
      done(true);
    };
    try { client.postMessage({ type: 'OPEN_CHAT', url }, [channel.port2]); } catch { done(false); }
  });
}

// The answer if it comes within `ms`, otherwise false.
function within(answer, ms) {
  let timer;
  return Promise.race([answer, new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); })])
    .finally(() => clearTimeout(timer));
}

// Opens a tapped notification's chat. An open window is asked to switch in place. A window that does
// not answer in time is never reloaded on a first tap: its page may be busy with an edited form that
// a reload would lose. It stays as it is, focused, and the notification comes back. Tapping that one
// is the person asking a second time, and only then is a silent window loaded with the chat, or a new
// window opened, as for a window still running a release from before pages answered.
async function openChat(notification) {
  const url = conversationUrl(notification.data?.url);
  // Only a window this worker controls runs code that answers, and only such a window can be navigated.
  const windows = await self.clients.matchAll({ type: 'window' });
  const existing = windows.find((client) => client.focused) ?? windows.find((client) => client.visibilityState === 'visible') ?? windows[0];
  if (!existing) return self.clients.openWindow(url);
  // Focused first, since the browser allows it only shortly after the tap. A failure is kept.
  const focused = existing.focus().then(() => true, () => false);
  const earlier = answered.get(answerKey(existing, url)) ?? 0;
  const answer = askToOpen(existing, url);
  if (await within(answer, OPEN_ACK_MS)) {
    // A hidden window that switched but cannot come forward shows nothing, so the chat opens in a
    // new one. A visible window already shows it.
    if (!await focused && existing.visibilityState !== 'visible') await self.clients.openWindow(url);
    return;
  }
  await focused;
  if (!notification.data?.reshown) {
    await showAgain(notification);
    // The page opened the chat after all, so the notification brought back for it goes.
    if (await answer) await closeShownAgain(notification);
    return;
  }
  // The second tap. A page that opened the chat for the first one while this one waited has done
  // what was asked, and loading the chat over it would open it twice.
  if ((answered.get(answerKey(existing, url)) ?? 0) > earlier) return;
  try {
    await existing.navigate(url);
    return;
  } catch { /* Closed meanwhile, or no longer this worker's. */ }
  await self.clients.openWindow(url);
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

// The chat did not open, because every way of opening it failed or the open window did not answer.
// The notification is already closed, so it comes back, quietly, for the person to tap again. A tap
// on one that came back is not shown a third time, so a browser that always refuses cannot chain them.
async function showAgain(notification) {
  if (notification.data?.reshown) return;
  await self.registration.showNotification(notification.title, {
    body: notification.body,
    icon: notification.icon,
    badge: notification.badge,
    tag: notification.tag,
    actions: notification.actions,
    silent: true,
    data: { ...notification.data, reshown: true },
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'decline' && event.notification.data?.declineToken) {
    event.waitUntil(decline(event.notification));
    return;
  }
  // A way of opening that failed, such as a refused new window, brings the notification back.
  event.waitUntil(openChat(event.notification).catch(() => showAgain(event.notification)));
});

// Closes the notification showAgain brought back for this chat. A failure leaves it to be tapped,
// which asks the page again; it never shows the notification once more.
async function closeShownAgain(notification) {
  try {
    const shown = await self.registration.getNotifications(notification.tag ? { tag: notification.tag } : {});
    for (const each of shown) if (each.data?.reshown && each.data.url === notification.data?.url) each.close();
  } catch { /* See above. */ }
}
