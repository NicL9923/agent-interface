import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';

// Every order of the worker's account steps, not only the ones a review named. Each run takes a few
// ACCOUNT messages, a push for each of two members, a tap on a notification of each (one of which
// finds no window to open, so the notification comes back) and a Decline that fails, and a worker
// restart, holds every asynchronous step the worker takes for them open (each read and write of Cache
// Storage, the account's hash, showNotification, getNotifications, the windows and the Decline's
// request), and releases them in an order a seeded random walk picks. Then it checks the invariants
// written at the top of the worker's account code. The worker is the real script; only Cache Storage,
// notifications, windows, the network, the badge and the hash are fakes.
//
// The page writes the app badge through the worker too (a BADGE message). After each word the page
// says, in its own order, a clear for the account it left and the count of the account it shows, as the
// app does when a generation ends and the next draws. Other tabs that have not heard the latest word say
// a count or a clear for an account of their own at random places, which can land anywhere among the
// rest. Once the worker is idle the badge is the latest account's count, or none.

type Member = 'one' | 'two';
type Word = Member | null;
const marker = (user: string) => createHash('sha256').update(`wildbots-account:${user}`).digest('hex').slice(0, 16);
const stateOf = (word: Word) => word ? { marker: marker(word) } : { signedOut: true };
const COUNT: Record<Member, number> = { one: 1, two: 4 };

// The script is compiled once and run as a function per worker, so each worker has its own top-level
// state, as a restarted worker does, without the cost of a new context per run.
const source = readFileSync('scripts/service-worker.js', 'utf8')
  .replace('__BUILD_ID__', 'test').replace('__PRECACHE__', '[]').replace('__WARM__', '[]').replace('__ON_DEMAND__', '[]');
const GLOBALS = ['self', 'caches', 'crypto', 'TextEncoder', 'Response', 'URL', 'MessageChannel', 'fetch', 'setTimeout', 'clearTimeout'] as const;
const start = vm.runInNewContext(`(function (${GLOBALS.join(', ')}) {\n${source}\n})`, {}) as (...values: unknown[]) => void;

// A Response with a body that reads in a microtask, so the only steps that wait are the ones held below.
class FakeResponse {
  constructor(readonly body: string) {}
  async json() { return JSON.parse(this.body); }
}

type Held = { label: string; release(fail: boolean): void };
type Notification = { account?: string; title: string };
type Browser = {
  /** Every call the worker made that this test does not fake. The fakes throw, and the worker's chain swallows a throw, so only this list shows it. */
  refused: string[];
  /** Each notification the worker asked the browser to show, and the latest word at that moment: undefined before any, or when no word has arrived and the saved account decides. */
  shows: { title: string; account?: string; word: Word | undefined }[];
  saved: Map<string, FakeResponse>;
  listed: Notification[];
  badge: number | undefined;
  /** Whether the latest ACCOUNT message of the run has arrived. */
  latestSaid: boolean;
  /** The word of the newest ACCOUNT message that has arrived, or undefined before the first. */
  said: Word | undefined;
  /** Whether the badge showed the latest account's count and was then cleared, after the latest message arrived. */
  latestBadgeCleared: boolean;
  /** Counts of another account set after the latest message arrived, even if cleared again later. */
  otherBadgeUnderLatest: number[];
  /** Notifications of the latest account closed after it arrived. */
  closedUnderLatest: string[];
  latest: Word;
  held: Held[];
  waits: Promise<unknown>[];
  counts: Map<string, number>;
};
const hold = <T>(browser: Browser, kind: string, value: () => T, mayFail = false) => new Promise<T>((resolve, reject) => {
  const n = (browser.counts.get(kind) ?? 0) + 1;
  browser.counts.set(kind, n);
  browser.held.push({ label: `${kind}#${n}`, release: fail => {
    if (fail && mayFail) reject(new Error(`${kind} refused`)); else resolve(value());
  } });
});
// A plain function, not an arrow, so a worker that calls it with `new`, as with `new MessageChannel()`, is logged too.
const refuse = (browser: Browser, name: string) => function refused() {
  browser.refused.push(name);
  throw new Error(`The worker used ${name}, which this test does not fake`);
};

