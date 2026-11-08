import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, expect, it, vi } from 'vitest';
import { installAuth } from '../src/server/auth.js';
import { Store } from '../src/server/store.js';
import { loadConfig } from '../src/server/config.js';
import { installAccountUsageRoutes, USAGE_KEPT_MS, USAGE_REFRESH_MS } from '../src/server/account-usage.js';
import { errorHandler, httpError } from '../src/server/http-error.js';
import type { AccountSnapshot, UsageAccount } from '../src/shared/account-usage.js';
import type { ExperienceRequest, ExperienceResult } from '../src/shared/experience.js';
import { botFixture, experienceRequester } from './helpers/runtime-fixtures.js';
import { fakeRuntime, signIn } from './helpers/server.js';

const CODEX = 'c'.repeat(32), ROUTER = 'b'.repeat(32), CLAUDE = 'a'.repeat(32), SECOND_CODEX = 'd'.repeat(32), PRIVATE = 'e'.repeat(32);
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

const snapshotFixture = (key: string, provider: string, changes: Partial<AccountSnapshot> = {}): AccountSnapshot => ({
  key, provider, plan: null, title: 'Account limits', fetchedAt: '2026-11-08T12:00:00Z', windows: [], details: [], unavailableReason: null, bankedResets: 0, identity: null, ...changes });
const window = (label: string, usedPercent: number | null, scope: 'account' | 'model' = 'account') => ({ label, usedPercent, resetsAt: '2026-11-08T17:00:00Z', detail: null, scope });

type Accounts = ExperienceResult<'accounts'>['accounts'];
/**
 * Assistants: ranch and garden share the ChatGPT account (ranch also falls back to OpenRouter), helper runs on
 * Claude with a second ChatGPT sign-in Hermes identifies as the same account, and "private" belongs to two.
 */
async function setup(options: { accounts?: Record<string, Accounts | Error>; usage?: Record<string, AccountSnapshot | Error> } = {}) {
  let clock = Date.parse('2026-11-08T12:00:00Z');
  const accounts: Record<string, Accounts | Error> = {
    ranch: [{ key: CODEX, provider: 'openai-codex', role: 'main' }, { key: ROUTER, provider: 'openrouter', role: 'fallback' }],
    garden: [{ key: CODEX, provider: 'openai-codex', role: 'main' }],
    // Helper falls back to the account ranch runs on, which still counts as in use.
    helper: [{ key: CLAUDE, provider: 'anthropic', role: 'main' }, { key: SECOND_CODEX, provider: 'openai-codex', role: 'fallback' }, { key: CODEX, provider: 'openai-codex', role: 'fallback' }],
    private: [{ key: PRIVATE, provider: 'nous', role: 'main' }],
    ...options.accounts,
  };
  const usage: Record<string, AccountSnapshot | Error> = {
    [CODEX]: snapshotFixture(CODEX, 'openai-codex', { plan: 'Pro', windows: [window('Session', 40), window('Weekly', 100)], bankedResets: 2, identity: 'i'.repeat(32) }),
    [SECOND_CODEX]: snapshotFixture(SECOND_CODEX, 'openai-codex', { identity: 'i'.repeat(32) }),
    // Nearly used up, but only a fallback, so it lists after the accounts assistants run on.
    [ROUTER]: snapshotFixture(ROUTER, 'openrouter', { windows: [window('API key quota', 95)], details: ['Credits balance: $12.00'] }),
    [CLAUDE]: snapshotFixture(CLAUDE, 'anthropic', { windows: [window('Current week', 85), window('Opus week', 99, 'model')] }),
    [PRIVATE]: snapshotFixture(PRIVATE, 'nous', { details: ['Top-up credits: $3.00'] }),
    ...options.usage,
  };
  const answer = <T,>(value: T | Error) => { if (value instanceof Error) throw value; return value; };
  const reset = vi.fn(async (_input: ExperienceRequest<'account_reset'>): Promise<ExperienceResult<'account_reset'>> =>
    ({ status: 'reset', message: 'Reset redeemed.', availableCount: 1, windowsReset: 2 }));
  const experience = experienceRequester({
    accounts: input => ({ accounts: answer(accounts[input.profile]) }),
    account_usage: input => answer(usage[input.key]),
    account_reset: input => reset(input),
  });
  const runtime = fakeRuntime({
    listBots: async () => [botFixture({ id: 'ranch', name: 'Ranch' }), botFixture({ id: 'garden', name: 'Garden' }), botFixture({ id: 'helper', name: 'Helper' }),
      botFixture({ id: 'private', name: 'Private', shared: false, ownerId: 'two' })],
    experienceRequest: experience,
  });
  const ask = vi.spyOn(runtime, 'experienceRequest');
  const app = Fastify(); apps.push(app);
  const store = new Store(':memory:'); app.addHook('onClose', async () => store.close());
  await app.register(cookie);
  const origin = 'https://usage.example.test';
  await installAuth(app, store, loadConfig({ NODE_ENV: 'production', APP_ORIGIN: origin, APP_DATABASE: ':memory:', GOOGLE_CLIENT_ID: 'fixture', HOUSEHOLD_EMAILS: 'one@example.test,two@example.test' }));
  app.setErrorHandler(errorHandler({ production: true }));
  await installAccountUsageRoutes(app, runtime, store, () => clock);
  const headers = signIn(store, origin, 'one', { email: 'one@example.test', csrf: 'csrf' });
  const owner = signIn(store, origin, 'two', { email: 'two@example.test', csrf: 'csrf-two' });
  const get = async (query = '', as = headers) => app.inject({ url: `/api/usage/accounts${query}`, headers: as });
  const redeem = (key: string, payload: unknown, as: Record<string, string> = headers) => app.inject({ url: `/api/usage/accounts/${key}/reset`, method: 'POST', headers: as, payload: payload as object });
  const usageCalls = () => ask.mock.calls.map(([input]) => input).filter((input): input is ExperienceRequest<'account_usage'> => input.operation === 'account_usage');
  return { app, ask, reset, get, redeem, usageCalls, headers, owner, usage, advance: (ms: number) => { clock += ms; } };
}

