import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function worker() {
  const handlers: Record<string, (event: any) => void> = {};
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const fetch = vi.fn().mockRejectedValue(new Error('offline'));
  const match = vi.fn().mockResolvedValue('static shell');
  const source = readFileSync('scripts/service-worker.js', 'utf8')
    .replace('__BUILD_ID__', 'test')
    .replace('__PRECACHE__', JSON.stringify(['/index.html', '/assets/app-a123.js']));
  vm.runInNewContext(source, {
    self: {
      location: { origin: 'https://app.example' },
      addEventListener: (type: string, handler: (event: any) => void) => { handlers[type] = handler; },
      registration: { showNotification },
      clients: { matchAll: async () => [], openWindow },
    },
    caches: { open: async () => ({ match }) },
    URL, Response, fetch,
  });
  return { handlers, fetch, match, showNotification, openWindow };
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
