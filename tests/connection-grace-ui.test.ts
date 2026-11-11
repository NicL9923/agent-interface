// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { api, ApiError, write } from '../src/client-api';
import { CHECKING_CONNECTION, DISCONNECT_GRACE_MS, NOT_SENT_CHECKING, WAITING_FOR_CONNECTION } from '../src/app/use-conversation';
import { defaultPreferences, type Bootstrap, type Conversation } from '../src/shared/types';
import { FakeEventSource } from './fake-event-source';
import { advance, mountRoot, renderedProps, stubMatchMedia, typeInto, type Mount } from './ui-harness';

// Only the network is replaced. Every request a test did not list fails loudly; see `unexpected`.
vi.mock('../src/client-api', async original => (await import('./helpers/request-mock')).withRequest({
  ...await original<typeof import('../src/client-api')>(), api: vi.fn(), write: vi.fn(),
}));
// Each text React Markdown parses, in order. remark-gfm is the plugin the app hands every parse; this
// runs it unchanged and adds a step that records the source, so the real parser and components run.
const parses = vi.hoisted(() => [] as string[]);
vi.mock('remark-gfm', async original => {
  const real = (await original<typeof import('remark-gfm')>()).default;
  return { default: function (this: unknown, ...args: Parameters<typeof real>) {
    real.apply(this as never, args);
    return (_tree: unknown, file: { value: unknown }) => { parses.push(String(file.value)); };
  } };
});

let mount: Mount, container: HTMLDivElement, boot: Bootstrap, conversation: Conversation;
// What the next conversation read throws, as the client API reports it; undefined answers it.
let failure: Error | undefined;
let unexpected: string[];
// A request that never reached the app, as the client API reports a failed fetch: it may be a blip.
const blip = () => new ApiError("Can't reach the app. Your draft is kept. We'll reconnect automatically.", 503, 'CONNECTION_UNAVAILABLE');
const form = '```agent-ui\n' + JSON.stringify({ version: 1, cards: [{ id: 'gate', type: 'form', title: 'Gate check', fields: [{ id: 'state', label: 'State', kind: 'text', required: true }] }] }) + '\n```';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 10, 15));
  FakeEventSource.reset(); vi.stubGlobal('EventSource', FakeEventSource);
  stubMatchMedia();
  // Browser APIs jsdom lacks, which the real Avatar uses.
  Object.assign(SVGElement.prototype, { getTotalLength: () => 100, getPointAtLength: (length: number) => ({ x: length, y: 0 }) });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  history.replaceState(null, '', '/');
  failure = undefined; unexpected = []; parses.length = 0;
  boot = { user: { id: 'one', name: 'One', email: 'one@example.test' }, household: [], preferences: { ...structuredClone(defaultPreferences), startPage: 'assistant' },
    bots: [{ id: 'shared', name: 'Shared', shared: true, model: 'test', activity: 'idle' }],
    capabilities: Object.fromEntries(['chat', 'steering', 'approvals', 'uploads', 'generatedFiles', 'botConfiguration', 'tools', 'skills', 'routines', 'durableEvents', 'idempotency', 'imageGeneration', 'stop', 'portraitGeneration', 'avatarMetadata'].map(key => [key, { supported: true }])) as Bootstrap['capabilities'],
    connection: { connected: true }, csrfToken: 'csrf-one' };
  conversation = { botId: 'shared', messages: [{ id: 'answer-one', role: 'assistant', text: 'Existing canonical answer' }], approvals: [], files: [], activity: { state: 'idle' } };
  vi.mocked(api).mockReset().mockImplementation(async <T>(path: string) => {
    if (path === '/bootstrap?roster=lean') return boot as T;
    if (path.startsWith('/bots/shared/conversation?')) { if (failure) throw failure; return conversation as T; }
    if (path === '/bots/shared/draft') return { text: '', attachments: [] } as T;
    if (path === '/bots/shared/routine-runs') return { runs: [], unavailable: [] } as T;
    if (path === '/groups') return { supported: true, canSend: true, rooms: [] } as T;
    // A form card looks up its own unsent request; the server answers an ID it never saw as uncertain.
    if (path.startsWith('/submissions/')) return { requestId: path.slice('/submissions/'.length), status: 'uncertain' } as T;
    unexpected.push(`GET ${path}`);
    throw new Error(`This test serves no GET ${path}`);
  });
  vi.mocked(write).mockReset().mockImplementation(async <T>(path: string, _body: unknown, method = 'POST') => {
    // Presence and device activity report on their own schedule; any other write is a test failure.
    if (method === 'PUT' && (path === '/bots/shared/presence' || path === '/devices/activity')) return {} as T;
    unexpected.push(`${method} ${path}`);
    throw new Error(`This test serves no ${method} ${path}`);
  });
  mount = mountRoot(); container = mount.container;
});
// The app swallows some failed requests, so an unlisted one is caught here as well as where it was made.
afterEach(() => { Reflect.deleteProperty(navigator, 'onLine'); expect(unexpected).toEqual([]); });

