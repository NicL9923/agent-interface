/*
 * Runs from index.html's <head>, before the app's bundle has downloaded. It does two things the bundle
 * would otherwise do only once it has run:
 * - applies the theme this device last showed the signed-in person, so a dark theme never opens light;
 * - starts the app's first read, its bootstrap, and leaves it on window for src/startup-read.ts to take.
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
  try {
    var user = hintedUser();
    var saved = user && read('agent-interface:theme');
    if (saved && saved.v === 1 && saved.user === user && (saved.theme === 'light' || saved.theme === 'dark' || saved.theme === 'system'))
      document.documentElement.setAttribute('data-theme', saved.theme);
  } catch (error) { /* The page's default theme stays until bootstrap answers. */ }
  try {
    if (window.__wildbotsStartup !== undefined || typeof fetch !== 'function') return;
    var path = '/bootstrap?roster=lean';
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    // The same request the app's api() makes for its first GET: no validator, no CSRF token, the cookie.
    var response = fetch('/api' + path, { credentials: 'same-origin', cache: 'no-store', signal: controller ? controller.signal : undefined });
    // A failure is the app's to handle once it takes the read; until then it is not an unhandled one.
    response.catch(function () {});
    var startup = { version: 1, path: path, response: response, abort: function () { if (controller) controller.abort(); } };
    window.__wildbotsStartup = startup;
    // A bundle that never asks for it, as from another release, lets it go.
    setTimeout(function () {
      if (window.__wildbotsStartup !== startup) return;
      window.__wildbotsStartup = undefined;
      startup.abort();
    }, 60000);
  } catch (error) { /* The app reads bootstrap itself, as it does without this file. */ }
})();
