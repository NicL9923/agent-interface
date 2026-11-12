// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { api, write } from '../src/client-api';
import { defaultPreferences, type Bootstrap, type Conversation, type SavedDraft } from '../src/shared/types';
import type { GroupCatalog, GroupRoom } from '../src/shared/collaboration';
import { GROUP_FALLBACK_POLL_MS } from '../src/app/use-session';
import { FakeEventSource } from './fake-event-source';
import { advance, mountRoot, stubMatchMedia, type Mount } from './ui-harness';

// While the streams are live they stand in for the polls. When one has been down for 20 seconds, the
// connection notice says live updates stopped, and one live region announces each connection change.

// Only the network is replaced: presence, device activity, the avatar and every other component run for
// real. A request no test listed fails where it is made and again after the test; see `unexpected`.
vi.mock('../src/client-api', async original => (await import('./helpers/request-mock')).withRequest({
  ...await original<typeof import('../src/client-api')>(), api: vi.fn(), write: vi.fn(),
}));

const START = Date.UTC(2026, 10, 10, 15);
let mount: Mount, container: HTMLDivElement, boot: Bootstrap, conversation: Conversation;
let unexpected: string[];
let draft: SavedDraft | null;
let catalog: GroupCatalog;
const member = (id: string, name: string) => ({ member_id: id, profile: id, handle: id, display_name: name });
const room: GroupRoom = { room_id: 'supper', name: 'Supper', members: [member('shared', 'Shared'), member('other', 'Other')] };

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  FakeEventSource.reset(); vi.stubGlobal('EventSource', FakeEventSource);
  stubMatchMedia();
  // Browser APIs jsdom lacks, which the real Avatar uses.
  Object.assign(SVGElement.prototype, { getTotalLength: () => 100, getPointAtLength: (length: number) => ({ x: length, y: 0 }) });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  history.replaceState(null, '', '/');
  unexpected = []; draft = null;
  catalog = { supported: true, canSend: true, rooms: [room] };
  boot = { user: { id: 'one', name: 'One', email: 'one@example.test' }, household: [], preferences: { ...structuredClone(defaultPreferences), startPage: 'assistant' },
    bots: [{ id: 'shared', name: 'Shared', shared: true, model: 'test', activity: 'idle' }, { id: 'other', name: 'Other', shared: true, model: 'test', activity: 'idle' }],
    capabilities: Object.fromEntries(['chat', 'steering', 'approvals', 'uploads', 'generatedFiles', 'botConfiguration', 'tools', 'skills', 'routines', 'durableEvents', 'idempotency', 'imageGeneration', 'stop', 'portraitGeneration', 'avatarMetadata'].map(key => [key, { supported: true }])) as Bootstrap['capabilities'],
    connection: { connected: true }, csrfToken: 'csrf-one' };
  conversation = { botId: 'shared', messages: [{ id: 'answer-one', role: 'assistant', text: 'Existing canonical answer' }], approvals: [], files: [], activity: { state: 'idle' } };
  vi.mocked(api).mockReset().mockImplementation(async <T>(path: string) => {
    if (path === '/bootstrap?roster=lean') return boot as T;
    // A conversation read carries the reader's draft, as the server's does.
    if (path.startsWith('/bots/shared/conversation?')) return { ...conversation, draft } as T;
    if (path === '/bots/shared/draft') return draft as T;
    if (path === '/bots/shared/routine-runs') return { runs: [], unavailable: [] } as T;
    if (path === '/groups') return catalog as T;
    if (path === '/groups/supper') return { room, driver_status: { working: false, blocked: false, pending_actions: [] } } as T;
    if (path.startsWith('/groups/supper/log?')) return { events: [], cursor: 0, has_more: false } as T;
    if (path === '/today?pending=1') return { generatedAt: '2026-11-10T15:00:00Z', frontier: '0', hasMore: false, since: '2026-11-10T00:00:00Z', unavailableBots: [], items: [], events: [] } as T;
    unexpected.push(`GET ${path}`);
    throw new Error(`This test serves no GET ${path}`);
  });
  // Presence and device activity run for real, and write nothing in a page that never had focus or input.
  vi.mocked(write).mockReset().mockImplementation(async (path: string, _body: unknown, method = 'POST') => {
    unexpected.push(`${method} ${path}`);
    throw new Error(`This test serves no ${method} ${path}`);
  });
  mount = mountRoot(); container = mount.container;
});
// The app swallows some failed requests, so an unlisted one is caught here as well as where it was made.
afterEach(() => { Reflect.deleteProperty(navigator, 'onLine'); expect(unexpected).toEqual([]); });

