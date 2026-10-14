import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function worker() {
  const handlers: Record<string, (event: any) => void> = {};
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const fetch = vi.fn().mockRejectedValue(new Error('offline'));
  const stored = new Map<string, unknown>();
  const match = vi.fn(async (key: string) => key === '/index.html' ? 'static shell' : stored.get(key));
  const put = vi.fn(async (key: string, value: unknown) => { stored.set(key, value); });
  const addAll = vi.fn().mockResolvedValue(undefined);
  const source = readFileSync('scripts/service-worker.js', 'utf8')
    .replace('__BUILD_ID__', 'test')
    .replace('__PRECACHE__', JSON.stringify(['/index.html', '/assets/app-a123.js']))
    .replace('__ON_DEMAND__', JSON.stringify(['/assets/xterm-b456.js']));
  vm.runInNewContext(source, {
    self: {
      location: { origin: 'https://app.example' },
      addEventListener: (type: string, handler: (event: any) => void) => { handlers[type] = handler; },
      registration: { showNotification },
      clients: { matchAll: async () => [], openWindow },
    },
    caches: { open: async () => ({ match, put, addAll }) },
    URL, Response, fetch,
  });
  return { handlers, fetch, match, put, addAll, showNotification, openWindow };
}

describe('service worker privacy and return path', () => {
  it('does not intercept API, generated downloads, POSTs or external resources', () => {
    const { handlers } = worker();
    for (const [url, method] of [
      ['https://app.example/api/bootstrap', 'GET'],
      ['https://app.example/api/files/private-file', 'GET'],
      ['https://app.example/api/events', 'GET'],
      ['https://app.example/assets/app-a123.js', 'POST'],
      ['https://other.example/assets/app-a123.js', 'GET'],
    ]) {
      const respondWith = vi.fn();
      handlers.fetch({ request: { url, method, mode: 'cors' }, respondWith });
      expect(respondWith).not.toHaveBeenCalled();
    }
  });

  it('precaches the app but not the admin-only terminal and desktop code', async () => {
    const { handlers, addAll } = worker();
    let installed: Promise<unknown> | undefined;
    handlers.install({ waitUntil: (value: Promise<unknown>) => { installed = value; } });
    await installed;
    expect(addAll).toHaveBeenCalledWith(['/index.html', '/assets/app-a123.js']);
  });

  it('keeps an on-demand chunk after its first use so it works offline later', async () => {
    const { handlers, fetch, put } = worker();
    const chunk = new Response('export {}', { headers: { 'content-type': 'text/javascript' } });
    fetch.mockResolvedValueOnce(chunk);
    const request = { url: 'https://app.example/assets/xterm-b456.js', method: 'GET', mode: 'cors' };
    const kept: Promise<unknown>[] = [];
    const first = vi.fn();
    handlers.fetch({ request, respondWith: first, waitUntil: (value: Promise<unknown>) => kept.push(value) });
    expect(await first.mock.calls[0][0]).toBe(chunk);
    await Promise.all(kept);
    expect(put).toHaveBeenCalledWith('/assets/xterm-b456.js', expect.any(Response));
    // Offline now: the stored copy answers and the network is not asked again.
    const second = vi.fn();
    handlers.fetch({ request, respondWith: second, waitUntil: () => {} });
    expect(await second.mock.calls[0][0]).toBeInstanceOf(Response);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('never stores the app shell or an error as an on-demand chunk', async () => {
    const { handlers, fetch, put } = worker();
    const request = { url: 'https://app.example/assets/xterm-b456.js', method: 'GET', mode: 'cors' };
    for (const response of [
      new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }),
      new Response('missing', { status: 404 }),
    ]) {
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
