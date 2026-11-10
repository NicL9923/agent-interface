import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { isHashedAsset } from '../src/server/static-cache';

const INSTALL = ['/index.html', '/assets/app-a1234567.js', '/icon-192.png', '/assets/vendor.js'];
const WARM = ['/assets/panel-b1234567.js', '/assets/panel-c1234567.css'];
const ON_DEMAND = ['/assets/xterm-d1234567.js'];
const script = (install = INSTALL, warm = WARM, onDemand = ON_DEMAND) => readFileSync('scripts/service-worker.js', 'utf8')
  .replace('__BUILD_ID__', 'test')
  .replace('__PRECACHE__', JSON.stringify(install))
  .replace('__WARM__', JSON.stringify(warm))
  .replace('__ON_DEMAND__', JSON.stringify(onDemand));
const js = (body = 'export {}') => new Response(body, { headers: { 'content-type': 'text/javascript' } });
const html = () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
// A healthy server: pages are HTML and everything else is code or an image.
const healthy = (path: string) => Promise.resolve(path.endsWith('.html') ? html() : js(path));

// A MessageChannel as the worker sees one: a message reaches the other port in a later task, and
// none arrives once the receiving port is closed.
class FakeMessageChannel {
  readonly port1 = { onmessage: null as ((event: { data: unknown }) => void) | null, closed: false, close() { this.closed = true; } };
  readonly port2 = { postMessage: (data: unknown) => { queueMicrotask(() => { if (!this.port1.closed) this.port1.onmessage?.({ data }); }); } };
}
type Port = FakeMessageChannel['port2'];
// An open window of the app. `controlled` says whether this worker controls it; `answers` whether its page
// says it opened what it was asked to at once. A page that does not can still answer later on `ports`.
type Window = { id: string; url: string; controlled: boolean; answers: boolean; focused?: boolean; visibilityState?: string; ports: Port[]; postMessage: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>; navigate: ReturnType<typeof vi.fn> };
let windowIds = 0;
const openWindowOf = ({ url = 'https://app.example/?bot=home', controlled = true, answers = true, focused = false } = {}): Window => {
  const client: Window = {
    id: `window-${++windowIds}`, url, controlled, answers, focused, visibilityState: 'hidden', ports: [],
    postMessage: vi.fn((_data: unknown, [port]: Port[]) => { client.ports.push(port); if (client.answers) port.postMessage({ opened: true }); }),
    focus: vi.fn(async () => client),
    navigate: vi.fn(async () => client),
  };
  return client;
};
type Shown = { title: string; tag?: string; data?: Record<string, unknown>; close: ReturnType<typeof vi.fn> };
type Stores = Map<string, Map<string, unknown>>;
/**
 * Runs the worker script in a fresh context. Passing `stores` starts it over cache storage an earlier
 * run left, as when the browser stops an idle worker and starts it again for the next event.
 */
function worker(options: { maxActions?: number; older?: Record<string, Record<string, Response>>; windows?: Window[]; stores?: Stores } = {}) {
  const handlers: Record<string, (event: any) => void> = {};
  const setAppBadge = vi.fn().mockResolvedValue(undefined), clearAppBadge = vi.fn().mockResolvedValue(undefined);
  // Notifications on screen, as getNotifications lists them. Showing one with a tag replaces the last.
  const shown: Shown[] = [];
  const showNotification = vi.fn(async (title: string, options: any = {}) => {
    const notification: Shown = { title, tag: options.tag, data: options.data, close: vi.fn(() => { shown.splice(shown.indexOf(notification), 1); }) };
    if (options.tag) shown.splice(0, shown.length, ...shown.filter(other => other.tag !== options.tag));
    shown.push(notification);
  });
  const getNotifications = vi.fn(async ({ tag }: { tag?: string } = {}) => shown.filter(each => tag === undefined || each.tag === tag));
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const claim = vi.fn().mockResolvedValue(undefined);
  const clients = { matchAll: async (query: { includeUncontrolled?: boolean } = {}) => (options.windows ?? []).filter(client => client.controlled || query.includeUncontrolled), openWindow, claim };
  const update = vi.fn().mockResolvedValue(undefined), unregister = vi.fn().mockResolvedValue(true);
  const fetch = vi.fn().mockRejectedValue(new Error('offline'));
  // Installing needs the network; tests of later steps keep the default of being offline.
  // Cache storage by name. The current release's cache starts with its app shell, as after an install.
  const stores: Stores = options.stores ?? new Map([['agent-interface-test', new Map<string, unknown>([['/index.html', new Response('static shell', { headers: { 'content-type': 'text/html' } })]])]]);
  for (const [name, entries] of Object.entries(options.older ?? {})) stores.set(name, new Map(Object.entries(entries)));
  const match = vi.fn();
  const put = vi.fn();
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      // Like the Cache API, each match is a new response whose body can be read on its own.
      match: async (key: string) => { if (name === 'agent-interface-test') match(key); const value = store.get(key); return value instanceof Response ? value.clone() : value; },
      put: async (key: string, value: unknown) => { put(key, value); store.set(key, value); },
    };
  };
  const context = {
    self: {
      location: { origin: 'https://app.example' },
      addEventListener: (type: string, handler: (event: any) => void) => { handlers[type] = handler; },
      registration: { showNotification, getNotifications, update, unregister },
      clients,
      navigator: { setAppBadge, clearAppBadge },
      Notification: { maxActions: options.maxActions ?? 0 },
    },
    caches: { open, has: async (name: string) => stores.has(name), keys: async () => [...stores.keys()], delete: async (name: string) => stores.delete(name) },
    URL, Response, fetch, MessageChannel: FakeMessageChannel, crypto: globalThis.crypto, TextEncoder,
    // Read at call time, so a test's fake timers apply inside the worker too.
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
  vm.runInNewContext(script(), context);
  const run = async (type: 'install' | 'activate') => {
    let waited: Promise<unknown> | undefined;
    handlers[type]({ waitUntil: (value: Promise<unknown>) => { waited = value; } });
    await waited;
  };
  // The page's request to warm. Returns what the worker handed to waitUntil, or undefined when it did not.
  const warm = () => {
    let waited: Promise<unknown> | undefined;
    handlers.message({ data: { type: 'WARM' }, waitUntil: (value: Promise<unknown>) => { waited = value; } });
    return waited;
  };
  const install = () => { fetch.mockImplementation(healthy); return run('install'); };
  // A navigation to the app. Returns its answer and whatever the worker left running after it.
  const navigate = async (url = 'https://app.example/') => {
    let response: Promise<unknown> | undefined;
    const background: Promise<unknown>[] = [];
    handlers.fetch({ request: { url, method: 'GET', mode: 'navigate' }, respondWith: (value: Promise<unknown>) => { response = value; }, waitUntil: (value: Promise<unknown>) => background.push(value) });
    const answer = await response;
    await Promise.all(background);
    return answer as Response;
  };
  // A page's word on which account is signed in, or null after a sign-out. Resolves once the worker kept it.
  const signedIn = (user: string | null) => {
    let waited: Promise<unknown> | undefined;
    handlers.message({ data: { type: 'ACCOUNT', user }, waitUntil: (value: Promise<unknown>) => { waited = value; } });
    return waited;
  };
  return { handlers, fetch, match, put, stores, claim, clients, install, tryInstall: () => run('install'), activate: () => run('activate'), warm, navigate, showNotification, shown, openWindow, setAppBadge, clearAppBadge, update, unregister, signedIn };
}