const stream = (match: (url: string) => boolean) => [...FakeEventSource.streams].filter(item => match(item.url)).at(-1)!;
const household = () => stream(url => url.startsWith('/api/events?ping'));
const chat = () => stream(url => url.includes('/bots/'));
const panels = () => [...container.querySelectorAll('section[aria-label="Hermes connection"]')];
const notice = () => panels().map(panel => panel.querySelector('h2')?.textContent);
const reads = (match: (path: string) => boolean) => vi.mocked(api).mock.calls.filter(([path]) => match(String(path))).length;
/** Keeps every stream but `except` alive, as a server that pings every 10 seconds does. */
const pinging = async (ms: number, except?: FakeEventSource) => {
  for (let waited = 0; waited < ms; waited += 1_000) {
    if (waited % 10_000 === 0) await act(async () => { for (const item of FakeEventSource.streams) if (item !== except && item.readyState === FakeEventSource.OPEN) item.emit('ping', '10'); });
    await advance(1_000);
  }
};
/** Opens the app with every stream live: connected, greeted, and pinged again 10 seconds later. */
const live = async () => {
  await mount.render(createElement(App)); await advance(20);
  await act(async () => { await vi.dynamicImportSettled(); });
  await act(async () => { for (const item of FakeEventSource.streams) { item.connect(); item.emit('ping', '10'); } });
  await advance(10_000);
  await pinging(1_000);
};
const goOffline = async () => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
  await act(async () => window.dispatchEvent(new Event('offline'))); await advance(20);
};

