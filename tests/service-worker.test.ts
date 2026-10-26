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

function worker(options: { maxActions?: number; older?: Record<string, Record<string, Response>> } = {}) {
  const handlers: Record<string, (event: any) => void> = {};
  const setAppBadge = vi.fn().mockResolvedValue(undefined), clearAppBadge = vi.fn().mockResolvedValue(undefined);
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const claim = vi.fn().mockResolvedValue(undefined);
  const fetch = vi.fn().mockRejectedValue(new Error('offline'));
  // Installing needs the network; tests of later steps keep the default of being offline.
  // Cache storage by name. The current release's cache starts with its app shell, as after an install.
  const stores = new Map<string, Map<string, unknown>>([['agent-interface-test', new Map([['/index.html', 'static shell']])]]);
  for (const [name, entries] of Object.entries(options.older ?? {})) stores.set(name, new Map(Object.entries(entries)));
  const match = vi.fn();
  const put = vi.fn();
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      match: async (key: string) => { if (name === 'agent-interface-test') match(key); return store.get(key); },
      put: async (key: string, value: unknown) => { put(key, value); store.set(key, value); },
    };
  };
  const context = {
    self: {
      location: { origin: 'https://app.example' },
      addEventListener: (type: string, handler: (event: any) => void) => { handlers[type] = handler; },
      registration: { showNotification },
      clients: { matchAll: async () => [], openWindow, claim },
      navigator: { setAppBadge, clearAppBadge },
      Notification: { maxActions: options.maxActions ?? 0 },
    },
    caches: { open, keys: async () => [...stores.keys()], delete: async (name: string) => stores.delete(name) },
    URL, Response, fetch,
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
  return { handlers, fetch, match, put, stores, claim, install, tryInstall: () => run('install'), activate: () => run('activate'), warm, showNotification, openWindow, setAppBadge, clearAppBadge };
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
    sw.fetch.mockImplementation((path: string) => path === '/assets/app-a1234567.js' ? Promise.resolve(html()) : healthy(path));
    await expect(sw.tryInstall()).rejects.toThrow('/assets/app-a1234567.js');
    // Nothing from the failed attempt is left looking like a finished release.
    expect(sw.stores.has('agent-interface-test')).toBe(false);
  });

  it.each([['an error status', () => new Response('gone', { status: 404 })], ['a failed fetch', () => { throw new Error('offline'); }]])('refuses to install on %s', async (_name, bad) => {
    const sw = worker();
    sw.fetch.mockImplementation((path: string) => path === '/icon-192.png' ? Promise.resolve().then(bad) : healthy(path));
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
      caches: { keys: async () => [], open: async () => ({ match: async () => undefined, put: async (key: string, value: Response) => { stored.set(key, value); } }) },
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
    const { handlers, fetch, match } = worker();
    let response: Promise<unknown> | undefined;
    handlers.fetch({
      request: { url: 'https://app.example/?bot=shared', method: 'GET', mode: 'navigate' },
      respondWith: (value: Promise<unknown>) => { response = value; },
    });
    expect(await response).toBe('static shell');
    expect(fetch).toHaveBeenCalledOnce();
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
    const kept = js('old body');
    const sw = worker(older({ '/assets/app-a1234567.js': kept, '/assets/panel-b1234567.js': js() }));
    await sw.install();
    expect(fetched(sw)).toEqual(['/assets/vendor.js', '/icon-192.png', '/index.html']);
    expect(current(sw).get('/assets/app-a1234567.js')).toBe(kept);
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
      caches: { open, keys: async () => ['agent-interface-previous', 'agent-interface-test'] }, URL, Response, fetch,
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
