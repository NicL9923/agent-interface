import { afterEach, describe, expect, it } from 'vitest';
import { accountName, resetOutcomeMessage, resetPhrase, resetWouldBeWasted, tightestWindow, usageLevel, usageSummary } from '../src/shared/account-usage.js';
import type { ResetStatus, UsageAccount, UsageWindow } from '../src/shared/account-usage.js';

const window = (label: string, usedPercent: number | null, scope: UsageWindow['scope'] = 'account'): UsageWindow => ({ label, usedPercent, resetsAt: null, detail: null, scope });
const account = (provider: string, windows: UsageWindow[]): UsageAccount => ({ key: 'a'.repeat(32), provider, plan: null, title: 'Account limits', fetchedAt: '2026-11-08T12:00:00Z',
  windows, details: [], unavailableReason: null, bankedResets: 0, botIds: [], fallbackOnly: false });

describe('resetPhrase', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  const zone = process.env.TZ;
  afterEach(() => { process.env.TZ = zone; });
  it.each([
    ['2026-11-08T12:00:00Z', 'Resets any moment'],
    ['2026-11-08T11:00:00Z', 'Resets any moment'],
    ['2026-11-08T12:59:00Z', 'Resets in 59 min'],
    ['2026-11-08T13:00:00Z', 'Resets in 1 hr'],
    ['2026-11-08T15:20:00Z', 'Resets in 3 hr 20 min'],
    ['2026-11-09T11:59:00Z', 'Resets in 23 hr 59 min'],
    ['not a date', ''],
  ])('reads %s as "%s"', (at, phrase) => expect(resetPhrase(at, now)).toBe(phrase));
  it('names the weekday and local time from a day out, in the local time zone', () => {
    // Tokyo is east of UTC, so this reset falls on the next local day; a UTC-only reading would say Tuesday.
    process.env.TZ = 'Asia/Tokyo';
    expect(resetPhrase('2026-11-10T15:00:00Z', now, 'en-US')).toBe('Resets Wed 12:00 AM');
    expect(resetPhrase('2026-11-09T12:00:00Z', now, 'en-US')).toBe('Resets Mon 9:00 PM');
  });
});

describe('tightestWindow and usageSummary', () => {
  it('prefers a limit that stops the whole account over a busier one that stops a single model', () => {
    const claude = account('anthropic', [window('Current week', 40), window('Opus week', 99, 'model'), window('Session', null)]);
    expect(tightestWindow(claude)?.label).toBe('Current week');
    expect(tightestWindow(account('anthropic', [window('Opus week', 99, 'model')]))?.label).toBe('Opus week');
    expect(tightestWindow(account('openrouter', [window('Quota', null)]))).toBeNull();
  });
  it('summarizes the account closest to a limit across accounts, and nothing when none reports one', () => {
    const summary = usageSummary([account('openrouter', [window('API key quota', 30)]), account('openai-codex', [window('Weekly', 82.4)]), account('custom', [])]);
    expect(summary).toBe('ChatGPT · 82% of weekly');
    expect(usageSummary([account('custom', [])])).toBeNull();
  });
});

it('warns from half used and alarms from 80% used', () => {
  expect([0, 49.9, 50, 79.9, 80, 100].map(usageLevel)).toEqual(['ok', 'ok', 'warn', 'warn', 'alarm', 'alarm']);
});

it('calls a reset wasted until a limit that stops the whole account is used up', () => {
  expect(resetWouldBeWasted(account('openai-codex', [window('Session', 99.9), window('Weekly', 20)]))).toBe(true);
  expect(resetWouldBeWasted(account('openai-codex', [window('Opus week', 100, 'model')]))).toBe(true);
  expect(resetWouldBeWasted(account('openai-codex', [window('Session', 100), window('Weekly', null)]))).toBe(false);
});

it('names accounts as people know them and spells out an unknown slug', () => {
  expect(['openai-codex', 'anthropic', 'nous', 'my_custom-endpoint'].map(accountName)).toEqual(['ChatGPT', 'Claude', 'Nous Portal', 'My Custom Endpoint']);
});

it('words every reset outcome in the app\'s own words', () => {
  const message = (status: ResetStatus, availableCount = 0, text = 'Codex backend error (HTTP 500)') => resetOutcomeMessage({ status, message: text, availableCount, windowsReset: 0 });
  expect(message('reset', 1)).toBe('Limits reset. 1 banked reset left.');
  expect(message('reset', 0)).toBe('Limits reset. 0 banked resets left.');
  // A count ChatGPT could not be asked for is left out, never shown as zero.
  expect(resetOutcomeMessage({ status: 'reset', message: '', availableCount: null, windowsReset: 2 })).toBe('Limits reset.');
  expect(message('nothing_to_reset')).toMatch(/no reset was used/);
  expect(message('already_redeemed')).toMatch(/No other reset was spent/);
  expect(message('no_credit')).toBe('This account has no banked resets.');
  expect(message('no_credits_banked')).toBe('This account has no banked resets.');
  expect(message('not_exhausted')).toMatch(/would be wasted/);
  // The add-on's sentence is fixed per status; the app's own copy never repeats it, so a provider body cannot reach the page.
  expect(message('unavailable', 0, "Unexpected response: {'account_id': 'private'}")).toMatch(/did not confirm the reset/);
  expect(message('uncertain')).toMatch(/cannot spend a second reset/);
});