/** Starts the worker script over the browser's storage, screen and badge, as the browser does after stopping it. */
function startWorker(browser: Browser) {
  const handlers: Record<string, (event: unknown) => void> = {};
  const cache = {
    match: (key: string) => hold(browser, 'read', () => browser.saved.get(key)),
    put: (key: string, value: FakeResponse) => hold(browser, 'write', () => { browser.saved.set(key, value); }),
  };
  const self = {
    location: { origin: 'https://app.example' },
    addEventListener: (type: string, handler: (event: unknown) => void) => { handlers[type] = handler; },
    registration: {
      showNotification: (title: string, options: { data?: { account?: string } }) => {
        // Logged when the worker asks, which is when it decides: it must not ask for an account that has left.
        browser.shows.push({ title, account: options.data?.account, word: browser.said });
        return hold(browser, 'show', () => { browser.listed.push({ title, account: options.data?.account }); }, true);
      },
      getNotifications: () => hold(browser, 'list', () => browser.listed.slice().map(each => ({
        data: { account: each.account }, close: () => {
          const at = browser.listed.indexOf(each);
          if (at < 0) return;
          browser.listed.splice(at, 1);
          if (browser.latestSaid && browser.latest && each.account === marker(browser.latest)) browser.closedUnderLatest.push(each.title);
        },
      }))),
    },
    navigator: {
      setAppBadge: async (count: number) => {
        if (browser.latestSaid && (!browser.latest || count !== COUNT[browser.latest])) browser.otherBadgeUnderLatest.push(count);
        browser.badge = count;
      },
      clearAppBadge: async () => {
        if (browser.latestSaid && browser.latest && browser.badge === COUNT[browser.latest]) browser.latestBadgeCleared = true;
        browser.badge = 0;
      },
    },
    // No window is open, so a tap tries to open one, and a browser that will not leaves the notification to come back.
    clients: {
      matchAll: () => hold(browser, 'windows', () => [] as unknown[]),
      openWindow: () => hold(browser, 'open', () => undefined, true),
    },
  };
  const caches = {
    open: async (name: string) => { if (name !== 'wildbots-account') throw new Error(`Opened cache ${name}`); return cache; },
    has: refuse(browser, 'caches.has'), keys: refuse(browser, 'caches.keys'), delete: refuse(browser, 'caches.delete'),
  };
  const crypto = { subtle: { digest: (_algorithm: string, bytes: Uint8Array) => hold(browser, 'hash', () => new Uint8Array(createHash('sha256').update(bytes).digest()).buffer) } };
  // A Decline's request: answered as not accepted, or lost as when offline.
  const fetch = () => hold(browser, 'fetch', () => ({ ok: false }), true);
  start(self, caches, crypto, TextEncoder, FakeResponse, URL, refuse(browser, 'MessageChannel'), fetch, setTimeout, clearTimeout);
  const dispatch = (type: string, event: object) => handlers[type]!({ ...event, waitUntil: (value: Promise<unknown>) => { browser.waits.push(value); } });
  return {
    account: (word: Word) => dispatch('message', { data: { type: 'ACCOUNT', user: word } }),
    /** The page's app badge: `user` is the account its screens show, or null for none. */
    badge: (user: Word, count: number) => dispatch('message', { data: { type: 'BADGE', user, count } }),
    push: (member: Member) => dispatch('push', { data: { json: () => ({ title: `For ${member}`, badge: COUNT[member], account: marker(member) }) } }),
    /** A tap on a notification of `member`, or on its Decline when `action` says so. The browser closed it as it was tapped. */
    click: (member: Member, action = '') => dispatch('notificationclick', {
      action,
      notification: {
        title: `Tapped ${member}`, body: 'News', icon: '/icon-192.png', badge: '/icon-192.png', tag: `event-${member}`, actions: [],
        data: { url: '/?bot=ranch', account: marker(member), ...action ? { declineToken: 't'.repeat(43) } : {} }, close() {},
      },
    }),
  };
}