// A change notice asks for a read, which then fails or succeeds.
const read = async () => { await act(async () => FakeEventSource.notifyAll()); await advance(0); };
// The household stream reports a change, so the session reads the roster again. It is the stream at
// /api/events that names no group; its query, such as the ping interval it asks for, is not part of that.
const household = (url: string) => { const at = new URL(url, 'http://app.test'); return at.pathname === '/api/events' && !at.searchParams.has('group'); };
const rosterChanged = async () => {
  const streams = [...FakeEventSource.streams].filter(stream => household(stream.url));
  // A helper that finds no stream would leave the roster unread and the test asserting on stale state.
  expect(streams.length).toBeGreaterThan(0);
  await act(async () => { for (const stream of streams) stream.emit('message', 'change'); });
  await advance(0);
};
const shown = () => container.querySelector('[aria-label="Hermes connection"]') !== null;
const sendButton = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Send"]')!;
const stopButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Stop response"]')!;
const status = () => container.querySelector('#composer-paste-status')!;
const opened = async () => {
  await mount.render(createElement(App)); await advance(20);
  expect(container.querySelector('.transcript [data-message-id]')).not.toBeNull();
  expect(shown()).toBe(false);
};
const submitWithKeyboard = (field: HTMLTextAreaElement) => act(async () => {
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
});
const sends = () => vi.mocked(write).mock.calls.filter(([path]) => /^\/bots\/shared\/(messages|stop)/.test(String(path)));

