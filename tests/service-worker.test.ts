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
      clients: { matchAll: async (query: { includeUncontrolled?: boolean } = {}) => (options.windows ?? []).filter(client => client.controlled || query.includeUncontrolled), openWindow, claim },
      navigator: { setAppBadge, clearAppBadge },
      Notification: { maxActions: options.maxActions ?? 0 },
    },
    caches: { open, has: async (name: string) => stores.has(name), keys: async () => [...stores.keys()], delete: async (name: string) => stores.delete(name) },
    URL, Response, fetch, MessageChannel: FakeMessageChannel,
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
  return { handlers, fetch, match, put, stores, claim, install, tryInstall: () => run('install'), activate: () => run('activate'), warm, navigate, showNotification, shown, openWindow, setAppBadge, clearAppBadge, update, unregister };
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
  async function tap(sw: ReturnType<typeof worker>, notification: Partial<typeof tapped> & { data: Record<string, unknown> } = tapped) {
    let done: Promise<unknown> | undefined;
    sw.handlers.notificationclick({ notification: { ...tapped, ...notification, close: vi.fn() }, waitUntil: (value: Promise<unknown>) => { done = value; } });
    return done!;
  }

  /** The notification the worker brought back, as a tap on it delivers it. */
  const broughtBack = (sw: ReturnType<typeof worker>) => {
    const [title, options] = sw.showNotification.mock.calls[0];
    return { title, ...options, data: options.data ?? {} };
  };

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

  // The page is busy, as with an edited settings form, and has not answered when the wait ends.
  // Loading the chat into it would replace that form, so a first tap never does.
  it('leaves a window that does not answer in time as it is, focused, and brings the notification back', async () => {
    vi.useFakeTimers();
    try {
      const window = openWindowOf({ answers: false });
      const sw = worker({ windows: [window] });
      let finished = false;
      void tap(sw).then(() => { finished = true; });
      await vi.advanceTimersByTimeAsync(249);
      expect(sw.showNotification).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(sw.showNotification).toHaveBeenCalledExactlyOnceWith('Ranch Hand', expect.objectContaining({ silent: true, data: { url: '/?bot=ranch', reshown: true } }));
      expect(window.focus).toHaveBeenCalled();
      expect(window.navigate).not.toHaveBeenCalled();
      expect(sw.openWindow).not.toHaveBeenCalled();
      // It listens a while longer for a late answer, then lets the notification stand.
      await vi.advanceTimersByTimeAsync(9_749);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(finished).toBe(true);
      expect(sw.shown).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  // A window still running a release from before pages answered never answers. The second tap is the
  // person asking again, so it loads the chat there the way taps always did.
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
      // Never a third time.
      expect(sw.showNotification).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('opens a new window on the second tap when loading the chat into the silent one fails', async () => {
    vi.useFakeTimers();
    try {
      const window = openWindowOf({ answers: false });
      window.navigate.mockRejectedValue(new TypeError('not controlled'));
      const sw = worker({ windows: [window] });
      const done = tap(sw, { data: { url: '/?bot=ranch', reshown: true } });
      await vi.advanceTimersByTimeAsync(250);
      // Opened a quarter second after the tap, well inside Firefox's second.
      expect(sw.openWindow).toHaveBeenCalledExactlyOnceWith(url);
      await done;
    } finally { vi.useRealTimers(); }
  });

  // The page was busy past the wait, then opened the chat itself. The notification brought back for
  // a second tap goes, whether the answer lands before it is on screen or after.
  it.each([
    ['after the notification is back on screen', false],
    ['while the notification is still being shown', true],
  ])('closes the brought-back notification when the page answers late, %s, and opens nothing itself', async (_name, beforeShown) => {
    vi.useFakeTimers();
    try {
      const window = openWindowOf({ answers: false });
      const sw = worker({ windows: [window] });
      let showing!: () => void;
      if (beforeShown) sw.showNotification.mockImplementationOnce(function (this: unknown, ...args) {
        const show = sw.showNotification.getMockImplementation()!;
        return new Promise<void>(resolve => { showing = () => resolve(show.apply(this, args)); });
      });
      const done = tap(sw);
      await vi.advanceTimersByTimeAsync(250);
      expect(sw.showNotification).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(350);
      window.ports[0].postMessage({ opened: true });
      await vi.advanceTimersByTimeAsync(0);
      if (beforeShown) showing();
      await done;
      expect(sw.shown).toEqual([]);
      expect(window.navigate).not.toHaveBeenCalled();
      expect(sw.openWindow).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  // Untagged notifications are all listed together, so the late answer picks out the one it brought
  // back: not another chat's brought-back notification, nor a newer one about this chat.
  it('closes only the notification it brought back when the page answers late', async () => {
    vi.useFakeTimers();
    try {
      const window = openWindowOf({ answers: false });
      const sw = worker({ windows: [window] });
      await sw.showNotification('Barn', { data: { url: 'https://app.example/?bot=barn', reshown: true } });
      const done = tap(sw, { tag: undefined, data: { url: url } });
      await vi.advanceTimersByTimeAsync(250);
      await sw.showNotification('Ranch Hand', { body: 'A newer reply.', data: { url } });
      window.ports[0].postMessage({ opened: true });
      await vi.advanceTimersByTimeAsync(0);
      await done;
      expect(sw.shown.map(each => [each.title, each.data])).toEqual([
        ['Barn', { url: 'https://app.example/?bot=barn', reshown: true }],
        ['Ranch Hand', { url }],
      ]);
    } finally { vi.useRealTimers(); }
  });

  // The page answers the first tap late, while the second tap waits for its own answer. It already
  // opened the chat, so loading the chat over it would open it twice.
  it('does not load the chat on a second tap once the page has answered the first one late', async () => {
    vi.useFakeTimers();
    try {
      const window = openWindowOf({ answers: false });
      const sw = worker({ windows: [window] });
      void tap(sw);
      await vi.advanceTimersByTimeAsync(250);
      const second = tap(sw, broughtBack(sw));
      await vi.advanceTimersByTimeAsync(100);
      window.ports[0].postMessage({ opened: true });
      await vi.advanceTimersByTimeAsync(150);
      await second;
      expect(window.navigate).not.toHaveBeenCalled();
      expect(sw.openWindow).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  // One case per row of the table above openChat, each tapped first as a new notification and then,
  // in a fresh worker, as one that came back. "In front" is a window focused already or one whose
  // focus() worked; a visible window can sit behind another application.
  type Row = {
    answer: 'in time' | 'late' | 'never'; focus: 'focused already' | 'in front' | 'failed, visible' | 'failed, hidden';
    refused?: boolean;
    first: { opened: boolean; back: boolean }; again: { opened: boolean; navigated: boolean };
  };
  const rows: Row[] = [
    { answer: 'in time', focus: 'in front', first: { opened: false, back: false }, again: { opened: false, navigated: false } },
    { answer: 'in time', focus: 'focused already', first: { opened: false, back: false }, again: { opened: false, navigated: false } },
    { answer: 'in time', focus: 'failed, visible', first: { opened: false, back: true }, again: { opened: false, navigated: false } },
    { answer: 'in time', focus: 'failed, hidden', first: { opened: true, back: false }, again: { opened: true, navigated: false } },
    { answer: 'in time', focus: 'failed, hidden', refused: true, first: { opened: true, back: true }, again: { opened: true, navigated: false } },
    { answer: 'late', focus: 'in front', first: { opened: false, back: false }, again: { opened: false, navigated: true } },
    { answer: 'late', focus: 'failed, visible', first: { opened: false, back: true }, again: { opened: false, navigated: true } },
    { answer: 'late', focus: 'failed, hidden', first: { opened: true, back: false }, again: { opened: false, navigated: true } },
    { answer: 'late', focus: 'failed, hidden', refused: true, first: { opened: true, back: true }, again: { opened: false, navigated: true } },
    { answer: 'never', focus: 'failed, hidden', first: { opened: false, back: true }, again: { opened: false, navigated: true } },
  ];
  it.each(rows.map(row => ({ ...row, refused: row.refused ?? false })))('answered $answer, focus $focus, a new window refused $refused', async ({ answer, focus, refused, first, again }) => {
    vi.useFakeTimers();
    try {
      for (const [reshown, expected] of [[false, first], [true, again]] as const) {
        const window = Object.assign(openWindowOf({ answers: answer === 'in time', focused: focus === 'focused already' }),
          { visibilityState: focus === 'failed, hidden' ? 'hidden' : 'visible' });
        if (focus !== 'in front') window.focus.mockRejectedValue(new TypeError('Not allowed to focus a window.'));
        const sw = worker({ windows: [window] });
        if (refused) sw.openWindow.mockRejectedValue(new TypeError('Not allowed to open a window.'));
        const done = tap(sw, reshown ? { data: { url: '/?bot=ranch', reshown: true } } : tapped);
        await vi.advanceTimersByTimeAsync(600);
        if (answer === 'late') window.ports[0].postMessage({ opened: true });
        await vi.advanceTimersByTimeAsync(10_000);
        await done;
        const which = reshown ? 'tap on one that came back' : 'first tap';
        expect(sw.openWindow.mock.calls, which).toEqual(expected.opened ? [[url]] : []);
        expect(window.navigate.mock.calls, which).toEqual('navigated' in expected && expected.navigated ? [[url]] : []);
        expect(sw.shown.map(each => each.data), which).toEqual('back' in expected && expected.back ? [{ url: '/?bot=ranch', reshown: true }] : []);
        // A notification comes back at most once.
        if (reshown) expect(sw.showNotification, which).not.toHaveBeenCalled();
      }
    } finally { vi.useRealTimers(); }
  });

  it('shows the notification again, quietly, when no way of opening the chat works', async () => {
    const sw = worker();
    sw.openWindow.mockRejectedValue(new TypeError('Not allowed to open a window.'));
    await tap(sw);
    expect(sw.showNotification).toHaveBeenCalledExactlyOnceWith('Ranch Hand', {
      body: 'The north gate is latched.', icon: '/icon-192.png', badge: '/icon-192.png', tag: 'bot:ranch', actions: [], silent: true,
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

  it('shows a notification again only once, so failing taps never chain', async () => {
    const sw = worker();
    sw.openWindow.mockRejectedValue(new TypeError('Not allowed to open a window.'));
    await expect(tap(sw, { data: { url: '/?bot=ranch', reshown: true } })).resolves.toBeUndefined();
    expect(sw.showNotification).not.toHaveBeenCalled();
  });

  it('opens a new window beside one this worker does not control, which it can neither ask nor navigate', async () => {
    const window = openWindowOf({ controlled: false });
    const sw = worker({ windows: [window] });
    await tap(sw);
    expect(sw.openWindow).toHaveBeenCalledExactlyOnceWith(url);
    expect(window.postMessage).not.toHaveBeenCalled();
    expect(window.navigate).not.toHaveBeenCalled();
  });
});
