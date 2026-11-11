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
//
// The order of the account's steps. Each ACCOUNT message takes a new generation as it arrives, and
// `account` becomes its word at once, so a push that reads the account from then on reads that word.
// Every step that writes the saved account, closes a notification or sets or clears the badge runs
// on one chain (`serially`), one step at a time in the order they were queued, and after each await
// it stops without acting if a newer message has arrived: that message's own step is queued behind
// it and does the work for the newer word. A badge call is made with no await between it and the
// check that allows it. So, once the chain is idle, relative to the latest ACCOUNT message:
// - Cache Storage holds its word, so a worker started again judges pushes by it.
// - No notification of another account is listed: the latest word's step closed what was listed, and
//   a push whose notification was still on its way checks again on the chain once it is listed.
// - No notification of its account was closed after it arrived: a step for an older word stops first.
// - The badge is unset or was set by a push for that account. A push sets it only on the chain while
//   its account is the latest, and a step for a new word clears a badge a push of another account
//   set, as Cache Storage records, so no push of a departed account can set the badge or clear the
//   latest account's. The worker changes the badge only for a push: a badge the page set is the
//   page's (src/app/badge.ts).
// When the browser refuses a write of the saved account, Cache Storage keeps the older word until a
// later step's write succeeds; the step still closes the departed account's notifications, and the page
// repeats its word at the next account change or start, which writes it.
// Known limit: all of this holds for one worker instance. While a release updates, the old worker
// can still be running steps it held across the new worker's activation, and the two share the saved
// account and the badge's owner but not this chain, generation or memory. An old instance's step
// can write a word the new one already overtook, or close a notification the new one allows, until
// the browser stops it. The page tells its word again whenever its account generation starts
// (src/app/account-epoch.ts), which puts the newest word back in the cache.
const ACCOUNT_CACHE = 'wildbots-account';
const ACCOUNT_KEY = '/account';
let generation = 0;
// What the cache holds, as this worker last read or wrote it.
let saved;
const readSaved = () => saved ??= caches.open(ACCOUNT_CACHE).then((cache) => cache.match(ACCOUNT_KEY))
  .then((found) => found ? found.json() : null).catch(() => null);
// The latest word: the saved one until a page says.
let account;
const loadAccount = () => account ??= readSaved();
// The latest word, for a read that a page's ACCOUNT message overtakes while it waits.
async function readAccount() {
  for (;;) {
    const reading = loadAccount();
    const state = await reading;
    if (reading === account) return state;
  }
}

let chain = Promise.resolve();
// Runs `step` after every step queued before it. Resolves with its result, or undefined if it threw.
function serially(step) {
  const run = chain.then(step).catch(() => undefined);
  chain = run;
  return run;
}

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

// The account whose push set the badge, as { named }, or null when no push set one that is still up.
// It is kept beside the account, so a worker started again clears only a badge a push of its set, and
// a page's own badge is the page's to change.
const BADGE_KEY = '/badge';
let badgeFor;
const readBadge = () => badgeFor ??= caches.open(ACCOUNT_CACHE).then((cache) => cache.match(BADGE_KEY))
  .then((found) => found ? found.json() : null).catch(() => null);
// Recorded once the badge changed, in the same step, so the next step reads the owner of the badge
// on screen. The browser keeps the worker running until the step ends.
async function keepBadgeFor(owner) {
  badgeFor = Promise.resolve(owner);
  const cache = await caches.open(ACCOUNT_CACHE);
  await cache.put(BADGE_KEY, new Response(JSON.stringify(owner)));
}
function clearBadge() {
  void self.navigator?.clearAppBadge?.().catch(() => {});
  return keepBadgeFor(null);
}

function setAccount(user) {
  const at = ++generation;
  account = (typeof user === 'string' && user ? accountMarker(user).then((marker) => ({ marker })) : Promise.resolve({ signedOut: true }))
    // A browser that cannot hash keeps today's rule rather than dropping every notification.
    .catch(() => null);
  return serially(() => settleAccount(at));
}

