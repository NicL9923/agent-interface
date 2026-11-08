import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { apiRoute } from './api-route.js';
import { signedIn } from './auth.js';
import { visibleBots } from './bot-access.js';
import { mapLimit } from './concurrency.js';
import { httpError } from './http-error.js';
import type { Store } from './store.js';
import type { Runtime } from '../shared/types.js';
import type { ExperienceResult } from '../shared/experience.js';
import type { AccountSnapshot, UsageAccount } from '../shared/account-usage.js';
import { tightestWindow } from '../shared/account-usage.js';

/** Limits move in minutes, and every read asks the provider, so one answer serves everyone for a minute. */
export const USAGE_KEPT_MS = 60_000;
/** Refresh may ask again sooner, but not more often than this, however many people press it. */
export const USAGE_REFRESH_MS = 15_000;
const CHATGPT = 'openai-codex';
const accountKey = z.string().regex(/^[0-9a-f]{32}$/);
type Listed = ExperienceResult<'accounts'>['accounts'][number];
type Kept<T> = { at: number; value: Promise<T> };
type Group = { key: string; provider: string; profile: string; botIds: string[]; main: boolean };

/**
 * Plan limits and credits for the accounts behind the assistants a person can see.
 *
 * Each profile lists its accounts without the network; profiles that share a credential share an account
 * key, so each account is read from its provider once, through the first visible profile that uses it.
 * Another person's personal assistant is never asked, so it never appears among an account's users.
 */
export async function installAccountUsageRoutes(app: FastifyInstance, runtime: Runtime, store: Store, now = () => Date.now()) {
  const lists = new Map<string, Kept<Listed[]>>();
  const snapshots = new Map<string, Kept<AccountSnapshot>>();
  const redeeming = new Set<string>();
  function experience() {
    if (!runtime.experienceRequest) throw httpError(409, 'Account usage needs the current qualified Hermes integration.');
    return runtime.experienceRequest.bind(runtime);
  }
  // Callers at the same moment share one read. A failed read is forgotten so the next one tries again.
  function kept<T>(map: Map<string, Kept<T>>, key: string, maxAge: number, load: () => Promise<T>) {
    const hit = map.get(key);
    if (hit && now() - hit.at < maxAge) return hit.value;
    const value = load();
    map.set(key, { at: now(), value });
    value.catch(() => { if (map.get(key)?.value === value) map.delete(key); });
    return value;
  }
  async function groups(userId: string, maxAge: number) {
    const ask = experience();
    const bots = await visibleBots(runtime, store, userId);
    const failures: unknown[] = [];
    const listed = await mapLimit(bots, 4, async bot => {
      try { return { bot, rows: await kept(lists, bot.id, maxAge, async () => (await ask({ operation: 'accounts', profile: bot.id })).accounts) }; }
      catch (error) { failures.push(error); return { bot, rows: [] as Listed[], failed: true }; }
    });
    // An add-on from before account usage refuses the operation for every assistant alike.
    if (bots.length && failures.length === bots.length && failures.every(error => error instanceof Error && error.message === 'Unknown experience operation.'))
      throw httpError(409, 'Account usage needs a newer WildBots add-on in Hermes. Activate the current release.');
    const found = new Map<string, Group>();
    for (const { bot, rows } of listed) for (const row of rows) {
      const group = found.get(row.key) ?? { key: row.key, provider: row.provider, profile: bot.id, botIds: [], main: false };
      if (!group.botIds.includes(bot.id)) group.botIds.push(bot.id);
      group.main ||= row.role === 'main';
      found.set(row.key, group);
    }
    return { groups: [...found.values()], unavailableBots: listed.filter(row => 'failed' in row).map(row => row.bot.id) };
  }
  async function snapshot(group: Group, maxAge: number): Promise<AccountSnapshot> {
    try { return await kept(snapshots, group.key, maxAge, () => experience()({ operation: 'account_usage', profile: group.profile, key: group.key })); }
    catch {
      return { key: group.key, provider: group.provider, plan: null, title: 'Account limits', fetchedAt: new Date(now()).toISOString(), windows: [], details: [],
        unavailableReason: "Hermes could not read this account's limits right now.", bankedResets: 0, identity: null };
    }
  }
  const account = ({ identity: _identity, ...snapshot }: AccountSnapshot, group: Group): UsageAccount =>
    ({ ...snapshot, botIds: group.botIds, fallbackOnly: !group.main });

  apiRoute(app, 'GET /usage/accounts', {}, async req => {
    const { refresh } = z.object({ refresh: z.literal('1').optional() }).strict().parse(req.query);
    const maxAge = refresh ? USAGE_REFRESH_MS : USAGE_KEPT_MS;
    const { groups: found, unavailableBots } = await groups(signedIn(req).id, maxAge);
    const read = await mapLimit(found, 4, async group => ({ group, snapshot: await snapshot(group, maxAge) }));
    // Two credentials Hermes identifies as one account, such as two ChatGPT sign-ins, show once.
    const merged = new Map<string, { group: Group; snapshot: AccountSnapshot }>();
    for (const entry of read) {
      const same = entry.snapshot.identity ? merged.get(entry.snapshot.identity) : undefined;
      if (!same) { merged.set(entry.snapshot.identity ?? `key:${entry.group.key}`, { ...entry, group: { ...entry.group } }); continue; }
      for (const botId of entry.group.botIds) if (!same.group.botIds.includes(botId)) same.group.botIds.push(botId);
      same.group.main ||= entry.group.main;
    }
    const used = (row: UsageAccount) => tightestWindow(row)?.usedPercent ?? -1;
    const accounts = [...merged.values()].map(entry => account(entry.snapshot, entry.group))
      .sort((a, b) => Number(a.fallbackOnly) - Number(b.fallbackOnly) || used(b) - used(a) || a.provider.localeCompare(b.provider));
    return { accounts, unavailableBots };
  });

  apiRoute(app, 'POST /usage/accounts/:key/reset', { body: z.object({ confirmed: z.literal(true), force: z.boolean() }).strict() }, async (req, { force }) => {
    const { key } = z.object({ key: accountKey }).parse(req.params);
    const { groups: found } = await groups(signedIn(req).id, USAGE_KEPT_MS);
    const group = found.find(row => row.key === key);
    if (!group) throw httpError(404, 'None of your assistants uses that account.');
    if (group.provider !== CHATGPT) throw httpError(409, 'Only ChatGPT accounts have banked resets.');
    // A second press while the first is still out would spend a second reset.
    if (redeeming.has(key)) throw httpError(409, 'A reset for this account is already in progress.');
    redeeming.add(key);
    let outcome: ExperienceResult<'account_reset'>;
    try { outcome = await experience()({ operation: 'account_reset', profile: group.profile, key, force }); }
    finally { redeeming.delete(key); snapshots.delete(key); }
    const fresh = await snapshot(group, USAGE_KEPT_MS);
    return { ...outcome, ...(fresh.unavailableReason && !fresh.windows.length ? {} : { account: account(fresh, group) }) };
  });
}