describe('live updates and the connection notice', () => {
  it('shows one quiet notice 20 seconds into an outage, keeps it through the stream being replaced, and clears it once the stream is back', async () => {
    await live();
    const cut = household();
    await act(async () => cut.drop());
    await pinging(19_000, cut);
    expect(panels()).toEqual([]);
    await pinging(1_000, cut);
    expect(notice()).toEqual(['Reconnecting live updates']);
    // The drop was closed and retried within 2 seconds; that replacement has not connected, so the outage goes on.
    await pinging(10_000, cut);
    expect(FakeEventSource.created.filter(url => url.startsWith('/api/events?ping'))).toHaveLength(2);
    expect(notice()).toEqual(['Reconnecting live updates']);
    // Connecting alone, or its greeting, is not live: the stream is back once it pings again an interval later.
    await act(async () => { household().connect(); household().emit('ping', '10'); }); await advance(20);
    expect(notice()).toEqual(['Reconnecting live updates']);
    await pinging(11_000);
    expect(panels()).toEqual([]);
  });

  it('never shows for a brief drop', async () => {
    await live();
    await act(async () => chat().drop());
    await pinging(5_000, chat());
    await act(async () => chat().connect());
    await pinging(60_000);
    expect(panels()).toEqual([]);
  });

  it('says offline in the same single notice when the device is offline too', async () => {
    await live();
    await goOffline();
    await act(async () => chat().drop());
    await pinging(25_000, chat());
    expect(notice()).toEqual(["You're offline"]);
  });

  // The reviewer's reproductions.
  it('keeps polling and keeps the notice while a replacement that sent only its headers stays silent', async () => {
    const conversationReads = () => reads(path => path.startsWith('/bots/shared/conversation?'));
    await live();
    const cut = chat();
    await pinging(27_000, cut);
    const replacement = chat();
    expect(replacement).not.toBe(cut);
    // Headers and `retry: 3000`, then nothing: open is not data.
    await act(async () => replacement.connect()); await advance(20);
    const connected = conversationReads();
    await pinging(60_000, replacement);
    expect(conversationReads(), 'the 30-second poll stands in').toBeGreaterThanOrEqual(connected + 2);
    expect(notice()).toEqual(['Reconnecting live updates']);
  });

  it('reloads and rebinds the open chat when bootstrap names a new canonical session, which Hermes announces only on the roster', async () => {
    boot = { ...boot, bots: [{ ...boot.bots[0], sessionId: 'session-one' }, boot.bots[1]] };
    await live();
    expect(container.textContent).toContain('Existing canonical answer');
    const first = chat();
    // Another device starts a new session. Hermes tells roster watchers, not chat watchers.
    conversation = { ...conversation, sessionId: 'session-two', messages: [{ id: 'fresh', role: 'assistant', text: 'Fresh session answer' }] };
    boot = { ...boot, bots: [{ ...boot.bots[0], sessionId: 'session-two' }, boot.bots[1]] };
    await act(async () => household().emit('roster', 'roster')); await advance(20);
    expect(container.textContent).toContain('Fresh session answer');
    expect(container.textContent).not.toContain('Existing canonical answer');
    expect(first.readyState, "the old session's stream is replaced").toBe(FakeEventSource.CLOSED);
    expect(chat()).not.toBe(first);
  });

  it('does not rebind for a session named for the first time', async () => {
    await live();
    const first = chat();
    boot = { ...boot, bots: [{ ...boot.bots[0], sessionId: 'session-one' }, boot.bots[1]] };
    await act(async () => household().emit('roster', 'roster')); await advance(20);
    expect(first.readyState, 'a session named for the first time is not a new one').toBe(FakeEventSource.OPEN);
    expect(FakeEventSource.created.filter(url => url.includes('/bots/'))).toHaveLength(1);
  });

  // A successful bootstrap read says nothing about the chat's stream, so a new session must not forgive that
  // stream's failures. A roster that names two sessions in turn used to connect again on every change.
  it("keeps the chat stream's retry budget when bootstrap keeps naming a new canonical session", async () => {
    boot = { ...boot, bots: [{ ...boot.bots[0], sessionId: 'session-one' }, boot.bots[1]] };
    await live();
    const attempts = () => FakeEventSource.created.filter(url => url.includes('/bots/')).length;
    const refuse = () => act(async () => { for (const item of [...FakeEventSource.streams]) if (item.url.includes('/bots/')) item.fail(); });
    await refuse();
    const before = attempts();
    // Twenty changes in 400 ms, inside the first retry's wait of a second or more.
    for (let change = 0; change < 20; change++) {
      const sessionId = change % 2 ? 'session-one' : 'session-two';
      conversation = { ...conversation, sessionId, messages: [{ id: `answer-${sessionId}`, role: 'assistant', text: `Answer in ${sessionId}` }] };
      boot = { ...boot, bots: [{ ...boot.bots[0], sessionId }, boot.bots[1]] };
      await act(async () => household().emit('roster', 'roster')); await advance(20);
      await refuse();
    }
    // The chat still reloads for each new session.
    expect(container.textContent).toContain('Answer in session-one');
    expect(attempts() - before, 'chat stream attempts made by the session changes').toBe(0);
  });

  it('shows one panel, not two, in a chat with no assistant once the connection is lost', async () => {
    boot = { ...boot, bots: [] };
    await live();
    await goOffline();
    expect(notice()).toEqual(["You're offline"]);
  });

  it('shows the notice on Today, which has no composer', async () => {
    boot.preferences = { ...boot.preferences, startPage: 'today' };
    await live();
    expect(container.querySelector('textarea')).toBeNull();
    const cut = household();
    await act(async () => cut.drop());
    await pinging(21_000, cut);
    expect(notice()).toEqual(['Reconnecting live updates']);
  });

  it('reads bootstrap every 5 minutes while the household stream is live, and every 45 seconds while it is down', async () => {
    const bootstraps = () => reads(path => path === '/bootstrap?roster=lean');
    await live();
    const before = bootstraps();
    await pinging(4 * 60_000);
    expect(bootstraps(), 'a live stream announces roster changes').toBe(before);
    await pinging(90_000);
    expect(bootstraps()).toBe(before + 1);
    const cut = household();
    await act(async () => cut.drop());
    const down = bootstraps();
    await pinging(90_000, cut);
    expect(bootstraps()).toBe(down + 2);
  });

  // A catalog that says group chats are unsupported changes only with the server, and a server
  // that hosts none sends no notices, so the 30-second poll would read the same answer forever.
  it('reads an unsupported catalog only every 5 minutes', async () => {
    catalog = { supported: false, canSend: false, rooms: [], reason: 'This Hermes version does not expose hosted group chats.' };
    await live();
    const catalogReads = () => reads(path => path === '/groups');
    const opened = catalogReads();
    await pinging(GROUP_FALLBACK_POLL_MS - 12_000);
    expect(catalogReads()).toBe(opened);
    await pinging(1_000);
    expect(catalogReads()).toBe(opened + 1);
  });

  // The stream drops, the phone sends the draft, and the stream is back before the next poll. The
  // reconnect's conversation read carries the new draft, and nothing else would show it.
  it('takes a draft changed during a reconnect from the read that reconnect makes, so sent text never lingers', async () => {
    draft = { text: 'Buy feed', attachments: [], revision: 1, reason: 'edit', sentRevision: 0 };
    await live();
    const textarea = () => container.querySelector('textarea')!;
    const draftReads = () => reads(path => path === '/bots/shared/draft');
    expect(textarea().value).toBe('Buy feed');
    await act(async () => chat().drop());
    // The phone sends it, which clears the shared draft.
    draft = { text: '', attachments: [], revision: 2, reason: 'sent', sentRevision: 2 };
    await advance(3_000);
    const before = draftReads();
    await act(async () => { chat().connect(); chat().emit('ping', '10'); }); await advance(0);
    expect(textarea().value).toBe('');
    expect(draftReads(), 'the conversation read already carried it').toBe(before);
  });
});