/** A small seeded generator, so a failing order can be run again from its seed. */
function random(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 2 ** 32;
  };
}
const pick = <T>(next: () => number, items: readonly T[]) => items[Math.floor(next() * items.length)]!;
// Lets every promise the last release settled run to its next held step. Nothing the fakes do waits on a timer.
const drain = () => new Promise(resolve => setImmediate(resolve));

const WORDS: Word[] = ['one', 'two', null];
const MEMBERS: Member[] = ['one', 'two'];
// Every page order of `WORD_COUNT` words with no word twice in a row: a sign-in, a switch, a sign-out
// and its undo. Three is the default; SW_ORDER_WORDS=4 is a scratch run for orders that need a word
// to arrive, be overtaken and arrive again.
const WORD_COUNT = Number(process.env.SW_ORDER_WORDS ?? 3);
const SEQUENCES = Array.from({ length: WORD_COUNT - 1 }).reduce<Word[][]>(
  orders => orders.flatMap(order => WORDS.filter(word => word !== order.at(-1)).map(word => [...order, word])),
  WORDS.map(word => [word]),
);

type Event = { label: string; run(worker: ReturnType<typeof startWorker>): void } | { label: 'restart' };

/** One random walk. Returns what broke, and every pair of steps that were both ready, in the order it ran them. */
async function walk(seed: number) {
  const next = random(seed);
  const initial = pick(next, [undefined, 'one', 'two', null] as const);
  const browser: Browser = { refused: [], shows: [], said: initial, saved: new Map(), listed: [], badge: undefined, latestSaid: false, latestBadgeCleared: false, otherBadgeUnderLatest: [], closedUnderLatest: [], latest: null, held: [], waits: [], counts: new Map() };
  if (initial !== undefined) browser.saved.set('/account', new FakeResponse(JSON.stringify(stateOf(initial))));
  // A badge the saved account's push set before the browser stopped the worker, as the worker recorded it.
  if (initial) {
    browser.badge = COUNT[initial];
    browser.saved.set('/badge', new FakeResponse(JSON.stringify({ named: marker(initial) })));
  }
  const words = pick(next, SEQUENCES);
  browser.latest = words.at(-1)!;
  // The page's order: each word, then the clear its previous generation's screens make as they unmount, then
  // the count of the account that draws next (none for a sign-out).
  let writes = 0;
  const page = (user: Word, count: number): Event => ({ label: `BADGE#${++writes}`, run: worker => worker.badge(user, count) });
  const events: Event[] = words.flatMap((word, index): Event[] => [
    { label: `ACCOUNT#${index + 1}`, run: worker => { browser.said = word; worker.account(word); } },
    ...index ? [page(words[index - 1]!, 0)] : [],
    page(word, word ? COUNT[word] : 0),
  ]);
  // Tabs that did not hear the latest word: a count, or a clear, for an account other than the latest.
  const strangers = (browser.latest ? MEMBERS.filter(member => member !== browser.latest) : MEMBERS);
  const stranger = pick(next, strangers);
  const stale: Event[] = [
    { label: `BADGE#stale-set:${stranger}`, run: worker => worker.badge(stranger, COUNT[stranger]) },
    { label: `BADGE#stale-clear:${pick(next, strangers)}`, run: worker => worker.badge(pick(next, strangers), 0) },
    ...browser.latest ? [{ label: 'BADGE#stale-clear:none', run: (worker: ReturnType<typeof startWorker>) => worker.badge(null, 0) }] : [],
  ];
  const tapped = pick(next, MEMBERS), declined = pick(next, MEMBERS);
  for (const other of [
    { label: 'push:one', run: (worker: ReturnType<typeof startWorker>) => worker.push('one') },
    { label: 'push:two', run: (worker: ReturnType<typeof startWorker>) => worker.push('two') },
    { label: `tap:${tapped}`, run: (worker: ReturnType<typeof startWorker>) => worker.click(tapped) },
    { label: `decline:${declined}`, run: (worker: ReturnType<typeof startWorker>) => worker.click(declined, 'decline') },
    { label: 'restart' as const },
    ...stale,
  ]) events.splice(Math.floor(next() * (events.length + 1)), 0, other);
  let worker = startWorker(browser);
  const settled = new WeakSet<Promise<unknown>>();
  const rejected: string[] = [];
  const watch = (value: Promise<unknown>, label: string) => value.then(() => settled.add(value), (error: unknown) => { settled.add(value); rejected.push(`${label}: ${String(error)}`); });
  const pairs: string[] = [];
  const trace: string[] = [];
  for (let steps = 0; ; steps++) {
    if (steps > 500) throw new Error(`seed ${seed}: no end after 500 steps: ${trace.join(' ')}`);
    const idle = browser.held.length === 0 && browser.waits.every(value => settled.has(value));
    const ready = [
      ...events.length && (events[0]!.label !== 'restart' || idle) ? [events[0]!.label] : [],
      ...browser.held.map(each => each.label),
    ];
    if (!ready.length) {
      if (events.length || !idle) throw new Error(`seed ${seed}: stuck with nothing to release: ${trace.join(' ')}`);
      break;
    }
    const chosen = pick(next, ready);
    // Coverage counts the first and second step of each kind apart and the rest together, so it asks
    // for every order of the steps each run has, not for ever rarer runs with a fifth list.
    const key = (label: string) => label.replace(/#([3-9]|\d{2,})$/, '#3+');
    for (const other of ready) if (other !== chosen) pairs.push(`${key(chosen)} < ${key(other)}`);
    // A display or a request is lost one time in four; a window the worker tries to open is refused three times in four.
    const fail = (chosen.startsWith('show') || chosen.startsWith('fetch')) && next() < 0.25 || chosen.startsWith('open') && next() < 0.75;
    trace.push(fail ? `${chosen}(refused)` : chosen);
    if (chosen === events[0]?.label) {
      const event = events.shift()!;
      if (!('run' in event)) worker = startWorker(browser);
      else {
        const before = browser.waits.length;
        event.run(worker);
        if (event.label === `ACCOUNT#${words.length}`) browser.latestSaid = true;
        for (const value of browser.waits.slice(before)) void watch(value, event.label);
      }
    } else {
      const index = browser.held.findIndex(each => each.label === chosen);
      browser.held.splice(index, 1)[0]!.release(fail);
    }
    await drain();
  }

  const latest = browser.latest;
  // Each entry names the invariant it breaks, as written at the top of the worker's account code.
  const broke: [invariant: string, detail: string][] = [];
  const saved = browser.saved.get('/account');
  if (saved?.body !== JSON.stringify(stateOf(latest))) broke.push(['cache', `holds ${saved?.body} after ${String(latest)}`]);
  const others = browser.listed.filter(each => !latest || each.account !== marker(latest));
  if (others.length) broke.push(['screen', `lists ${others.map(each => each.title).join(', ')} under ${String(latest)}`]);
  // A step for an older word, still running when the latest arrived, closes nothing the latest allows.
  if (browser.closedUnderLatest.length) broke.push(['closed under the latest', `${browser.closedUnderLatest.join(', ')} closed after ${String(latest)} was said`]);
  // The page of the latest account says its count after the latest word, so the badge ends at that count,
  // or unset after a sign-out. Once the latest message arrived no push or page of another account set it
  // even for a moment.
  const counts = latest ? COUNT[latest] : 0;
  if ((browser.badge ?? 0) !== counts) broke.push(['badge is the latest account\'s count', `${browser.badge} under ${String(latest)}, which counts ${counts}`]);
  if (browser.otherBadgeUnderLatest.length) broke.push(['badge set by a departed account', `set ${browser.otherBadgeUnderLatest.join(', ')} after ${String(latest)} was said`]);
  // Once the latest message arrived, nothing clears the latest account's count: not a push or a page of
  // another account, and not a step for an older word that the latest overtook.
  if (browser.latestBadgeCleared) broke.push(['badge cleared under the latest', `${String(latest)}'s count ${COUNT[latest!]} was cleared after it was said`]);
  if (rejected.length) broke.push(['waitUntil', rejected.join('; ')]);
  // The fakes throw on a call the walk did not script, and the worker's chain swallows a throw.
  if (browser.refused.length) broke.push(['unscripted call', browser.refused.join(', ')]);
  // No notification was asked for after the word that made its account leave: whatever is listed at the end can hide a flash.
  const flashed = browser.shows.filter(({ account, word }) => word !== undefined && (word === null || account !== marker(word)));
  if (flashed.length) broke.push(['shown after its word', flashed.map(({ title, word }) => `${title} after ${String(word)}`).join(', ')]);
  // Started again on what this run left, the worker shows only the latest account's pushes.
  const fresh: Browser = { ...browser, refused: [], shows: [], listed: [], held: [], waits: [], counts: new Map() };
  const restarted = startWorker(fresh);
  restarted.push('one'); restarted.push('two');
  for (await drain(); fresh.held.length; await drain()) fresh.held.shift()!.release(false);
  await Promise.allSettled(fresh.waits);
  if (fresh.refused.length) broke.push(['unscripted call', `after the restart: ${fresh.refused.join(', ')}`]);
  const shownAfter = fresh.listed.map(each => each.title);
  const expected = latest ? [`For ${latest}`] : [];
  if (JSON.stringify(shownAfter) !== JSON.stringify(expected)) broke.push(['restart', `showed [${shownAfter.join(', ')}] after ${String(latest)}`]);
  return { broke, pairs, trace, initial, words };
}

const RUNS = Number(process.env.SW_ORDER_RUNS ?? 4000);
const FIRST_SEED = Number(process.env.SW_ORDER_SEED ?? 1);

it(`keeps the worker's account invariants in ${RUNS} seeded orders of its steps`, async () => {
  const failures: string[] = [];
  const byInvariant = new Map<string, number>();
  // How often each ordered pair of ready steps ran in that order.
  const seen = new Map<string, number>();
  for (let seed = FIRST_SEED; seed < FIRST_SEED + RUNS; seed++) {
    const { broke, pairs, trace, initial, words } = await walk(seed);
    for (const pair of pairs) seen.set(pair, (seen.get(pair) ?? 0) + 1);
    if (!broke.length) continue;
    for (const invariant of new Set(broke.map(([name]) => name))) byInvariant.set(invariant, (byInvariant.get(invariant) ?? 0) + 1);
    failures.push(`seed ${seed} (saved ${String(initial)}, words ${words.map(String).join(',')}): ${broke.map(([invariant, detail]) => `${invariant}: ${detail}`).join(' | ')}\n  ${trace.join(' ')}`);
  }
  // Each pair of steps that were ready together often enough to tell ran both ways round somewhere in
  // the sample. The walk picks evenly among the ready steps, so a pair picked twenty times one way and
  // never the other points at a sample too small for this worker; a pair ready together fewer times is
  // too rare to count.
  const oneWay = [...seen].filter(([pair, times]) => { const [a, b] = pair.split(' < '); return times >= 20 && !seen.has(`${b} < ${a}`); });
  const rare = [...seen].filter(([pair, times]) => { const [a, b] = pair.split(' < '); return times < 20 && !seen.has(`${b} < ${a}`); }).length;
  const summary = `${failures.length} of ${RUNS} orders broke an invariant, from seed ${FIRST_SEED}. Orders by invariant: ${JSON.stringify(Object.fromEntries(byInvariant))}`;
  expect(failures, `${summary}\nFirst failures:\n${failures.slice(0, 5).join('\n')}`).toEqual([]);
  expect(oneWay, `pairs of ready steps the sample ran only one way round (${seen.size} ordered pairs seen, ${rare} too rare to count)`).toEqual([]);
}, 60_000);