// Brings the cache, the screen and the badge to the word of generation `at`. It stops at a newer word,
// whose own step, queued behind this one, finishes the work. A write or a badge clear the browser
// refuses does not stop it from closing what the departed account has on screen: the saved account
// stays as it was, so the next step writes it again.
async function settleAccount(at) {
  const state = await loadAccount();
  const previous = await readSaved();
  const owner = await readBadge();
  // Not redundant: a word that arrives during the reads leaves `state` the older word, which the
  // badge clear below would judge the badge by. A step for an older word that the newest overtook
  // would clear the newest account's badge (service-worker.test.ts, "words two, one, two, one").
  if (at !== generation) return;
  if (JSON.stringify(previous) !== JSON.stringify(state)) {
    try {
      const cache = await caches.open(ACCOUNT_CACHE);
      if (at !== generation) return;
      await cache.put(ACCOUNT_KEY, new Response(JSON.stringify(state)));
      saved = Promise.resolve(state);
    } catch { /* Storage refused: close what must close, and let the next step write again. */ }
    if (at !== generation) return;
  }
  if (owner && !mayShow(state, owner.named)) {
    try { await clearBadge(); } catch { /* The badge is clear; only its record was refused. */ }
    if (at !== generation) return;
  }
  const shown = await self.registration.getNotifications();
  if (at !== generation) return;
  // Notifications on screen for another account, or any once signed out, close.
  for (const notification of shown) if (!mayShow(state, notification.data?.account)) notification.close();
}

// A push whose notification is on screen, or failed to show, once every step queued before it has
// run. Its account may have changed meanwhile: then what it showed closes, and its badge is never set.
// A word that arrives during this step queues its own step behind it, which closes the notification
// if that word does not allow it.
function settlePush(named, count) {
  return serially(async () => {
    const at = generation;
    const state = await loadAccount();
    if (at !== generation) return;
    if (!mayShow(state, named)) return settleAccount(at);
    // The server counts the badge with the push; a payload without one leaves the badge alone.
    if (!Number.isInteger(count) || count < 0 || !self.navigator?.setAppBadge) return;
    if (!count) return clearBadge();
    // No await between the check above and the call.
    void self.navigator.setAppBadge(count).catch(() => {});
    return keepBadgeFor({ named });
  });
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

const BOOT = '/boot.js';
// public/boot.js blocks the page's <head>, before any of the app's code or deadlines exist, so a
// stalled download would leave a blank page until the browser gave up. This release's copy always
// answers, at once, even after the shell is noted as out of date and opens from the network: a
// boot.js of another release is safe, since the app takes its read only when it is the read the app
// would make, so the worst case is one extra bootstrap read. Only a worker with no copy asks the network.
async function openBoot(request) {
  const cached = await (await caches.open(CACHE)).match(BOOT);
  return cached || fetch(request);
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
  if (url.pathname === BOOT) {
    event.respondWith(openBoot(request));
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
  event.waitUntil((async () => {
    if (!mayShow(await readAccount(), named)) return;
    try {
      await self.registration.showNotification(String(data.title || 'WildBots').slice(0, 100), {
        body: String(data.body || 'Your assistant has an update.').slice(0, 240),
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: typeof data.tag === 'string' ? data.tag : undefined,
        data: { url, ...(named ? { account: named } : {}), ...(declineToken ? { declineToken } : {}) },
        ...(declineToken ? { actions: [{ action: 'review', title: 'Review' }, { action: 'decline', title: 'Decline' }] } : {}),
      });
    } catch { /* Nothing on screen, but the count still stands for the account it is for. */ }
    await settlePush(named, data.badge);
  })());
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
// The account is checked again before each display, so a notification of an account that left never
// flashes, and on the chain once it is on screen, which closes it if the account left while it was on
// its way. A notification of one account may not come back under another's.
async function restore(notification, url, attempt) {
  attempt.restoring = true;
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, RESTORE_MS); });
  const account = notification.data?.account;
  const again = async () => {
    if (mayShow(await readAccount(), account)) await showAgain(notification, url);
  };
  const shown = again().catch(again).catch(() => {}).then(() => settlePush(account));
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
  // The notice is for the account whose approval this was, which may have left during the request.
  const account = notification.data?.account;
  if (!mayShow(await readAccount(), account)) return;
  try {
    await self.registration.showNotification("Couldn't decline", {
      body: 'Open the chat to review the request.',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: (notification.tag || 'approval') + ':decline',
      data: { url, ...(account ? { account } : {}) },
    });
  } catch { /* The browser refused to store it, as it can for any notification: nothing more to show. */ }
  // The notice may have reached the screen after its account left.
  await settlePush(account);
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
