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
  if (event.data?.type === 'ACCOUNT') event.waitUntil(setAccount(event.data.user));
});

// Which account this browser may show notifications for, as its pages last said (src/app/account-epoch.ts):
// { marker } for a signed-in account, { signedOut: true } for none, or null before any page has said.
// The server names each push's account with the same marker as its APNs payloads (src/server/apns.ts),
// a hash of the account ID. It is kept in a cache of its own, which survives the worker being stopped
// and a release replacing it; its name does not start with 'agent-interface-', so activation keeps it.
const ACCOUNT_CACHE = 'wildbots-account';
const ACCOUNT_KEY = '/account';
let account;
const readAccount = () => account ??= caches.open(ACCOUNT_CACHE).then((cache) => cache.match(ACCOUNT_KEY))
  .then((saved) => saved ? saved.json() : null).catch(() => null);

async function accountMarker(user) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('wildbots-account:' + user));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

// A push or notification is for the account signed in here: before any page said, as before; signed
// out, none; otherwise one that names this account, or names none, as a push from an older server.
function mayShow(state, named) {
  if (!state) return true;
  if (state.signedOut) return false;
  return typeof named !== 'string' || named === state.marker;
}

// A push that arrives meanwhile waits for the new account, so it is judged by the latest word.
function setAccount(user) {
  const before = readAccount();
  const next = (typeof user === 'string' && user ? accountMarker(user).then((marker) => ({ marker })) : Promise.resolve({ signedOut: true }))
    // A browser that cannot hash keeps today's rule rather than dropping every notification.
    .catch(() => null);
  account = next;
  return (async () => {
    const [previous, state] = await Promise.all([before, next]);
    if (JSON.stringify(previous) === JSON.stringify(state)) return;
    const cache = await caches.open(ACCOUNT_CACHE);
    await cache.put(ACCOUNT_KEY, new Response(JSON.stringify(state)));
    // Notifications already on screen for another account, or any once signed out, close.
    for (const shown of await self.registration.getNotifications()) if (!mayShow(state, shown.data?.account)) shown.close();
  })().catch(() => {});
}

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

// A push for an account that is not signed in here, which the server can send until it learns the
// subscription is gone, shows nothing and leaves the badge alone.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { /* A malformed payload still opens the app. */ }
  const url = conversationUrl(data.url);
  const declineToken = data.kind === 'approval' && typeof data.declineToken === 'string' && canAct() ? data.declineToken : undefined;
  const named = typeof data.account === 'string' ? data.account : undefined;
  event.waitUntil(readAccount().then((state) => mayShow(state, named) && Promise.all([
    self.registration.showNotification(String(data.title || 'WildBots').slice(0, 100), {
      body: String(data.body || 'Your assistant has an update.').slice(0, 240),
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      data: { url, ...(named ? { account: named } : {}), ...(declineToken ? { declineToken } : {}) },
      ...(declineToken ? { actions: [{ action: 'review', title: 'Review' }, { action: 'decline', title: 'Decline' }] } : {}),
    }),
    showBadge(data.badge),
  ])));
});

// How long an open window has to say it switched to the chat. A live page answers within a few
// milliseconds (at most 2.1 ms over 30 tries in Chromium), or after the task it is busy with, so this
// allows a quarter-second stall. It must stay well under a second: Firefox lets a worker open or
// focus a window for one second after a tap, and on a tap of a notification that came back the
// fallbacks below, the last of which opens a new window, run after this wait.
const OPEN_ACK_MS = 250;

// Asks an open window to switch to the chat in place, as a click in it would, without reloading the
// app. Resolves true if the page says it did within OPEN_ACK_MS, otherwise false; an answer after
// that is not heard. src/app/worker-opens.ts answers it.
function askToOpen(client, url) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const done = (opened) => { clearTimeout(timer); channel.port1.close(); resolve(opened); };
    const timer = setTimeout(() => done(false), OPEN_ACK_MS);
    channel.port1.onmessage = () => done(true);
    try { client.postMessage({ type: 'OPEN_CHAT', url }, [channel.port2]); } catch { done(false); }
  });
}