describe('service worker privacy and return path', () => {
  it('does not intercept API, generated downloads, POSTs or external resources', () => {
    const { handlers } = worker();
    for (const [url, method] of [
      ['https://app.example/api/bootstrap', 'GET'],
      ['https://app.example/api/files/private-file', 'GET'],
      ['https://app.example/api/events', 'GET'],
      ['https://app.example/assets/app-a1234567.js', 'POST'],
      ['https://other.example/assets/app-a1234567.js', 'GET'],
    ]) {
      const respondWith = vi.fn();
      handlers.fetch({ request: { url, method, mode: 'cors' }, respondWith });
      expect(respondWith).not.toHaveBeenCalled();
    }
  });

  it('installs only the app shell and the entry code, leaving lazy and admin-only code to later', async () => {
    const { install, fetch, stores } = worker();
    await install();
    expect(fetch.mock.calls.map(([path]) => path).sort()).toEqual([...INSTALL].sort());
    const kept = [...stores.get('agent-interface-test')!.keys()];
    expect(kept.sort()).toEqual([...INSTALL].sort());
  });

  it('refuses to install when a code file comes back as HTML, so the browser retries and the old worker stays', async () => {
    const sw = worker();
    // A new release: no cache of its own yet.
    sw.stores.delete('agent-interface-test');
    sw.fetch.mockImplementation((path: string) => path === '/assets/app-a1234567.js' ? Promise.resolve(html()) : healthy(path));
    await expect(sw.tryInstall()).rejects.toThrow('/assets/app-a1234567.js');
    // Nothing from the failed attempt is left looking like a finished release.
    expect(sw.stores.has('agent-interface-test')).toBe(false);
  });

  it('keeps the serving cache when a reinstall of the same release fails, as after a rollback', async () => {
    const sw = worker();
    // The harness starts with this release's cache holding its shell, as when its worker is active.
    sw.fetch.mockImplementation((path: string) => path === '/index.html' ? Promise.reject(new Error('offline')) : healthy(path));
    await expect(sw.tryInstall()).rejects.toThrow();
    sw.fetch.mockRejectedValue(new Error('offline'));
    expect(await (await sw.navigate()).text()).toBe('static shell');
  });

  it.each([['an error status', () => new Response('gone', { status: 404 })], ['a failed fetch', () => { throw new Error('offline'); }]])('refuses to install on %s', async (_name, bad) => {
    const sw = worker();
    sw.fetch.mockImplementation((path: string) => path === '/icon-192.png' ? Promise.resolve().then(bad) : healthy(path));
    sw.stores.delete('agent-interface-test');
    await expect(sw.tryInstall()).rejects.toThrow();
    expect(sw.stores.has('agent-interface-test')).toBe(false);
  });

  it('stores each install file as it arrives, so a limit on connections cannot stall the install', async () => {
    const sw = worker();
    // Two connections, each busy until its response body is read, as when the cache stores it.
    let free = 2;
    const queued: (() => void)[] = [];
    sw.fetch.mockImplementation(async (path: string) => {
      if (free) free--; else await new Promise<void>(resolve => queued.push(resolve));
      return healthy(path);
    });
    sw.put.mockImplementation(() => { const next = queued.shift(); if (next) next(); else free++; });
    const stalled = new Promise(resolve => setTimeout(() => resolve('stalled'), 300));
    await expect(Promise.race([sw.tryInstall().then(() => 'installed'), stalled])).resolves.toBe('installed');
  });

  it('installs a page-level file whatever its content type, since only bundles can be missing', async () => {
    const sw = worker();
    // A server without a manifest type answers it as HTML; that must not block every install.
    sw.fetch.mockImplementation((path: string) => path === '/icon-192.png' ? Promise.resolve(html()) : healthy(path));
    await expect(sw.tryInstall()).resolves.toBeUndefined();
  });

  it('still installs the HTML pages as HTML', async () => {
    const install = ['/index.html', '/native-computer.html', '/assets/app-a1234567.js'];
    const handlers: Record<string, (event: any) => void> = {};
    const stored = new Map<string, Response>();
    vm.runInNewContext(script(install), {
      self: { location: { origin: 'https://app.example' }, addEventListener: (type: string, handler: (event: any) => void) => { handlers[type] = handler; } },
      caches: { has: async () => false, keys: async () => [], open: async () => ({ match: async () => undefined, put: async (key: string, value: Response) => { stored.set(key, value); } }) },
      URL, Response, fetch: healthy,
    });
    let installed: Promise<unknown> | undefined;
    handlers.install({ waitUntil: (value: Promise<unknown>) => { installed = value; } });
    await installed;
    expect([...stored.keys()].sort()).toEqual([...install].sort());
    expect(stored.get('/native-computer.html')!.headers.get('content-type')).toBe('text/html');
  });

  it.each([['a lazy screen', WARM[0]], ['an admin-only chunk', ON_DEMAND[0]]])('keeps %s after its first use so it works offline later', async (_name, path) => {
    const { handlers, fetch, put } = worker();
    const chunk = js();
    fetch.mockResolvedValueOnce(chunk);
    const request = { url: 'https://app.example' + path, method: 'GET', mode: 'cors' };
    const kept: Promise<unknown>[] = [];
    const first = vi.fn();
    handlers.fetch({ request, respondWith: first, waitUntil: (value: Promise<unknown>) => kept.push(value) });
    expect(await first.mock.calls[0][0]).toBe(chunk);
    await Promise.all(kept);
    expect(put).toHaveBeenCalledWith(path, expect.any(Response));
    // Offline now: the stored copy answers and the network is not asked again.
    const second = vi.fn();
    handlers.fetch({ request, respondWith: second, waitUntil: () => {} });
    expect(await second.mock.calls[0][0]).toBeInstanceOf(Response);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([['a lazy screen', WARM[0]], ['an admin-only chunk', ON_DEMAND[0]]])('never stores the app shell or an error as %s', async (_name, path) => {
    const { handlers, fetch, put } = worker();
    const request = { url: 'https://app.example' + path, method: 'GET', mode: 'cors' };
    for (const response of [html(), new Response('missing', { status: 404 })]) {
      fetch.mockResolvedValueOnce(response);
      const respondWith = vi.fn();
      handlers.fetch({ request, respondWith, waitUntil: () => {} });
      expect(await respondWith.mock.calls[0][0]).toBe(response);
    }
    expect(put).not.toHaveBeenCalled();
  });

  it('uses only the static shell for offline conversation navigation', async () => {
    const { navigate, match } = worker();
    expect(await (await navigate('https://app.example/?bot=shared')).text()).toBe('static shell');
    expect(match).toHaveBeenCalledWith('/index.html');
  });

  it('carries the saved bot through push and notification click', async () => {
    const { handlers, showNotification, openWindow } = worker();
    let done: Promise<void> | undefined;
    const waitUntil = (value: Promise<void>) => { done = value; };
    handlers.push({
      data: { json: () => ({ title: 'Ready', url: '/?bot=family%20helper', tag: 'run-1' }) }, waitUntil,
    });
    await done;
    const notification = showNotification.mock.calls[0]?.[1];
    expect(notification.data.url).toBe('https://app.example/?bot=family%20helper');
    expect(notification.tag).toBe('run-1');
    handlers.notificationclick({ notification: { ...notification, close: vi.fn() }, waitUntil });
    await done;
    expect(openWindow).toHaveBeenCalledWith('https://app.example/?bot=family%20helper');
  });
  it('keeps routine results in a same-origin notification return path',async () => {
    const {handlers,showNotification,openWindow}=worker();let done:Promise<void>|undefined;
    const waitUntil=(value:Promise<void>)=>{done=value;};
    handlers.push({data:{json:()=>({url:'/?bot=ranch&routine=morning%20check&ignored=private'})},waitUntil});await done;
    const notification=showNotification.mock.calls[0][1];
    expect(notification.data.url).toBe('https://app.example/?bot=ranch&routine=morning%20check');
    handlers.notificationclick({notification:{...notification,close:vi.fn()},waitUntil});await done;
    expect(openWindow).toHaveBeenCalledWith(notification.data.url);
  });
});
it('opens Today for a digest without carrying unrelated URL parameters',async()=>{
  const {handlers,showNotification,openWindow}=worker();let done:Promise<void>|undefined;const waitUntil=(value:Promise<void>)=>{done=value;};
  handlers.push({data:{json:()=>({url:'/?view=today&ignored=private'})},waitUntil});await done;
  const notification=showNotification.mock.calls[0][1];expect(notification.data.url).toBe('https://app.example/?view=today');
  handlers.notificationclick({notification:{...notification,close:vi.fn()},waitUntil});await done;expect(openWindow).toHaveBeenCalledWith('https://app.example/?view=today');
});

describe('service worker badge and approval actions', () => {
  const approval = { title: 'Ranch', body: 'Allow command?', url: '/?bot=ranch', tag: 'approval-1', kind: 'approval', declineToken: 't'.repeat(43), badge: 2 };
  async function push(sw: ReturnType<typeof worker>, data: object) {
    let done: Promise<unknown> | undefined;
    sw.handlers.push({ data: { json: () => data }, waitUntil: (value: Promise<unknown>) => { done = value; } });
    await done;
    return sw.showNotification.mock.calls.at(-1)![1];
  }
  async function click(sw: ReturnType<typeof worker>, notification: object, action = '') {
    let done: Promise<unknown> | undefined;
    sw.handlers.notificationclick({ action, notification: { ...notification, tag: 'approval-1', close: vi.fn() }, waitUntil: (value: Promise<unknown>) => { done = value; } });
    await done;
  }

  it('sets the app badge from each push and clears it at zero, leaving it alone without a count', async () => {
    const sw = worker();
    await push(sw, { title: 'Done', badge: 3 });
    expect(sw.setAppBadge).toHaveBeenCalledWith(3);
    await push(sw, { title: 'Done', badge: 0 });
    expect(sw.clearAppBadge).toHaveBeenCalledOnce();
    await push(sw, { title: 'Done' });
    await push(sw, { title: 'Done', badge: -1 });
    expect(sw.setAppBadge).toHaveBeenCalledOnce();
  });

  it('offers Review and Decline only for an approval with a token where actions are supported', async () => {
    expect((await push(worker({ maxActions: 2 }), approval)).actions).toEqual([{ action: 'review', title: 'Review' }, { action: 'decline', title: 'Decline' }]);
    expect((await push(worker({ maxActions: 0 }), approval)).actions).toBeUndefined();
    expect((await push(worker({ maxActions: 2 }), { ...approval, declineToken: undefined })).actions).toBeUndefined();
    expect((await push(worker({ maxActions: 2 }), { ...approval, kind: 'completed' })).actions).toBeUndefined();
  });

  it('declines without opening the app, and offers the chat when that fails', async () => {
    const sw = worker({ maxActions: 2 });
    const notification = await push(sw, approval);
    sw.fetch.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    await click(sw, notification, 'decline');
    expect(sw.fetch).toHaveBeenCalledWith('/api/push/actions', expect.objectContaining({ method: 'POST', credentials: 'omit', body: JSON.stringify({ token: approval.declineToken }) }));
    expect(sw.openWindow).not.toHaveBeenCalled();
    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    sw.fetch.mockResolvedValueOnce(new Response('{}', { status: 409 }));
    await click(sw, notification, 'decline');
    const followUp = sw.showNotification.mock.calls.at(-1)!;
    expect(followUp[0]).toBe("Couldn't decline");
    expect(followUp[1]).toMatchObject({ tag: 'approval-1:decline', data: { url: 'https://app.example/?bot=ranch' } });
    // Offline counts as failed too.
    await click(sw, notification, 'decline');
    expect(sw.showNotification).toHaveBeenCalledTimes(3);
    await click(sw, followUp[1]);
    expect(sw.openWindow).toHaveBeenCalledWith('https://app.example/?bot=ranch');
  });

  it('opens the chat for Review, as a tap does', async () => {
    const sw = worker({ maxActions: 2 });
    await click(sw, await push(sw, approval), 'review');
    expect(sw.openWindow).toHaveBeenCalledWith('https://app.example/?bot=ranch');
    expect(sw.fetch).not.toHaveBeenCalled();
  });
});

describe('service worker release updates', () => {
  const older = (entries: Record<string, Response>) => ({ older: { 'agent-interface-previous': entries } });
  const current = (sw: ReturnType<typeof worker>) => sw.stores.get('agent-interface-test')!;
  const fetched = (sw: ReturnType<typeof worker>) => sw.fetch.mock.calls.map(([path]) => path).sort();

  it('copies a hashed file the last release already holds instead of fetching it', async () => {
    const sw = worker(older({ '/assets/app-a1234567.js': js('old body'), '/assets/panel-b1234567.js': js() }));
    await sw.install();
    expect(fetched(sw)).toEqual(['/assets/vendor.js', '/icon-192.png', '/index.html']);
    expect(await (current(sw).get('/assets/app-a1234567.js') as Response).text()).toBe('old body');
    // Lazy files carry over too, since copying costs nothing, but nothing absent is invented.
    expect(current(sw).has('/assets/panel-b1234567.js')).toBe(true);
    expect(current(sw).has('/assets/panel-c1234567.css')).toBe(false);
  });

  it('fetches the pages, icons and unhashed files fresh even when the last release holds them', async () => {
    const sw = worker(older({ '/index.html': html(), '/icon-192.png': js(), '/assets/vendor.js': js(), '/assets/app-a1234567.js': js() }));
    await sw.install();
    expect(fetched(sw)).toEqual(['/assets/vendor.js', '/icon-192.png', '/index.html']);
  });

  it('refetches a hashed file whose old copy is the app shell or an error rather than code', async () => {
    const sw = worker(older({ '/assets/app-a1234567.js': html(), '/assets/panel-b1234567.js': new Response('gone', { status: 404 }) }));
    await sw.install();
    expect(fetched(sw)).toEqual([...INSTALL].sort());
    expect(current(sw).has('/assets/panel-b1234567.js')).toBe(false);
  });

  it('takes a file from whichever older cache has it, and fetches the rest', async () => {
    const sw = worker({ older: {
      'agent-interface-one': { '/assets/app-a1234567.js': js('one') },
      'agent-interface-two': { '/assets/panel-b1234567.js': js('two'), '/assets/app-a1234567.js': js('two') },
      'unrelated-cache': { '/assets/panel-c1234567.css': js('private') },
    } });
    await sw.install();
    expect(current(sw).has('/assets/app-a1234567.js')).toBe(true);
    expect(current(sw).has('/assets/panel-b1234567.js')).toBe(true);
    expect(current(sw).has('/assets/panel-c1234567.css')).toBe(false);
  });

  it('falls back to fetching when an older cache cannot be read', async () => {
    const fetch = vi.fn(healthy);
    const open = async (name: string) => name === 'agent-interface-previous'
      ? { match: async () => { throw new Error('storage'); } }
      : { match: async () => undefined, put: async () => {} };
    const handlers: Record<string, (event: any) => void> = {};
    vm.runInNewContext(script(), {
      self: { location: { origin: 'https://app.example' }, addEventListener: (type: string, handler: (event: any) => void) => { handlers[type] = handler; } },
      caches: { open, has: async () => true, keys: async () => ['agent-interface-previous', 'agent-interface-test'] }, URL, Response, fetch,
    });
    let installed: Promise<unknown> | undefined;
    handlers.install({ waitUntil: (value: Promise<unknown>) => { installed = value; } });
    await installed;
    expect(fetch.mock.calls.map(([path]) => path).sort()).toEqual([...INSTALL].sort());
  });

  it('does not warm on activation, so activation never waits on downloads or leaves them unprotected', async () => {
    const sw = worker();
    await sw.activate();
    expect(sw.claim).toHaveBeenCalledOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sw.fetch).not.toHaveBeenCalled();
  });

  it('warms lazy files when the page asks, under waitUntil, and never touches admin-only chunks', async () => {
    const sw = worker();
    const release: Array<() => void> = [];
    sw.fetch.mockImplementation((path: string) => new Promise<Response>((resolve) => { release.push(() => resolve(js(path))); }));
    const waited = sw.warm();
    // The browser is told to keep the worker alive for the whole download.
    expect(typeof waited?.then).toBe('function');
    await vi.waitFor(() => expect(sw.fetch).toHaveBeenCalledTimes(WARM.length));
    expect(sw.fetch.mock.calls.map(([path]) => path).sort()).toEqual([...WARM].sort());
    let settled = false;
    void waited!.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    release.forEach((resolve) => resolve());
    await waited;
    expect(WARM.every((path) => current(sw).has(path))).toBe(true);
    expect(current(sw).has(ON_DEMAND[0])).toBe(false);
  });

  it('ignores messages that are not requests to warm or skip waiting', () => {
    const sw = worker();
    const waitUntil = vi.fn();
    sw.handlers.message({ data: { type: 'OTHER' }, waitUntil });
    sw.handlers.message({ data: undefined, waitUntil });
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('resumes after a cut-short run: a second warm fetches only what is still missing', async () => {
    const sw = worker();
    // The first run is stopped by the browser after one file; the rest never arrived.
    sw.fetch.mockResolvedValueOnce(js(WARM[0])).mockRejectedValue(new Error('terminated'));
    await sw.warm();
    expect(current(sw).has(WARM[0])).toBe(true);
    expect(current(sw).has(WARM[1])).toBe(false);
    sw.fetch.mockReset().mockImplementation(healthy);
    await sw.warm();
    expect(sw.fetch).toHaveBeenCalledExactlyOnceWith(WARM[1], expect.anything());
    expect(WARM.every((path) => current(sw).has(path))).toBe(true);
  });

  it('shares one run between pages that ask at the same time', async () => {
    const sw = worker();
    sw.fetch.mockImplementation(healthy);
    await Promise.all([sw.warm(), sw.warm()]);
    expect(sw.fetch).toHaveBeenCalledTimes(WARM.length);
  });

  it('warms only a few files at once and skips those already cached', async () => {
    const warm = Array.from({ length: 8 }, (_unused, index) => `/assets/chunk${index}-abcdefg${index}.js`);
    const handlers: Record<string, (event: any) => void> = {};
    const stored = new Map<string, unknown>([[warm[0], js()]]);
    let active = 0, peak = 0;
    const fetch = vi.fn(async () => { active++; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 5)); active--; return js(); });
    vm.runInNewContext(script(INSTALL, warm), {
      self: { location: { origin: 'https://app.example' }, addEventListener: (type: string, handler: (event: any) => void) => { handlers[type] = handler; }, clients: { claim: async () => {} } },
      caches: {
        keys: async () => [],
        open: async () => ({ match: async (key: string) => stored.get(key), put: async (key: string, value: unknown) => { stored.set(key, value); } }),
      },
      URL, Response, fetch,
    });
    let waited: Promise<unknown> | undefined;
    handlers.message({ data: { type: 'WARM' }, waitUntil: (value: Promise<unknown>) => { waited = value; } });
    await waited;
    expect(warm.every((path) => stored.has(path))).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(warm.length - 1);
    expect(peak).toBe(3);
  });

  it('never keeps a warmed file that came back as the app shell, an error or nothing', async () => {
    const sw = worker();
    sw.fetch.mockResolvedValueOnce(html()).mockResolvedValueOnce(new Response('gone', { status: 404 }));
    await sw.warm();
    expect(sw.fetch).toHaveBeenCalledTimes(WARM.length);
    expect(sw.put).not.toHaveBeenCalled();
    expect(WARM.some((path) => current(sw).has(path))).toBe(false);
  });

  it('removes older releases when it activates', async () => {
    const sw = worker(older({ '/assets/app-a1234567.js': js() }));
    sw.fetch.mockRejectedValue(new Error('offline'));
    await sw.activate();
    expect([...sw.stores.keys()]).toEqual(['agent-interface-test']);
  });

  it('judges hashed names the way the server does when it marks them immutable', () => {
    const root = '/srv/dist/client';
    const source = script();
    const hashed = vm.runInNewContext(`${source}\n;(path) => HASHED_ASSET.test(path)`, {
      self: { addEventListener: () => {}, location: { origin: 'https://app.example' } }, caches: {}, URL, Response, fetch: vi.fn(),
    }) as (path: string) => boolean;
    for (const name of [
      'assets/index-D7HmB6AI.js', 'assets/Avatar-BilO5MgL.css', 'assets/use-action-CcK_b2am.js', 'assets/a-b-_-_-_-_.png',
      'assets/index-D7HmB6A.js', 'assets/index-D7HmB6AIx.js', 'assets/sub/index-D7HmB6AI.js', 'assets/vendor.js',
      'index.html', 'icon-192.png', 'manifest.webmanifest', 'native-computer.html', 'index-D7HmB6AI.js',
    ]) expect(hashed('/' + name), name).toBe(isHashedAsset(root, `${root}/${name}`));
  });
});

describe('service worker app shell', () => {
  const shell = (body = '<!doctype html><script src="/assets/app-a1234567.js">') => new Response(body, { headers: { 'content-type': 'text/html' } });
  const NEXT = '<!doctype html><script src="/assets/app-z7654321.js">';
  // Where the worker notes that its cached shell is out of date. The tests only ask whether it is there.
  const MARKER = '/.shell-outdated';
  // This release's cache holds a real shell, as after an install.
  const installed = (options: Parameters<typeof worker>[0] = {}) => {
    const sw = worker(options);
    sw.stores.get('agent-interface-test')!.set('/index.html', shell());
    return sw;
  };
  const outdated = (sw: ReturnType<typeof worker>, name = 'agent-interface-test') => sw.stores.get(name)?.has(MARKER) ?? false;
  const window = (url = 'https://app.example/?bot=ranch') => openWindowOf({ url });
  // The worker's own background check asks for /index.html by path; a navigation passes its request.
  const navigations = (sw: ReturnType<typeof worker>) => sw.fetch.mock.calls.filter(([request]) => typeof request !== 'string');

  it('opens from this release\'s cache without waiting on the network', async () => {
    const sw = installed();
    let check!: () => void;
    // The network answers only after the shell has opened.
    sw.fetch.mockImplementation(() => new Promise(resolve => { check = () => resolve(shell()); }));
    let answer: unknown;
    sw.handlers.fetch({ request: { url: 'https://app.example/', method: 'GET', mode: 'navigate' }, respondWith: async (value: Promise<unknown>) => { answer = await value; }, waitUntil: () => {} });
    await vi.waitFor(() => expect(answer).toBeInstanceOf(Response));
    expect(await (answer as Response).text()).toContain('/assets/app-a1234567.js');
    expect(navigations(sw)).toEqual([]);
    check();
  });

  it('opens a first visit, with no cache at all, from the network', async () => {
    const sw = worker({ stores: new Map() });
    sw.fetch.mockImplementation(async () => shell('from the network'));
    expect(await (await sw.navigate()).text()).toBe('from the network');
    // The navigation itself, and nothing in the background.
    expect(sw.fetch).toHaveBeenCalledOnce();
  });

  it('opens from the network when this release holds no shell, never from an older release', async () => {
    const sw = worker({ older: { 'agent-interface-previous': { '/index.html': shell('older release') } } });
    sw.stores.get('agent-interface-test')!.delete('/index.html');
    sw.fetch.mockImplementation(async () => shell('from the network'));
    expect(await (await sw.navigate()).text()).toBe('from the network');
    expect(sw.fetch).toHaveBeenCalledOnce();
  });

  it('checks the server\'s shell after opening and changes nothing when it is the same', async () => {
    const sw = installed();
    sw.fetch.mockImplementation(async () => shell());
    await sw.navigate();
    await sw.navigate();
    expect(sw.fetch.mock.calls).toEqual([['/index.html', { cache: 'no-store', redirect: 'manual' }], ['/index.html', { cache: 'no-store', redirect: 'manual' }]]);
    expect(outdated(sw)).toBe(false);
    expect(sw.update).not.toHaveBeenCalled();
  });

  it('notes a changed shell, checks for the release at once, and opens from the network from then on', async () => {
    const sw = installed();
    sw.fetch.mockImplementation(async () => shell(NEXT));
    // The load that finds the change still opens the copy it has.
    expect(await (await sw.navigate()).text()).toContain('/assets/app-a1234567.js');
    expect(outdated(sw)).toBe(true);
    expect(sw.update).toHaveBeenCalledOnce();
    sw.fetch.mockClear();
    sw.fetch.mockImplementation(async () => shell(NEXT));
    expect(await (await sw.navigate()).text()).toBe(NEXT);
    // The navigation, with no second check behind it.
    expect(navigations(sw)).toHaveLength(1);
    expect(sw.fetch).toHaveBeenCalledOnce();
  });

  it('keeps the note when the browser stops the worker and starts it again', async () => {
    const first = installed();
    first.fetch.mockImplementation(async () => shell(NEXT));
    await first.navigate();
    const restarted = worker({ stores: first.stores });
    restarted.fetch.mockImplementation(async () => shell(NEXT));
    expect(await (await restarted.navigate()).text()).toBe(NEXT);
    expect(navigations(restarted)).toHaveLength(1);
  });

  it('opens the cached shell offline once the note is set', async () => {
    const sw = installed();
    sw.fetch.mockImplementation(async () => shell(NEXT));
    await sw.navigate();
    sw.fetch.mockRejectedValue(new Error('offline'));
    expect(await (await sw.navigate()).text()).toContain('/assets/app-a1234567.js');
  });

  // One bad answer must never cost a person their work: no window reloads, and the worker stays.
  it.each([
    ['a redirect', () => Promise.resolve({ type: 'opaqueredirect', status: 0, ok: false })],
    ['a sign-in', () => Promise.resolve(new Response('Sign in', { status: 401 }))],
    ['a refusal', () => Promise.resolve(new Response('No', { status: 403 }))],
    ['a server error', () => Promise.resolve(new Response('down', { status: 500 }))],
    ['no network', () => Promise.reject(new Error('offline'))],
    ['a body that breaks off', () => Promise.resolve({ type: 'basic', status: 200, ok: true, text: () => Promise.reject(new TypeError('network error')) })],
  ])('changes nothing when the check gets %s', async (_name, answer) => {
    const open = [window(), window('https://app.example/?view=today')];
    const sw = installed({ windows: open });
    sw.fetch.mockImplementation(answer);
    expect(await (await sw.navigate()).text()).toContain('/assets/app-a1234567.js');
    expect(outdated(sw)).toBe(false);
    expect(sw.update).not.toHaveBeenCalled();
    expect(sw.unregister).not.toHaveBeenCalled();
    for (const client of open) expect(client.navigate).not.toHaveBeenCalled();
  });

  describe('boot.js, which belongs to the shell that loads it', () => {
    const BOOT = 'https://app.example/boot.js';
    const withBoot = () => {
      const sw = installed();
      sw.stores.get('agent-interface-test')!.set('/boot.js', js('this release'));
      return sw;
    };
    // The page's request for the script, as the shell's <script src> makes it.
    const boot = async (sw: ReturnType<typeof worker>) => {
      let answer: Promise<unknown> | undefined;
      sw.handlers.fetch({ request: { url: BOOT, method: 'GET', mode: 'no-cors' }, respondWith: (value: Promise<unknown>) => { answer = value; } });
      expect(answer, 'the worker answers boot.js').toBeDefined();
      return (await answer as Response).text();
    };
    const fromNetwork = (sw: ReturnType<typeof worker>) => sw.fetch.mockImplementation(async (request: unknown) =>
      typeof request === 'string' ? shell(NEXT) : js('next release'));

    it('comes from this release\'s cache while the cached shell opens', async () => {
      const sw = withBoot();
      fromNetwork(sw);
      expect(await boot(sw)).toBe('this release');
    });

    it('comes from this release\'s cache without asking the network, even once the shell is noted as out of date', async () => {
      const sw = withBoot();
      fromNetwork(sw);
      await sw.navigate();
      expect(outdated(sw)).toBe(true);
      // A download that never finishes would block the page's <head>; the network is not asked.
      sw.fetch.mockImplementation(() => new Promise(() => {}));
      expect(await boot(sw)).toBe('this release');
    });

    it('comes from the network only when this release holds no copy', async () => {
      const sw = installed();
      fromNetwork(sw);
      expect(await boot(sw)).toBe('next release');
    });
  });

  it('starts a new release with no note, whatever the last release noted', async () => {
    const old = installed();
    old.fetch.mockImplementation(async () => shell(NEXT));
    await old.navigate();
    // The next release's worker installs beside it in the same storage, then takes over.
    old.stores.set('agent-interface-previous', old.stores.get('agent-interface-test')!);
    old.stores.delete('agent-interface-test');
    const next = worker({ stores: old.stores });
    await next.install();
    await next.activate();
    expect(outdated(next)).toBe(false);
    next.fetch.mockClear();
    next.fetch.mockImplementation(async () => html());
    await next.navigate();
    expect(navigations(next)).toEqual([]);
  });
});

describe('service worker notification taps with the app open', () => {
  const url = 'https://app.example/?bot=ranch';
  const tapped = { title: 'Ranch Hand', body: 'The north gate is latched.', icon: '/icon-192.png', badge: '/icon-192.png', tag: 'bot:ranch', actions: [] as { action: string; title: string }[], data: { url: '/?bot=ranch' } as Record<string, unknown> };
  const cameBack = { ...tapped, data: { url: '/?bot=ranch', reshown: true } };
  async function tap(sw: ReturnType<typeof worker>, notification: Partial<typeof tapped> & { data: Record<string, unknown> } = tapped) {
    let done: Promise<unknown> | undefined;
    sw.handlers.notificationclick({ notification: { ...tapped, close: vi.fn(), ...notification }, waitUntil: (value: Promise<unknown>) => { done = value; } });
    return done!;
  }
  /** The notification the worker brought back, as a tap on it delivers it. */
  const broughtBack = (sw: ReturnType<typeof worker>) => {
    const [title, options] = sw.showNotification.mock.calls[0];
    return { title, ...options, data: options.data ?? {} };
  };
  const fulfilled = async (mock: ReturnType<typeof vi.fn>) =>
    (await Promise.allSettled(mock.mock.results.map(result => result.value))).some(result => result.status === 'fulfilled');
  /**
   * The invariant every tap ends in: a window known to be in front shows the chat, or exactly one
   * notification, marked as having come back, is on screen. A new window is in front; an open one
   * shows the chat once it answered in time or was navigated, and is in front when it was focused
   * already or its focus() worked.
   */
  async function ending(sw: ReturnType<typeof worker>, window?: Window, answeredInTime = false) {
    const shows = answeredInTime || !!window && await fulfilled(window.navigate);
    const inFront = await fulfilled(sw.openWindow) || !!window && shows && (!!window.focused || await fulfilled(window.focus));
    const back = sw.shown.filter(each => each.data?.reshown === true && each.data.url === '/?bot=ranch');
    expect(inFront ? 0 : 1, 'a window in front, or the notification back').toBe(sw.shown.length);
    expect(back).toHaveLength(sw.shown.length);
    return inFront ? 'in front' : 'back';
  }

  it('asks the window to open the chat in place and focuses it, without reloading it', async () => {
    const window = openWindowOf();
    const sw = worker({ windows: [window] });
    await tap(sw);
    expect(window.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'OPEN_CHAT', url }, [expect.anything()]);
    expect(window.focus).toHaveBeenCalled();
    expect(window.navigate).not.toHaveBeenCalled();
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it('asks the window the person was last in when several are open', async () => {
    const [other, current] = [openWindowOf(), openWindowOf({ focused: true })];
    await tap(worker({ windows: [other, current] }));
    expect(current.postMessage).toHaveBeenCalled();
    expect(other.postMessage).not.toHaveBeenCalled();
  });

  it('opens a new window beside one this worker does not control, which it can neither ask nor navigate', async () => {
    const window = openWindowOf({ controlled: false });
    const sw = worker({ windows: [window] });
    await tap(sw);
    expect(sw.openWindow).toHaveBeenCalledExactlyOnceWith(url);
    expect(window.postMessage).not.toHaveBeenCalled();
    expect(window.navigate).not.toHaveBeenCalled();
  });

  // The page is busy, as with an edited settings form, and has not answered when the wait ends.
  // Loading the chat into it would replace that form, so a first tap never does, and the tap ends there.
  it('waits 250 ms for an answer, then leaves the window as it is and brings the notification back', async () => {
    vi.useFakeTimers();
    try {
      const window = openWindowOf({ answers: false });
      const sw = worker({ windows: [window] });
      let finished = false;
      void tap(sw).then(() => { finished = true; });
      await vi.advanceTimersByTimeAsync(249);
      expect(sw.showNotification).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(finished).toBe(true);
      expect(sw.showNotification).toHaveBeenCalledExactlyOnceWith('Ranch Hand', expect.objectContaining({ silent: true, data: { url: '/?bot=ranch', reshown: true } }));
      expect(window.navigate).not.toHaveBeenCalled();
      expect(sw.openWindow).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  // A window still running a release from before pages answered never answers. The tap on the
  // notification that came back is the person asking again, so it loads the chat there. Taps one
  // after the other each make their own attempt.
  it('loads the chat into a window that still does not answer when the brought-back notification is tapped', async () => {
    vi.useFakeTimers();
    try {
      const window = openWindowOf({ answers: false });
      const sw = worker({ windows: [window] });
      void tap(sw);
      await vi.advanceTimersByTimeAsync(250);
      const second = tap(sw, broughtBack(sw));
      await vi.advanceTimersByTimeAsync(249);
      expect(window.navigate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await second;
      expect(window.postMessage).toHaveBeenCalledTimes(2);
      expect(window.navigate).toHaveBeenCalledExactlyOnceWith(url);
      expect(sw.openWindow).not.toHaveBeenCalled();
      expect(sw.showNotification).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('opens a new window a quarter second after a tap on one that came back when loading the chat into the silent window fails', async () => {
    vi.useFakeTimers();
    try {
      const window = openWindowOf({ answers: false });
      window.navigate.mockRejectedValue(new TypeError('not controlled'));
      const sw = worker({ windows: [window] });
      const done = tap(sw, cameBack);
      await vi.advanceTimersByTimeAsync(250);
      // Well inside Firefox's second.
      expect(sw.openWindow).toHaveBeenCalledExactlyOnceWith(url);
      await done;
    } finally { vi.useRealTimers(); }
  });

  // One case per rule of the table above openChat and per way it can end. "Refused" makes that call
  // reject; a late answer lands after the 250 ms wait. Windows are visible unless hidden: visible
  // or not, a window that cannot come forward is not in front, and no second window opens for it.
  type Row = {
    rule: 1 | 2 | 3 | 4; name: string; window?: 'none' | 'focused already'; hidden?: boolean;
    answers?: 'in time' | 'late' | 'never'; reshown?: boolean;
    focus?: 'works' | 'refused'; navigate?: 'works' | 'refused'; openWindow?: 'works' | 'refused';
    ends: 'in front' | 'back'; calls: { asked: number; navigated: number; opened: number };
  };
  const rows: Row[] = [
    { rule: 1, name: 'a new window opens', window: 'none', ends: 'in front', calls: { asked: 0, navigated: 0, opened: 1 } },
    { rule: 1, name: 'a new window is refused', window: 'none', openWindow: 'refused', ends: 'back', calls: { asked: 0, navigated: 0, opened: 1 } },
    { rule: 1, name: 'a new window is refused on a tap of one that came back', window: 'none', reshown: true, openWindow: 'refused', ends: 'back', calls: { asked: 0, navigated: 0, opened: 1 } },
    { rule: 2, name: 'the window was focused already', window: 'focused already', answers: 'in time', focus: 'refused', ends: 'in front', calls: { asked: 1, navigated: 0, opened: 0 } },
    { rule: 2, name: 'the window comes forward', answers: 'in time', ends: 'in front', calls: { asked: 1, navigated: 0, opened: 0 } },
    { rule: 2, name: 'the window cannot come forward', answers: 'in time', focus: 'refused', hidden: true, ends: 'back', calls: { asked: 1, navigated: 0, opened: 0 } },
    { rule: 2, name: 'the window cannot come forward, on a tap of one that came back', answers: 'in time', reshown: true, focus: 'refused', ends: 'back', calls: { asked: 1, navigated: 0, opened: 0 } },
    { rule: 3, name: 'the window comes forward', answers: 'never', ends: 'back', calls: { asked: 1, navigated: 0, opened: 0 } },
    { rule: 3, name: 'the page answers late', answers: 'late', ends: 'back', calls: { asked: 1, navigated: 0, opened: 0 } },
    { rule: 4, name: 'the chat loads into the window, which comes forward', answers: 'never', reshown: true, ends: 'in front', calls: { asked: 1, navigated: 1, opened: 0 } },
    { rule: 4, name: 'the chat loads into the window, which cannot come forward', answers: 'never', reshown: true, focus: 'refused', ends: 'back', calls: { asked: 1, navigated: 1, opened: 0 } },
    { rule: 4, name: 'loading fails and a new window opens', answers: 'never', reshown: true, focus: 'refused', navigate: 'refused', ends: 'in front', calls: { asked: 1, navigated: 1, opened: 1 } },
    { rule: 4, name: 'loading fails and a new window is refused', answers: 'never', reshown: true, navigate: 'refused', openWindow: 'refused', ends: 'back', calls: { asked: 1, navigated: 1, opened: 1 } },
  ];
  const setUp = (row: Row) => {
    const window = row.window === 'none' ? undefined
      : Object.assign(openWindowOf({ answers: row.answers === 'in time', focused: row.window === 'focused already' }), { visibilityState: row.hidden ? 'hidden' : 'visible' });
    if (row.focus === 'refused') window?.focus.mockRejectedValue(new TypeError('Not allowed to focus a window.'));
    if (row.navigate === 'refused') window?.navigate.mockRejectedValue(new TypeError('Not this worker\'s window.'));
    const sw = worker({ windows: window ? [window] : [] });
    if (row.openWindow === 'refused') sw.openWindow.mockRejectedValue(new TypeError('Not allowed to open a window.'));
    return { window, sw };
  };
  const counts = (sw: ReturnType<typeof worker>, window?: Window) =>
    ({ asked: window?.postMessage.mock.calls.length ?? 0, navigated: window?.navigate.mock.calls.length ?? 0, opened: sw.openWindow.mock.calls.length });

  it.each(rows)('rule $rule: $name', async row => {
    vi.useFakeTimers();
    try {
      const { window, sw } = setUp(row);
      const done = tap(sw, row.reshown ? cameBack : tapped);
      await vi.advanceTimersByTimeAsync(250);
      await done;
      if (row.answers === 'late') {
        window!.ports[0].postMessage({ opened: true });
        await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(await ending(sw, window, row.answers === 'in time')).toBe(row.ends);
      expect(counts(sw, window)).toEqual(row.calls);
    } finally { vi.useRealTimers(); }
  });

  // A person taps twice before the first tap has finished, or taps two notifications about the same
  // chat. The second joins the first: one ask, one load, one new window, and one notification back.
  // The notifications are untagged, so two shown would both stay on screen.
  it.each([
    rows.find(row => row.rule === 1 && row.ends === 'in front')!,
    rows.find(row => row.rule === 2 && row.ends === 'back' && !row.reshown)!,
    rows.find(row => row.rule === 3 && row.answers === 'never')!,
    rows.find(row => row.rule === 4 && row.calls.opened === 1 && row.ends === 'in front')!,
    rows.find(row => row.rule === 4 && row.calls.opened === 0 && row.ends === 'back')!,
  ])('two overlapping taps act once, rule $rule: $name', async row => {
    vi.useFakeTimers();
    try {
      const { window, sw } = setUp(row);
      const notification = { ...(row.reshown ? cameBack : tapped), tag: undefined };
      // The second tap arrives before the first has heard anything back.
      const first = tap(sw, notification);
      const second = tap(sw, notification);
      await vi.advanceTimersByTimeAsync(250);
      await Promise.all([first, second]);
      expect(await ending(sw, window, row.answers === 'in time')).toBe(row.ends);
      expect(sw.showNotification).toHaveBeenCalledTimes(row.ends === 'back' ? 1 : 0);
      expect(counts(sw, window)).toEqual(row.calls);
    } finally { vi.useRealTimers(); }
  });

  // The page answers, the window cannot come forward, and the notification is being brought back.
  // Browsers may put it on screen before showNotification() settles, and a tap on it then is the
  // person asking again, not part of the attempt that is ending. Nothing waits for that display.
  describe('a tap while the notification is being brought back', () => {
    const row = rows.find(row => row.rule === 2 && row.ends === 'back' && !row.reshown)!;
    /** Holds the next showNotification() unsettled after it has put the notification on screen. */
    const holdNextShow = (sw: ReturnType<typeof worker>) => {
      let settle!: () => void;
      const shown = new Promise<void>(resolve => { settle = resolve; });
      const show = sw.showNotification.getMockImplementation()!;
      sw.showNotification.mockImplementationOnce(async (...args: Parameters<typeof show>) => { await show(...args); await shown; });
      return settle;
    };
    /** The brought-back notification on screen, as the person taps it: the tap closes it. */
    const onScreen = (sw: ReturnType<typeof worker>) => {
      const [title, options] = sw.showNotification.mock.calls.at(-1)!;
      return { title, ...options, data: options.data ?? {}, close: sw.shown.at(-1)!.close };
    };
    const settled = (promise: Promise<unknown>) => {
      const state = { done: false };
      void promise.then(() => { state.done = true; });
      return state;
    };

    // Every display puts its notification on screen and never settles. The first tap's promise must
    // not keep the worker alive past the attempt that replaced it, and that one ends at the deadline
    // when it brings the notification back too.
    it.each([
      { second: 'cannot come forward either', settles: 10_000, ends: 'back' },
      { second: 'comes forward', settles: 0, ends: 'in front' },
    ])('starts a new attempt at once that $second, and no display that never settles keeps the worker alive', async ({ second: outcome, settles, ends }) => {
      vi.useFakeTimers();
      try {
        const { window, sw } = setUp(row);
        const show = sw.showNotification.getMockImplementation()!;
        sw.showNotification.mockImplementation(async (...args: Parameters<typeof show>) => { await show(...args); await new Promise(() => {}); });
        const first = settled(tap(sw));
        await vi.advanceTimersByTimeAsync(0);
        expect(sw.shown).toHaveLength(1);
        if (outcome === 'comes forward') window!.focus.mockResolvedValueOnce(window);
        const second = settled(tap(sw, onScreen(sw)));
        await vi.advanceTimersByTimeAsync(0);
        expect(counts(sw, window), 'asked again at once').toEqual({ asked: 2, navigated: 0, opened: 0 });
        if (settles) {
          await vi.advanceTimersByTimeAsync(settles - 1);
          expect([first.done, second.done], 'kept alive while the notification is being shown').toEqual([false, false]);
          await vi.advanceTimersByTimeAsync(1);
        }
        expect([first.done, second.done], 'nothing left pending').toEqual([true, true]);
        expect(await ending(sw, window, true)).toBe(ends);
      } finally { vi.useRealTimers(); }
    });

    // Two different notifications about one chat: the second is tapped while the first is being
    // brought back, and the first is left on screen. The chat ends with one notification.
    it('leaves one notification for the chat when another about it is tapped meanwhile', async () => {
      const { window, sw } = setUp(row);
      const settle = holdNextShow(sw);
      const first = tap(sw, { ...tapped, tag: undefined });
      await vi.waitFor(() => expect(sw.shown).toHaveLength(1));
      const second = tap(sw, { ...tapped, title: 'Ranch Hand again', tag: undefined });
      settle();
      await Promise.all([first, second]);
      expect(await ending(sw, window, true)).toBe('back');
      expect(sw.shown.map(each => each.title)).toEqual(['Ranch Hand again']);
    });

    // The replaced attempt's display settles while its replacement is still asking the window. A tap
    // then joins the replacement rather than starting a third attempt.
    it('lets later taps join the new attempt, even once the replaced one settles', async () => {
      const { window, sw } = setUp(row);
      const settle = holdNextShow(sw);
      const first = tap(sw);
      await vi.waitFor(() => expect(sw.shown).toHaveLength(1));
      let refuse!: () => void;
      window!.focus.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = () => reject(new TypeError('Not allowed to focus a window.')); }));
      const second = tap(sw, onScreen(sw));
      await vi.waitFor(() => expect(window!.postMessage).toHaveBeenCalledTimes(2));
      settle();
      await first;
      const third = tap(sw, { ...tapped, tag: undefined });
      refuse();
      await Promise.all([second, third]);
      expect(await ending(sw, window, true)).toBe('back');
      expect(counts(sw, window)).toEqual({ asked: 2, navigated: 0, opened: 0 });
      expect(sw.showNotification).toHaveBeenCalledTimes(2);
    });
  });

  // A brought-back notification carries one tag per chat, so it replaces only the one brought back
  // for the same chat. The server tags each push with its own event ID, which no chat's tag matches.
  it('brings back notifications for two chats side by side', async () => {
    const sw = worker();
    sw.openWindow.mockRejectedValue(new TypeError('Not allowed to open a window.'));
    await tap(sw, { tag: 'event-1', data: { url: '/?bot=ranch' } });
    await tap(sw, { tag: 'event-2', data: { url: '/?bot=barn' } });
    expect(sw.shown.map(each => each.data)).toEqual([{ url: '/?bot=ranch', reshown: true }, { url: '/?bot=barn', reshown: true }]);
  });

  // Chromium rejects showNotification() when it cannot store the notification. Overlapping taps
  // share the attempt, so they share its one retry.
  describe('bringing the notification back fails', () => {
    const row = rows.find(row => row.rule === 1 && row.ends === 'back' && !row.reshown)!;
    const failed = () => new TypeError('Failed to store the notification.');

    it.each([1, 2])('tries once more, for %i tap(s)', async taps => {
      const { window, sw } = setUp(row);
      sw.showNotification.mockRejectedValueOnce(failed());
      await Promise.all(Array.from({ length: taps }, () => tap(sw, { ...tapped, tag: undefined })));
      expect(await ending(sw, window)).toBe('back');
      expect(sw.showNotification).toHaveBeenCalledTimes(2);
    });

    // One of the two cases the invariant cannot cover: nothing is on screen, and every tap still ends cleanly.
    it('ends every tap without a rejection when the second try fails too', async () => {
      const { sw } = setUp(row);
      sw.showNotification.mockRejectedValueOnce(failed()).mockRejectedValueOnce(failed());
      const taps = [tap(sw, { ...tapped, tag: undefined }), tap(sw, { ...tapped, tag: undefined })];
      expect(await Promise.allSettled(taps)).toEqual([{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }]);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(sw.showNotification).toHaveBeenCalledTimes(2);
      expect(sw.shown).toEqual([]);
    });

    // The other case the invariant cannot cover: the browser neither shows the notification nor
    // refuses it. The worker stops waiting at the deadline with nothing on screen, tries nothing
    // more, and the notification still appears if the browser finishes later.
    it('stops waiting at the deadline for a display that has neither appeared nor failed', async () => {
      vi.useFakeTimers();
      try {
        const { sw } = setUp(row);
        const show = sw.showNotification.getMockImplementation()!;
        let finish!: () => void;
        const stored = new Promise<void>(resolve => { finish = resolve; });
        sw.showNotification.mockImplementationOnce(async (...args: Parameters<typeof show>) => { await stored; await show(...args); });
        let ended = false;
        void tap(sw, { ...tapped, tag: undefined }).then(() => { ended = true; });
        await vi.advanceTimersByTimeAsync(9_999);
        expect(ended, 'still waiting for the display').toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(ended, 'ended at the deadline').toBe(true);
        expect(sw.shown).toEqual([]);
        expect(sw.showNotification).toHaveBeenCalledOnce();
        finish();
        await vi.advanceTimersByTimeAsync(0);
        expect(sw.shown.map(each => each.data)).toEqual([{ url: '/?bot=ranch', reshown: true }]);
        expect(sw.showNotification).toHaveBeenCalledOnce();
      } finally { vi.useRealTimers(); }
    });
  });

  it('brings the notification back when a step fails in a way the rules do not name', async () => {
    const sw = worker();
    sw.clients.matchAll = async () => { throw new Error('The worker is shutting down.'); };
    await tap(sw);
    expect(sw.shown.map(each => each.data)).toEqual([{ url: '/?bot=ranch', reshown: true }]);
  });

  it('shows the notification again, quietly, with everything it carried', async () => {
    const sw = worker();
    sw.openWindow.mockRejectedValue(new TypeError('Not allowed to open a window.'));
    await tap(sw);
    expect(sw.showNotification).toHaveBeenCalledExactlyOnceWith('Ranch Hand', {
      body: 'The north gate is latched.', icon: '/icon-192.png', badge: '/icon-192.png', tag: 'reshown:https://app.example/?bot=ranch', actions: [], silent: true,
      data: { url: '/?bot=ranch', reshown: true },
    });
  });

  it('keeps an approval\'s actions on the notification it shows again', async () => {
    const sw = worker();
    sw.openWindow.mockRejectedValue(new TypeError('Not allowed to open a window.'));
    const actions = [{ action: 'review', title: 'Review' }, { action: 'decline', title: 'Decline' }];
    await tap(sw, { tag: 'approval-1', actions, data: { url: '/?bot=ranch', declineToken: 'single-use' } });
    expect(sw.showNotification).toHaveBeenCalledWith('Ranch Hand', expect.objectContaining({ actions, data: { url: '/?bot=ranch', declineToken: 'single-use', reshown: true } }));
  });
});

describe('service worker pushes for the account signed in here', () => {
  // The server's marker for each account, as src/server/apns.ts makes it.
  const marker = (user: string) => createHash('sha256').update(`wildbots-account:${user}`).digest('hex').slice(0, 16);
  const forOne = { title: 'Ranch Hand', body: 'Gate code is 4471', url: '/?bot=ranch', tag: 'event-1', badge: 1, account: marker('one') };
  async function push(sw: ReturnType<typeof worker>, data: object) {
    let done: Promise<unknown> | undefined;
    sw.handlers.push({ data: { json: () => data }, waitUntil: (value: Promise<unknown>) => { done = value; } });
    await done;
  }
  async function click(sw: ReturnType<typeof worker>, notification: object, action = '') {
    let done: Promise<unknown> | undefined;
    sw.handlers.notificationclick({ action, notification: { ...notification, close: vi.fn() }, waitUntil: (value: Promise<unknown>) => { done = value; } });
    await done;
  }

  it('shows a push for the account signed in here, and keeps whose it is with the notification', async () => {
    const sw = worker();
    await sw.signedIn('one');
    await push(sw, forOne);
    expect(sw.shown.map(each => each.title)).toEqual(['Ranch Hand']);
    expect(sw.shown[0]!.data).toMatchObject({ account: marker('one') });
    expect(sw.setAppBadge).toHaveBeenCalledWith(1);
  });

  it('drops a push for another account, and leaves the badge alone, after the worker restarts', async () => {
    const first = worker();
    await first.signedIn('two');
    // The browser stopped the idle worker; the next push starts it again over the same storage.
    const sw = worker({ stores: first.stores });
    await push(sw, forOne);
    expect(sw.showNotification).not.toHaveBeenCalled();
    expect(sw.setAppBadge).not.toHaveBeenCalled();
  });

  it('shows a push that names no account, as from a server before this field, while someone is signed in', async () => {
    const sw = worker();
    await sw.signedIn('two');
    await push(sw, { ...forOne, account: undefined });
    expect(sw.shown.map(each => each.title)).toEqual(['Ranch Hand']);
  });

  it('shows nothing once signed out, whoever the push names', async () => {
    const sw = worker();
    await sw.signedIn('one');
    await sw.signedIn(null);
    await push(sw, forOne);
    await push(sw, { ...forOne, account: undefined });
    expect(sw.showNotification).not.toHaveBeenCalled();
  });

  it("refuses another account's Decline and opens none of its chats, and closes its notifications when the account changes", async () => {
    const sw = worker({ maxActions: 2 });
    await sw.signedIn('one');
    await push(sw, { ...forOne, kind: 'approval', declineToken: 't'.repeat(43) });
    const notification = sw.showNotification.mock.calls[0]![1];
    await sw.signedIn('two');
    expect(sw.shown).toEqual([]);
    await click(sw, notification, 'decline');
    expect(sw.fetch).not.toHaveBeenCalled();
    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    // A tap brings the app up without the other account's chat in its address.
    await click(sw, notification);
    expect(sw.openWindow).toHaveBeenCalledWith('https://app.example/');
  });
});