it('reads each shared account once and lists only the assistants this person can see', async () => {
  const s = await setup();
  const response = await s.get();
  expect(response.statusCode).toBe(200);
  const { accounts, unavailableBots } = response.json() as { accounts: UsageAccount[]; unavailableBots: string[] };
  // The second ChatGPT sign-in is the same account, so it joins the first card instead of making another.
  expect(accounts.map(row => [row.provider, row.botIds, row.fallbackOnly])).toEqual([
    ['openai-codex', ['ranch', 'garden', 'helper'], false],
    ['anthropic', ['helper'], false],
    ['openrouter', ['ranch'], true],
  ]);
  expect(unavailableBots).toEqual([]);
  // One read per credential, through the first visible assistant that uses it.
  expect(s.usageCalls()).toEqual(expect.arrayContaining([{ operation: 'account_usage', profile: 'ranch', key: CODEX }, { operation: 'account_usage', profile: 'helper', key: CLAUDE }]));
  expect(s.usageCalls().filter(input => input.key === CODEX)).toHaveLength(1);
  // Another person's personal assistant is never asked, and its account never appears.
  expect(s.ask).not.toHaveBeenCalledWith(expect.objectContaining({ profile: 'private' }));
  expect(JSON.stringify(accounts)).not.toContain(PRIVATE);
  expect(accounts[0]).not.toHaveProperty('identity');
  // Its owner sees it.
  const own = (await s.get('', s.owner)).json() as { accounts: UsageAccount[] };
  expect(own.accounts.find(row => row.provider === 'nous')?.botIds).toEqual(['private']);
});

it('orders accounts in use by how close they are to a limit, counting a model-only limit only when nothing else reports', async () => {
  const s = await setup({ accounts: { garden: [], helper: [{ key: CLAUDE, provider: 'anthropic', role: 'main' }], ranch: [{ key: ROUTER, provider: 'openrouter', role: 'main' }] },
    usage: { [ROUTER]: snapshotFixture(ROUTER, 'openrouter', { windows: [window('API key quota', 90)] }) } });
  // Claude's account-wide week is 85% used; its Opus week at 99% stops only Opus, so OpenRouter at 90% comes first.
  expect(((await s.get()).json() as { accounts: UsageAccount[] }).accounts.map(row => row.provider)).toEqual(['openrouter', 'anthropic']);
});

it('keeps answering when one assistant or one account cannot be read', async () => {
  const s = await setup({ accounts: { garden: httpError(502, 'Hermes could not complete this profile operation.') }, usage: { [CLAUDE]: httpError(502, 'Provider timed out') } });
  const body = (await s.get()).json() as { accounts: UsageAccount[]; unavailableBots: string[] };
  expect(body.unavailableBots).toEqual(['garden']);
  const claude = body.accounts.find(row => row.key === CLAUDE)!;
  expect(claude.unavailableReason).toBe("Hermes could not read this account's limits right now.");
  expect(claude.windows).toEqual([]);
});

it('explains that an add-on from before account usage needs the current release', async () => {
  const outdated = httpError(400, 'Unknown experience operation.');
  const s = await setup({ accounts: { ranch: outdated, garden: outdated, helper: outdated } });
  const response = await s.get();
  expect(response.statusCode).toBe(409);
  expect(response.json().error).toMatch(/newer WildBots add-on/);
});