// Opens a tapped notification's chat. Every tap ends one of two ways: a window known to be in front
// shows the chat, or the notification is on screen again. "In front" means the window was focused
// already or its focus() succeeded; a browser covered by another application still reports itself
// visible, so visible is not enough. A window just opened with openWindow is in front.
//
// | Rule | Window this worker controls          | Then                                                           |
// | ---- | ------------------------------------ | -------------------------------------------------------------- |
// | 1    | none                                 | openWindow. If that fails, the notification comes back.        |
// | 2    | answers within OPEN_ACK_MS           | The chat is open in it. In front: done. If not, it comes back. |
// | 3    | no answer in time, first tap         | The window is left as it is and a focus attempted. The         |
// |      |                                      | notification comes back, marked as having come back.           |
// | 4    | no answer in time, tap on a marked   | navigate the window, or openWindow if that fails. Then, unless |
// |      | notification                         | a window is known to be in front, the notification comes back. |
//
// A first tap never replaces the document of a window that has not answered: its page may be busy
// with an edited form a reload would lose. If that page answers late, the chat opens and the
// notification that came back stays until the person dismisses it, or taps it and gets a prompt
// answer. The notification comes back only as the direct result of a tap, so it cannot loop on its
// own. A tap on a chat that already has an attempt in flight joins that attempt, so two taps never
// ask, navigate, open a window or bring the notification back twice.
// A tap that arrives while the attempt is bringing the notification back may be a tap on that very
// notification, so it starts a new attempt at once, without waiting for the display, and later taps
// join the new one. The replaced attempt's taps end when the new attempt does, or sooner, so its
// display never keeps the worker alive longer than the new attempt, which waits on its own display
// for at most RESTORE_MS. Every notification brought back for a chat carries that chat's one tag,
// so a late display and the new attempt's leave one notification, not two.
// Bringing the notification back is retried once. Two cases the invariant does not cover, both
// ending every tap on the attempt with nothing on screen: the retry fails too, or the browser has
// neither shown the notification nor refused it by RESTORE_MS. In the second the worker only stops
// waiting, so the notification still appears if the browser finishes later.
const attempts = new Map();
function openChat(notification) {
  const url = conversationUrl(notification.data?.url);
  const current = attempts.get(url);
  if (current && !current.restoring) return current.done;
  const attempt = { restoring: false, done: undefined, replace: undefined };
  const replaced = new Promise((resolve) => { attempt.replace = resolve; });
  const run = reach(notification, url)
    // A way of opening that failed unexpectedly has not reached the person either.
    .catch(() => false)
    .then((inFront) => inFront || restore(notification, url, attempt));
  // A replaced attempt's display may settle before its replacement ends, and must not clear it.
  attempt.done = Promise.race([run, replaced]).finally(() => { if (attempts.get(url) === attempt) attempts.delete(url); });
  current?.replace(attempt.done);
  attempts.set(url, attempt);
  return attempt.done;
}

// How long a tap waits for the notification it brings back to be stored. That takes milliseconds,
// and browsers may show the notification before showNotification() settles, so a display that never
// settles would only keep the worker running until the browser stopped it. Ten seconds leaves a slow
// phone plenty of room.
const RESTORE_MS = 10_000;

// Chromium rejects showNotification when it cannot store the notification, so it is tried once more.
async function restore(notification, url, attempt) {
  attempt.restoring = true;
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, RESTORE_MS); });
  const shown = showAgain(notification, url).catch(() => showAgain(notification, url)).catch(() => {});
  await Promise.race([shown, deadline]);
  clearTimeout(timer);
}

// Follows the table above. True when a window known to be in front shows the chat.
async function reach(notification, url) {
  // Only a window this worker controls runs code that answers, and only such a window can be navigated.
  const windows = await self.clients.matchAll({ type: 'window' });
  const existing = windows.find((client) => client.focused) ?? windows.find((client) => client.visibilityState === 'visible') ?? windows[0];
  if (!existing) return openNew(url);
  // Focused first, since the browser allows it only shortly after the tap.
  const focusing = existing.focus().then(() => true, () => false);
  const answered = await askToOpen(existing, url);
  const front = existing.focused || await focusing;
  if (answered) return front;
  if (!notification.data?.reshown) return false;
  try {
    await existing.navigate(url);
    return front;
  } catch { /* Closed meanwhile, or no longer this worker's. */ }
  return openNew(url);
}

const openNew = (url) => self.clients.openWindow(url).then(() => true, () => false);

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

// No window known to be in front shows the chat. The notification is already closed, so it comes
// back, quietly and marked, for the person to tap again; a tap on it is rule 4 above. Its tag names
// the chat, so it replaces only a notification brought back for the same chat. The server tags each
// push with its own event ID, and a failed decline's notification ends in ":decline", which no
// address does, so it never replaces news the person has not seen.
async function showAgain(notification, url) {
  await self.registration.showNotification(notification.title, {
    body: notification.body,
    icon: notification.icon,
    badge: notification.badge,
    tag: 'reshown:' + url,
    actions: notification.actions,
    silent: true,
    data: { ...notification.data, reshown: true },
  });
}

// A notification for an account no longer signed in here acts for nobody: Decline sends nothing,
// and a tap brings the app forward without opening that account's chat.
async function openApp() {
  const [existing] = await self.clients.matchAll({ type: 'window' });
  if (existing) await existing.focus().catch(() => {});
  else await self.clients.openWindow(self.location.origin + '/').catch(() => {});
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(readAccount().then((state) => {
    if (!mayShow(state, event.notification.data?.account)) return event.action === 'decline' ? undefined : openApp();
    if (event.action === 'decline' && event.notification.data?.declineToken) return decline(event.notification);
    return openChat(event.notification);
  }));
});