// A screen reader hears a connection change through one live region, wherever the person is and however
// wide the window. The sidebar's chip and the notice panels show the state without announcing it again.
describe('the connection live region', () => {
  const LIVE = '[role="status"], [role="alert"], [role="log"], [aria-live]:not([aria-live="off"])';
  /** Live regions a screen reader can reach, outside inert or hidden content, that speak about the connection. */
  const regions = () => [...container.querySelectorAll(LIVE)]
    .filter(region => !region.closest('[inert], [aria-hidden="true"]'))
    .filter(region => region.closest('[aria-label="Hermes connection"]') || /offline|reconnect|connection|live updates/i.test(region.textContent ?? ''));
  const views = {
    Today: { url: '/?view=today', shown: () => container.querySelector('.chat-header-today') },
    chat: { url: '/?bot=shared', shown: () => container.querySelector('textarea') },
    'group chat': { url: '/?view=group&room=supper', shown: () => container.querySelector('.chat-title h1')?.textContent === 'Supper' ? true : null },
  };
  const states = {
    online: async () => {},
    offline: goOffline,
    'with live updates down': async () => { const cut = household(); await act(async () => cut.drop()); await pinging(21_000, cut); },
  };
  const cases = (Object.keys(views) as (keyof typeof views)[]).flatMap(view => ['desktop', 'phone'].flatMap(width =>
    (Object.keys(states) as (keyof typeof states)[]).map(state => [view, width, state] as const)));
  it.each(cases)('on %s at %s width %s, one region announces the connection', async (view, width, state) => {
    if (width === 'phone') stubMatchMedia(query => query === '(max-width: 620px)');
    history.replaceState(null, '', views[view].url);
    await live();
    expect(views[view].shown(), `the ${view} view is open`).toBeTruthy();
    await states[state]();
    expect(regions()).toHaveLength(state === 'online' ? 0 : 1);
  });

  it('is in the page before the connection changes, so the change is announced, on the phone home list too', async () => {
    stubMatchMedia(query => query === '(max-width: 620px)');
    await live();
    // A phone opens on the home list, which covers the view behind it.
    expect(container.querySelector('main[inert]')).not.toBeNull();
    const region = container.querySelector('[data-connection-announcer]');
    expect(region?.textContent).toBe('');
    const cut = household();
    await act(async () => cut.drop());
    await pinging(21_000, cut);
    expect(regions()).toEqual([region]);
    expect(region!.textContent).toContain('Reconnecting live updates');
    await goOffline();
    expect(regions()).toEqual([region]);
    expect(region!.textContent).toContain("You're offline");
  });
});