describe('a failed conversation read', () => {
  it('shows nothing for one failure that the next read answers', async () => {
    await opened();
    failure = blip(); await read();
    await advance(DISCONNECT_GRACE_MS - 1);
    failure = undefined; await read();
    await advance(DISCONNECT_GRACE_MS);
    expect(shown()).toBe(false);
  });

  // The app's one connection announcement follows what the chat shows, not the first failed read, so a
  // blip that changes nothing on screen says nothing to a screen reader either.
  it('announces the connection is down only once the chat shows it', async () => {
    await opened();
    const announced = () => container.querySelector('[data-connection-announcer]')!.textContent;
    failure = blip(); await read();
    expect(shown()).toBe(false);
    expect(announced()).toBe('');
    await read();
    expect(shown()).toBe(true);
    expect(announced()).not.toBe('');
    failure = undefined; await read();
    expect(announced()).toBe('');
  });

  // The notice above the composer is rebuilt when the roster is read again. It follows what the chat shows
  // then too, not the failed read that is still inside its grace period.
  it('keeps the notice away through a roster refresh during the grace period', async () => {
    await opened();
    failure = blip(); await read();
    await rosterChanged();
    expect(shown()).toBe(false);
  });

  it('shows the connection is down on a second failure in a row', async () => {
    await opened();
    failure = blip(); await read();
    expect(shown()).toBe(false);
    await read();
    expect(shown()).toBe(true);
  });

  it('shows it once a failure goes 3 seconds without a successful read, not a millisecond sooner, and clears on the next success', async () => {
    await opened();
    failure = blip(); await read();
    await advance(DISCONNECT_GRACE_MS - 1);
    expect(shown()).toBe(false);
    await advance(1);
    expect(shown()).toBe(true);
    failure = undefined; await read();
    expect(shown()).toBe(false);
  });

  it.each([
    ['the browser is offline', () => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); return blip(); }, true],
    ['the server answers that Hermes is unreachable', () => new ApiError('The Hermes operation could not be completed', 502, 'unreachable'), true],
    ['the answer was unreadable', () => new ApiError('The app returned an unreadable response.', 502, 'INVALID_RESPONSE'), false],
    ['the server failed without a code', () => new ApiError('Request failed (500)', 500), false],
    ['the failure is not an API error', () => new Error('Hermes is restarting.'), false],
  ])('on one failure, shows at once only when it proves the connection is down: %s', async (_name, make, atOnce) => {
    await opened();
    failure = make(); await read();
    expect(shown()).toBe(atOnce);
  });

  it('refuses a send during the grace period, says why, and allows it once a read succeeds', async () => {
    conversation = { ...conversation, activity: { state: 'working', runId: 'run-1' } };
    await opened();
    failure = blip(); await read();
    expect(shown()).toBe(false);
    const field = container.querySelector('textarea')!;
    // With words, a running reply offers Send guidance. A disabled button's title is its tooltip and,
    // beside its label, what a screen reader reads as its description.
    await typeInto(field, 'Check the gate');
    expect(sendButton().disabled).toBe(true);
    expect(sendButton().title).toBe(CHECKING_CONNECTION);
    // Nothing visible appears until the person tries to send.
    expect(status().textContent).toBe('');
    await submitWithKeyboard(field);
    // The composer's status line, a polite live region that is always present, says it once.
    expect(status().textContent).toBe(NOT_SENT_CHECKING);
    await act(async () => container.querySelector('form')!.requestSubmit());
    expect(sends()).toEqual([]);
    expect(field.getAttribute('aria-describedby')).toBe('composer-paste-status');
    failure = undefined; await read();
    expect(sendButton().disabled).toBe(false);
    expect(sendButton().hasAttribute('title')).toBe(false);
  });

  // Stop is its own request. A failed read that may be a blip leaves it alone; the chat showing the connection
  // down, which says why, is what turns it off.
  describe('Stop', () => {
    const stops = () => vi.mocked(write).mock.calls.filter(([path]) => path === '/bots/shared/stop');
    const press = (init: KeyboardEventInit) => act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });
    const question = () => document.querySelector('[role="alertdialog"]');
    beforeEach(() => {
      // jsdom has no modal dialogs.
      Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
      Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
      conversation = { ...conversation, activity: { state: 'working', runId: 'run-1' } };
      const refused = vi.mocked(write).getMockImplementation()!;
      vi.mocked(write).mockImplementation(async <T>(path: string, body: unknown, method?: string) => path === '/bots/shared/stop' ? {} as T : refused(path, body, method) as Promise<T>);
    });

    it('works by button and by Ctrl+. during the grace period, and is gone once the chat shows it is disconnected', async () => {
      await opened();
      failure = blip(); await read();
      expect(shown()).toBe(false);
      await typeInto(container.querySelector('textarea')!, '');
      expect(stopButton().disabled).toBe(false);
      expect(stopButton().title).toBe('Stop response');
      await act(async () => stopButton().click());
      expect(stops()).toHaveLength(1);
      await press({ key: '.', ctrlKey: true });
      expect(question()?.textContent).toContain("Stop Shared's work?");
      await act(async () => [...question()!.querySelectorAll('button')].find(button => button.textContent === 'Stop work')!.click());
      expect(stops()).toHaveLength(2);
      await advance(DISCONNECT_GRACE_MS);
      expect(shown()).toBe(true);
      // The chat no longer claims work is running, so there is nothing to stop and no shortcut for it.
      expect(stopButton()).toBeNull();
      await press({ key: '.', ctrlKey: true });
      expect(question()).toBeNull();
      expect(stops()).toHaveLength(2);
    });

    it('tells the person when a stop sent during the grace period finds the connection gone, and sends it once', async () => {
      await opened();
      failure = blip(); await read();
      vi.mocked(write).mockRejectedValueOnce(blip());
      await typeInto(container.querySelector('textarea')!, '');
      await act(async () => stopButton().click());
      expect(stops()).toHaveLength(1);
      expect(container.textContent).toContain("Can't reach the app");
      // Nothing retries it behind the person's back.
      await advance(DISCONNECT_GRACE_MS * 2);
      expect(stops()).toHaveLength(1);
    });
  });

  it('hands the explanation to the connection notice once the chat shows it is down', async () => {
    await opened();
    failure = blip(); await read();
    const field = container.querySelector('textarea')!;
    await typeInto(field, 'Check the gate');
    await submitWithKeyboard(field);
    expect(status().textContent).toBe(NOT_SENT_CHECKING);
    await read();
    expect(shown()).toBe(true);
    // One notice explains it: the status line clears, and a refused send adds nothing to it.
    expect(status().textContent).toBe('');
    await submitWithKeyboard(field);
    expect(status().textContent).toBe('');
    expect(sendButton().title).toBe(WAITING_FOR_CONNECTION);
    expect(sends()).toEqual([]);
  });

  it.each([
    ['one failure, still in its grace period', 1],
    ['two failures in a row, shown as disconnected', 2],
  ])('stops counting a failure once its chat is gone, so the empty state offers setup: %s', async (_name, failures) => {
    await opened();
    failure = blip();
    for (let n = 0; n < failures; n++) await read();
    expect(shown()).toBe(failures > 1);
    // The household refresh removes the last assistant while the chat's read is still failing.
    boot = { ...boot, bots: [] };
    await rosterChanged();
    expect(container.querySelector('[data-message-id]')).toBeNull();
    // Long past the grace period, and the failure belonged to a chat that no longer exists.
    await advance(DISCONNECT_GRACE_MS * 2);
    expect(shown()).toBe(false);
    // The transcript's own button; the home list has one too.
    const create = [...container.querySelectorAll('.transcript button')].find(item => item.textContent?.trim() === 'Create an assistant') as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    expect(create.hasAttribute('title')).toBe(false);
    // jsdom has no modal dialogs.
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
    await act(async () => create.click());
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(document.querySelector('dialog[open]')?.textContent).toContain('assistant');
  });

  it('re-parses only the replies that show the connection, and re-renders only the turns that do', async () => {
    const ask = (id: string, text: string) => ({ id, role: 'user' as const, text, sender: { id: 'one', name: 'One' } });
    conversation = { ...conversation, activity: { state: 'working', runId: 'run-1' }, messages: [
      ask('q1', 'Is the gate shut?'), { id: 'a1', role: 'assistant', text: 'The **north gate** is shut.' },
      ask('q2', 'Check it for me'), { id: 'p2', role: 'assistant', interim: true, text: 'Let me write up a *short* form.' }, { id: 'a2', role: 'assistant', text: `Fill this in.\n\n${form}` },
      ask('q3', 'Watch the barn'), { id: 't3', role: 'tool', text: '', toolCall: { id: 'watch', name: 'terminal', status: 'running' } }, { id: 'a3', role: 'assistant', text: 'Watching the *barn* now.' },
    ] };
    await opened();
    // Which reply each parse since the last check belonged to.
    const parsedSince = () => parses.splice(0).map(text => conversation.messages.find(message => message.role === 'assistant' && message.text.includes(text.trim()))?.id ?? text);
    expect(new Set(parsedSince())).toEqual(new Set(['a1', 'p2', 'a2', 'a3']));
    // The first turn shows neither a card nor a running tool. Its rows only render with their turn, and
    // no public API reports a skipped render, so this reads the props object React keeps on each row:
    // renderedProps throws if a React upgrade stops keeping it, rather than passing.
    const first = container.querySelector<HTMLElement>('[data-message-id="a1"]')!.closest<HTMLElement>('.conversation-turn')!;
    const quiet = [first, ...first.querySelectorAll<HTMLElement>(':scope > article')];
    expect(quiet).toHaveLength(3);
    const before = quiet.map(renderedProps);
    const quietRendered = () => quiet.some((element, index) => renderedProps(element) !== before[index]);
    const submit = () => container.querySelector<HTMLButtonElement>('[data-message-id="a2"] .reply-cards button[type="submit"]')!;
    const lastSeen = () => container.querySelector('[data-message-id="a3"]')!.closest('.conversation-turn')!.textContent;
    expect(submit().disabled).toBe(false);
    // One failure: the card refuses at once, and only its block parses again.
    failure = blip(); await read();
    expect(submit().disabled).toBe(true);
    expect(parsedSince()).toEqual(['a2']);
    expect(quietRendered()).toBe(false);
    expect(lastSeen()).not.toContain('Last seen running');
    // The connection is down: the running tool says so, and no reply parses again.
    await read();
    expect(shown()).toBe(true);
    expect(lastSeen()).toContain('Last seen running');
    expect(parsedSince()).toEqual([]);
    expect(quietRendered()).toBe(false);
    failure = undefined; await read();
    expect(submit().disabled).toBe(false);
    expect(parsedSince()).toEqual(['a2']);
    expect(quietRendered()).toBe(false);
  });
});