it('answers from one read for a minute, and Refresh asks again only after 15 seconds', async () => {
  const s = await setup();
  await s.get();
  const reads = () => s.usageCalls().filter(input => input.key === CODEX).length;
  s.advance(USAGE_REFRESH_MS - 1);
  await s.get('?refresh=1');
  expect(reads()).toBe(1);
  s.advance(1);
  await s.get('?refresh=1');
  expect(reads()).toBe(2);
  s.advance(USAGE_KEPT_MS - 1);
  await s.get();
  expect(reads()).toBe(2);
  s.advance(1);
  await s.get();
  expect(reads()).toBe(3);
  expect((await s.get('?refresh=yes')).statusCode).toBe(400);
});

it('forgets a failed read so the next one tries again', async () => {
  const s = await setup({ usage: { [CLAUDE]: httpError(502, 'Provider timed out') } });
  await s.get();
  s.usage[CLAUDE] = snapshotFixture(CLAUDE, 'anthropic', { windows: [window('Current week', 10)] });
  const claude = ((await s.get()).json() as { accounts: UsageAccount[] }).accounts.find(row => row.key === CLAUDE)!;
  expect(claude.windows[0].usedPercent).toBe(10);
});

it('spends a ChatGPT reset only after the person confirms, and returns the account read again', async () => {
  const s = await setup();
  await s.get();
  s.usage[CODEX] = snapshotFixture(CODEX, 'openai-codex', { windows: [window('Weekly', 0)], bankedResets: 1 });
  const response = await s.redeem(CODEX, { confirmed: true, force: false });
  expect(response.statusCode).toBe(200);
  expect(s.reset).toHaveBeenCalledWith({ operation: 'account_reset', profile: 'ranch', key: CODEX, force: false });
  // The kept read from before the reset is dropped, so the answer shows the restored limit.
  expect(response.json()).toMatchObject({ status: 'reset', availableCount: 1, account: { key: CODEX, bankedResets: 1, windows: [{ usedPercent: 0 }], botIds: ['ranch', 'garden', 'helper'] } });
  await s.redeem(CODEX, { confirmed: true, force: true });
  expect(s.reset).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }));
});

it('refuses a reset without confirmation, for an account the person cannot see, or for a provider without resets', async () => {
  const s = await setup();
  const cases: [string, unknown, number, RegExp | string, Record<string, string>?][] = [
    [CODEX, { force: false }, 400, 'confirmed'],
    [CODEX, { confirmed: false, force: false }, 400, 'confirmed'],
    [CODEX, { confirmed: true }, 400, 'force'],
    [CODEX, { confirmed: true, force: false, extra: 1 }, 400, ''],
    ['not-a-key', { confirmed: true, force: false }, 400, 'key'],
    [PRIVATE, { confirmed: true, force: false }, 404, /None of your assistants/],
    [ROUTER, { confirmed: true, force: false }, 409, /Only ChatGPT/],
  ];
  for (const [key, payload, status, reason] of cases) {
    const response = await s.redeem(key, payload);
    expect(response.statusCode, JSON.stringify(payload)).toBe(status);
    const body = response.json();
    if (reason instanceof RegExp) expect(body.error).toMatch(reason);
    else expect(body.details.map((issue: { path: string[] }) => issue.path.join('.') || 'body')).toContain(reason || 'body');
  }
  // Without the page's CSRF token the request never reaches Hermes.
  expect((await s.redeem(CODEX, { confirmed: true, force: false }, { cookie: s.headers.cookie, origin: s.headers.origin })).statusCode).toBe(403);
  expect(s.reset).not.toHaveBeenCalled();
});

it('refuses a second reset while the first is still out', async () => {
  const s = await setup();
  let finish!: () => void;
  s.reset.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { status: 'reset', message: 'Done', availableCount: 0, windowsReset: 2 }; });
  const first = s.redeem(CODEX, { confirmed: true, force: false });
  await vi.waitFor(() => expect(s.reset).toHaveBeenCalledOnce());
  const second = await s.redeem(CODEX, { confirmed: true, force: false });
  expect(second.statusCode).toBe(409);
  expect(second.json().error).toMatch(/already in progress/);
  finish();
  expect((await first).statusCode).toBe(200);
  // Once the first settles, the account can be reset again.
  expect((await s.redeem(CODEX, { confirmed: true, force: false })).statusCode).toBe(200);
  expect(s.reset).toHaveBeenCalledTimes(2);
});

it('lets a failed reset be tried again', async () => {
  const s = await setup();
  s.reset.mockRejectedValueOnce(httpError(409, 'Hermes is being upgraded. Try the reset again in a minute.'));
  const response = await s.redeem(CODEX, { confirmed: true, force: false });
  expect(response.statusCode).toBe(409);
  expect(response.json().error).toMatch(/being upgraded/);
  expect((await s.redeem(CODEX, { confirmed: true, force: false })).statusCode).toBe(200);
});

it('requires sign-in', async () => {
  const s = await setup();
  expect((await s.app.inject('/api/usage/accounts')).statusCode).toBe(401);
  expect(s.ask).not.toHaveBeenCalled();
});
