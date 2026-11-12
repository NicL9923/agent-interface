/*
 * Runs from index.html's <head>, before the app's bundle has downloaded. It does two things the bundle
 * would otherwise do only once it has run:
 * - applies the theme this device last showed the signed-in person, so a dark theme never opens light,
 *   unless another tab's sign-in or sign-out is under way;
 * - starts the app's first read, its bootstrap, and leaves it on window for src/startup-read.ts to take,
 *   with the account record (src/app/account-epoch.ts) it started under. The app takes it only while
 *   that record is unchanged, and no read starts while another tab's sign-in or sign-out is under way;
 * - beside it, for an address that names a chat, reads that chat's first page by src/app/linked-chat.ts's
 *   rules, so a phone's chat read no longer waits for the bundle to download and run.
 * It is served as written, without the build's transforms, so it uses only what every browser the app
 * supports runs. The service worker installs it with the shell it belongs to. Its names and formats
 * match src/app/storage.ts and src/startup-read.ts; tests/startup-read.test.ts runs this file against them.
 */
(function () {
  'use strict';
  function read(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (error) { return null; }
  }
  // The account this browser's sign-in last named, by linked-chat.ts's rule: a record that has not
  // lapsed, with its chat list, naming an account.
  function hintedUser() {
    var hint = read('agent-interface:sign-in-hint');
    if (!hint || typeof hint !== 'object' || typeof hint.until !== 'number' || !Array.isArray(hint.bots)) return null;
    if (typeof hint.user !== 'string' || hint.until <= Date.now()) return null;
    return hint.user;
  }
  // The chat the address names, when linked-chat.ts's prefetchLinkedChat would read it as the bundle starts: a
  // conversation view (src/app/view.ts initialView), not a link to one message (initialMessage), on a shown
  // page that is online (conversation-page.ts prefetchFirstPage), and one this browser's sign-in lists.
  function linkedChat() {
    try {
      var query = new URLSearchParams(location.search);
      var bot = query.get('bot'), view = query.get('view');
      if (!bot || query.get('message') || view === 'today' || view === 'find' || view === 'group' && query.get('room')) return null;
      if (document.visibilityState === 'hidden' || navigator.onLine === false) return null;
      var hint = read('agent-interface:sign-in-hint');
      return hintedUser() && hint.bots.indexOf(bot) >= 0 ? bot : null;
    } catch (error) { return null; /* The bundle reads the chat itself. */ }
  }
  // Another tab's sign-in or sign-out is on its way, so the cookie may already be another account's. A
  // mark older than account-epoch.ts's CHANGE_STALE_MS belongs to a closed tab.
  function changing() {
    var record = read('agent-interface:auth-epoch');
    return !!record && typeof record === 'object' && record.changing === true && typeof record.at === 'number' && Date.now() - record.at < 65000;
  }
  try {
    // While a change is on its way the app's first draw shows the system's theme too (src/App.tsx).
    var user = !changing() && hintedUser();
    var saved = user && read('agent-interface:theme');
    if (saved && saved.v === 1 && saved.user === user && (saved.theme === 'light' || saved.theme === 'dark' || saved.theme === 'system'))
      document.documentElement.setAttribute('data-theme', saved.theme);
  } catch (error) { /* The page's default theme stays until bootstrap answers. */ }
  try {
    if (window.__wildbotsStartup !== undefined || typeof fetch !== 'function') return;
    // The account record as text, compared whole by the app; none, or blocked storage, is ''.
    var epoch = '';
    try { epoch = localStorage.getItem('agent-interface:auth-epoch') || ''; } catch (error) { /* As the app reads it. */ }
    // The cookie this read would carry may be the last account's.
    if (changing()) return;
    // The same request the app's api() makes for its first GET: no validator, no CSRF token, the cookie.
    var start = function (path) {
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var response = fetch('/api' + path, { credentials: 'same-origin', cache: 'no-store', signal: controller ? controller.signal : undefined });
      // A failure is the app's to handle once it takes the read; until then it is not an unhandled one.
      response.catch(function () {});
      return { path: path, response: response, abort: function () { if (controller) controller.abort(); } };
    };
    var reads = [start('/bootstrap?roster=lean')];
    var chat = linkedChat();
    if (chat) reads.push(start('/bots/' + encodeURIComponent(chat) + '/conversation?turns=20'));
    var startup = { version: 3, epoch: epoch, reads: reads };
    window.__wildbotsStartup = startup;
    // A bundle that never asks for them, as from another release, lets them go.
    setTimeout(function () {
      if (window.__wildbotsStartup !== startup) return;
      window.__wildbotsStartup = undefined;
      for (var index = 0; index < startup.reads.length; index++) startup.reads[index].abort();
    }, 60000);
  } catch (error) { /* The app reads bootstrap itself, as it does without this file. */ }
})();
