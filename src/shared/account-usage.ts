/**
 * Subscription limits and credits for the provider accounts the household's assistants run on.
 * Hermes reads them from each provider (`agent/account_usage.py`) through the add-on; the app adds
 * which assistants share each account.
 */

/** One allowance, such as a 5-hour session or a weekly limit. */
export interface UsageWindow {
  label: string;
  /** 0 to 100, or null when the provider did not say. */
  usedPercent: number | null;
  resetsAt: string | null;
  detail: string | null;
  /** `model`: the limit stops one model family (Opus week), never the whole account. */
  scope: 'account' | 'model';
}

/** What the add-on reports for one provider account. */
export interface AccountSnapshot {
  /** One-way digest of the provider and the credential. Never the credential. */
  key: string;
  provider: string;
  plan: string | null;
  title: string;
  fetchedAt: string;
  windows: UsageWindow[];
  details: string[];
  unavailableReason: string | null;
  /** ChatGPT resets the person can spend to restore the session and weekly limits now. */
  bankedResets: number;
  /** One-way digest of the account Hermes identified, so two credentials for one account show once. */
  identity: string | null;
  /** A failed read worth trying again soon, rather than an answer to keep. */
  transient?: boolean;
}

/** An account as the app shows it: the snapshot, and the visible assistants that use it. */
export interface UsageAccount extends Omit<AccountSnapshot, 'identity' | 'transient'> {
  botIds: string[];
  /** Every assistant listed uses it only after its main provider fails. */
  fallbackOnly: boolean;
}

export interface AccountUsageOverview {
  accounts: UsageAccount[];
  /** Assistants whose accounts Hermes could not list. */
  unavailableBots: string[];
}

export type ResetStatus = 'reset' | 'nothing_to_reset' | 'no_credit' | 'already_redeemed' | 'not_exhausted' | 'no_credits_banked' | 'unavailable' | 'uncertain';

export interface ResetOutcome {
  status: ResetStatus;
  /** The add-on's fixed sentence for the status. Never Hermes's or the provider's words. */
  message: string;
  availableCount: number;
  windowsReset: number;
}

/** The account after a reset attempt, when Hermes could read it again. */
export interface ResetResult extends ResetOutcome { account?: UsageAccount }

/** The most-used limit that stops the whole account, else any limit; null when none reports a percentage. */
export function tightestWindow(account: Pick<UsageAccount, 'windows'>): UsageWindow | null {
  const known = account.windows.filter(window => window.usedPercent !== null);
  const pool = known.some(window => window.scope === 'account') ? known.filter(window => window.scope === 'account') : known;
  return pool.reduce<UsageWindow | null>((worst, window) => worst && worst.usedPercent! >= window.usedPercent! ? worst : window, null);
}

/** Bars warn at half used and alarm at 80% used, the cutoffs Hermes's own pickers use. */
export function usageLevel(usedPercent: number): 'ok' | 'warn' | 'alarm' {
  return usedPercent >= 80 ? 'alarm' : usedPercent >= 50 ? 'warn' : 'ok';
}

/** A reset restores the whole allowance, so one spent before any limit is used up wastes most of it. */
export function resetWouldBeWasted(account: Pick<UsageAccount, 'windows'>) {
  return !account.windows.some(window => window.scope === 'account' && (window.usedPercent ?? 0) >= 100);
}

const names: Record<string, string> = { 'openai-codex': 'ChatGPT', openai: 'OpenAI', anthropic: 'Claude', openrouter: 'OpenRouter', nous: 'Nous Portal',
  'opencode-zen': 'OpenCode Zen', google: 'Gemini', gemini: 'Gemini', xai: 'Grok' };
/** The account's name as people know it: ChatGPT for Hermes's `openai-codex` sign-in, else the slug in words. */
export function accountName(provider: string) {
  return names[provider] ?? provider.split(/[-_]/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
}

/** "Resets in 3 hr 20 min" within a day, else the weekday and time it resets. */
export function resetPhrase(resetsAt: string, now = Date.now(), locale?: string) {
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at)) return '';
  const minutes = Math.ceil((at - now) / 60_000);
  if (minutes <= 0) return 'Resets any moment';
  if (minutes < 60) return `Resets in ${minutes} min`;
  if (minutes < 24 * 60) return `Resets in ${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  return `Resets ${new Intl.DateTimeFormat(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(at)}`;
}

/** One line for the profile menu: the account closest to a limit, or nothing to report. */
export function usageSummary(accounts: UsageAccount[]) {
  const ranked = accounts.map(account => ({ account, window: tightestWindow(account) })).filter(row => row.window)
    .sort((a, b) => b.window!.usedPercent! - a.window!.usedPercent!);
  const top = ranked[0];
  return top ? `${accountName(top.account.provider)} · ${Math.round(top.window!.usedPercent!)}% of ${top.window!.label.toLowerCase()}` : null;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** What happened to a reset, in the app's words. Hermes's own words only where the app has none. */
export function resetOutcomeMessage(result: ResetOutcome) {
  switch (result.status) {
    case 'reset': return `Limits reset. ${plural(result.availableCount, 'banked reset')} left.`;
    case 'nothing_to_reset': return "Nothing needed resetting, so no reset was used.";
    case 'already_redeemed': return 'That reset was already used. No other reset was spent.';
    case 'no_credit': case 'no_credits_banked': return 'This account has no banked resets.';
    case 'not_exhausted': return 'Not reset: no limit is used up yet, so a reset would be wasted.';
    case 'unavailable': return "ChatGPT did not confirm the reset. Refresh to see whether it went through before trying again.";
    case 'uncertain': return "ChatGPT did not answer after the reset was sent. Try again: it goes as the same request, so it cannot spend a second reset.";
  }
}
