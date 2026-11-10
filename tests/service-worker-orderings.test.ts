import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';

// Every order of the worker's account steps, not only the ones a review named. Each run takes a few
// ACCOUNT messages, a push for each of two members and a worker restart, holds every asynchronous
// step the worker takes for them open (the saved account's read, its write, the account's hash,
// showNotification and getNotifications), and releases them in an order a seeded random walk picks.
// Then it checks the invariants written at the top of the worker's account code. The worker is the
// real script; only Cache Storage, notifications, the badge and the hash are fakes.

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
  saved: Map<string, FakeResponse>;
  listed: Notification[];
  badge: number | undefined;
  /** Whether the latest ACCOUNT message of the run has arrived. */
  latestSaid: boolean;
  /** Whether the badge showed the latest account's count and was then cleared, after the latest message arrived. */
  latestBadgeCleared: boolean;
  /** Whether the badge was set while no page had yet named an account. */
  badgeSetUnsaid: boolean;
  /**
   * Whether no worker can know whose push set the badge: it was set while no page had named an
   * account, and the worker that set it has stopped since. The next word clears it, whoever's it was.
   */
  badgeOwnerLost: boolean;
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
const refuse = (name: string) => () => { throw new Error(`The worker used ${name}, which this test does not fake`); };

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
      showNotification: (title: string, options: { data?: { account?: string } }) =>
        hold(browser, 'show', () => { browser.listed.push({ title, account: options.data?.account }); }, true),
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
        browser.badgeSetUnsaid = !browser.saved.has('/account');
        browser.badgeOwnerLost = false;
      },
      clearAppBadge: async () => {
        if (browser.latestSaid && browser.latest && browser.badge === COUNT[browser.latest] && !browser.badgeOwnerLost) browser.latestBadgeCleared = true;
        browser.badge = 0;
      },
    },
    get clients() { return refuse('clients')(); },
  };
  const caches = {
    open: async (name: string) => { if (name !== 'wildbots-account') throw new Error(`Opened cache ${name}`); return cache; },
    has: refuse('caches.has'), keys: refuse('caches.keys'), delete: refuse('caches.delete'),
  };
  const crypto = { subtle: { digest: (_algorithm: string, bytes: Uint8Array) => hold(browser, 'hash', () => new Uint8Array(createHash('sha256').update(bytes).digest()).buffer) } };
  start(self, caches, crypto, TextEncoder, FakeResponse, URL, refuse('MessageChannel'), refuse('fetch'), setTimeout, clearTimeout);
  const dispatch = (type: string, event: object) => handlers[type]!({ ...event, waitUntil: (value: Promise<unknown>) => { browser.waits.push(value); } });
  return {
    account: (word: Word) => dispatch('message', { data: { type: 'ACCOUNT', user: word } }),
    push: (member: Member) => dispatch('push', { data: { json: () => ({ title: `For ${member}`, badge: COUNT[member], account: marker(member) }) } }),
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
// Every page order of three words with no word twice in a row: a sign-in, a switch, a sign-out and its undo.
const SEQUENCES = WORDS.flatMap(a => WORDS.flatMap(b => WORDS.filter(c => b !== a && c !== b).map(c => [a, b, c])));

type Event = { label: string; run(worker: ReturnType<typeof startWorker>): void } | { label: 'restart' };

/** One random walk. Returns what broke, and every pair of steps that were both ready, in the order it ran them. */
async function walk(seed: number) {
  const next = random(seed);
  const initial = pick(next, [undefined, 'one', 'two', null] as const);
  const browser: Browser = { saved: new Map(), listed: [], badge: undefined, latestSaid: false, latestBadgeCleared: false, badgeOwnerLost: false, badgeSetUnsaid: false, otherBadgeUnderLatest: [], closedUnderLatest: [], latest: null, held: [], waits: [], counts: new Map() };
  if (initial !== undefined) browser.saved.set('/account', new FakeResponse(JSON.stringify(stateOf(initial))));
  // A badge the saved account's push set before the browser stopped the worker.
  if (initial) browser.badge = COUNT[initial];
  const words = pick(next, SEQUENCES);
  browser.latest = words.at(-1)!;
  const events: Event[] = words.map((word, index) => ({ label: `ACCOUNT#${index + 1}`, run: worker => worker.account(word) }));
  for (const other of [
    { label: 'push:one', run: (worker: ReturnType<typeof startWorker>) => worker.push('one') },
    { label: 'push:two', run: (worker: ReturnType<typeof startWorker>) => worker.push('two') },
    { label: 'restart' as const },
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
    const fail = chosen.startsWith('show') && next() < 0.25;
    trace.push(fail ? `${chosen}(refused)` : chosen);
    if (chosen === events[0]?.label) {
      const event = events.shift()!;
      if (!('run' in event)) {
        if (browser.badgeSetUnsaid) browser.badgeOwnerLost = true;
        worker = startWorker(browser);
      }
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
  // The badge ends unset or at the latest account's count, and once the latest message arrived no push
  // of another account set it even for a moment.
  if (!(browser.badge === undefined || browser.badge === 0 || latest && browser.badge === COUNT[latest])) broke.push(['badge set by a departed push', `${browser.badge} under ${String(latest)}`]);
  if (browser.otherBadgeUnderLatest.length) broke.push(['badge set by a departed push', `set ${browser.otherBadgeUnderLatest.join(', ')} after ${String(latest)} was said`]);
  // Once the latest message arrived, nothing clears the latest account's count: not a push of another
  // account, and not a step for an older word that the latest overtook.
  if (browser.latestBadgeCleared) broke.push(['badge cleared under the latest', `${String(latest)}'s count ${COUNT[latest!]} was cleared after it was said`]);
  if (rejected.length) broke.push(['waitUntil', rejected.join('; ')]);
  // Started again on what this run left, the worker shows only the latest account's pushes.
  const fresh: Browser = { ...browser, listed: [], held: [], waits: [], counts: new Map() };
  const restarted = startWorker(fresh);
  restarted.push('one'); restarted.push('two');
  for (await drain(); fresh.held.length; await drain()) fresh.held.shift()!.release(false);
  await Promise.allSettled(fresh.waits);
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
