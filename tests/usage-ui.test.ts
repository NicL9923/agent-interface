// @vitest-environment jsdom
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError, api, write } from '../src/client-api';
import { AccountMenu } from '../src/app/AccountMenu';
import { UsagePanel } from '../src/components/UsagePanel';
import type { AccountUsageOverview, UsageAccount, UsageWindow } from '../src/shared/account-usage';
import type { Bot } from '../src/shared/types';
import { click, mountRoot } from './ui-harness';

vi.mock('../src/client-api', async original => (await import('./helpers/request-mock')).withRequest({ ...await original<typeof import('../src/client-api')>(), api: vi.fn(), write: vi.fn() }));

const CODEX = 'c'.repeat(32), ROUTER = 'b'.repeat(32);
const window = (label: string, usedPercent: number | null, changes: Partial<UsageWindow> = {}): UsageWindow => ({ label, usedPercent, resetsAt: null, detail: null, scope: 'account', ...changes });
const account = (changes: Partial<UsageAccount>): UsageAccount => ({ key: CODEX, provider: 'openai-codex', plan: 'Pro', title: 'Account limits', fetchedAt: '2026-11-08T11:58:00Z',
  windows: [], details: [], unavailableReason: null, bankedResets: 0, botIds: ['ranch'], fallbackOnly: false, ...changes });
const bots = [{ id: 'ranch', name: 'Ranch' }, { id: 'garden', name: 'Garden' }] as Bot[];
let overview: AccountUsageOverview;
let root: Root, container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  overview = { unavailableBots: [], accounts: [
    account({ windows: [window('Session', 100, { resetsAt: '2026-11-08T15:20:00Z' }), window('Weekly', 62.5)], details: ['Credits balance: $4.00'], bankedResets: 2,
      botIds: ['ranch', 'garden', 'gone'] }),
    account({ key: ROUTER, provider: 'openrouter', plan: null, fallbackOnly: true, windows: [window('API key quota', null, { detail: '$15.00 of $20.00 remaining' })] }),
  ] };
  vi.mocked(api).mockReset().mockImplementation(async () => overview);
  vi.mocked(write).mockReset();
  ({ root, container } = mountRoot());
});
afterEach(() => { vi.useRealTimers(); });

const panel = () => act(async () => root.render(createElement(UsagePanel, { bots, onClose: () => {} })));
const card = (name: string) => container.querySelector<HTMLElement>(`article[aria-label="${name}"]`)!;
const meter = (scope: ParentNode, label: string) => scope.querySelector(`[role="meter"][aria-label="${label}"]`);

it('opens the profile menu with how close the nearest account is to a limit, and routes each item', async () => {
  const handlers = { onUsage: vi.fn(), onSettings: vi.fn(), onSignOut: vi.fn() };
  await act(async () => root.render(createElement(AccountMenu, { user: { id: 'one', name: 'Nic Layne', email: 'nic@example.test' }, status: 'connected', ...handlers })));
  // Nothing is read until the menu opens.
  expect(api).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Account"]')!.click());
  expect(api).toHaveBeenCalledWith('/usage/accounts', expect.anything());
  const menu = container.querySelector('[role="menu"]')!;
  expect(menu.textContent).toContain('nic@example.test');
  expect(menu.textContent).toContain('ChatGPT · 100% of session');
  await act(async () => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent?.startsWith('Usage'))!.click());
  expect(handlers.onUsage).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="menu"]')).toBeNull();
  // Focus is back on the avatar before Usage opens, so closing Usage returns there.
  expect(document.activeElement).toBe(container.querySelector('[aria-label="Account"]'));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Account"]')!.click());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'Sign out')!.click());
  expect(handlers.onSignOut).toHaveBeenCalledOnce();
  expect(handlers.onSettings).not.toHaveBeenCalled();
});

it('keeps a plain description in the menu when the accounts cannot be read', async () => {
  vi.mocked(api).mockRejectedValue(new ApiError('Hermes is offline', 502));
  await act(async () => root.render(createElement(AccountMenu, { user: { id: 'one', name: 'One', email: 'one@example.test' }, status: 'offline', onUsage() {}, onSettings() {}, onSignOut() {} })));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Account"]')!.click());
  expect(container.querySelector('[role="menu"]')!.textContent).toContain('Plans, limits and credits');
});

it('shows each account with its limits, resets, credits and the assistants that use it', async () => {
  overview.unavailableBots = ['garden'];
  await panel();
  const chatgpt = card('ChatGPT');
  expect(chatgpt.textContent).toContain('Pro');
  expect(meter(chatgpt, 'Session')?.getAttribute('aria-valuenow')).toBe('100');
  expect(chatgpt.querySelector('[data-level="alarm"]')?.textContent).toContain('Resets in 3 hr 20 min');
  expect(chatgpt.querySelector('[data-level="warn"]')?.textContent).toContain('63% used');
  expect(chatgpt.textContent).toContain('Credits balance: $4.00');
  expect(chatgpt.textContent).toContain('2 banked resets');
  // An assistant this page does not know is left out rather than shown as an id.
  expect(chatgpt.textContent).toContain('Used by Ranch, Garden');
  expect(chatgpt.textContent).not.toContain('gone');
  const router = card('OpenRouter');
  expect(router.textContent).toContain('Fallback');
  expect(router.textContent).toContain('Not reported');
  expect(router.textContent).toContain('$15.00 of $20.00 remaining');
  expect(meter(router, 'API key quota')).toBeNull();
  expect(router.querySelector('button')).toBeNull();
  expect(container.textContent).toContain('Usage unavailable for 1 assistant.');
});

it('says so when no assistant uses an account that reports limits', async () => {
  overview = { accounts: [], unavailableBots: [] };
  await panel();
  expect(container.textContent).toContain('None of your assistants uses an account that reports limits yet.');
});

it('asks the server to read the accounts again on Refresh', async () => {
  await panel();
  vi.mocked(api).mockImplementation(async () => ({ ...overview, accounts: [account({ windows: [window('Session', 5)] })] }));
  await click('Refresh');
  expect(api).toHaveBeenLastCalledWith('/usage/accounts?refresh=1');
  expect(meter(card('ChatGPT'), 'Session')?.getAttribute('aria-valuenow')).toBe('5');
  expect(card('OpenRouter')).toBeNull();
});

it('spends a reset on a used-up account only after confirming, then shows the account read again', async () => {
  vi.mocked(write).mockResolvedValue({ status: 'reset', message: 'Done', availableCount: 1, windowsReset: 2, account: account({ windows: [window('Session', 0)], bankedResets: 1 }) });
  await panel();
  await click('Use a reset', card('ChatGPT'));
  const dialog = container.querySelector('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain('Use a banked reset?');
  expect(dialog.textContent).toContain("You'll have 1 reset left.");
  expect(write).not.toHaveBeenCalled();
  await click('Use reset', dialog);
  expect(write).toHaveBeenCalledWith(`/usage/accounts/${CODEX}/reset`, { confirmed: true, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), force: false });
  expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  expect(card('ChatGPT').textContent).toContain('Limits reset. 1 banked reset left.');
  expect(meter(card('ChatGPT'), 'Session')?.getAttribute('aria-valuenow')).toBe('0');
});

it('warns that an early reset is wasted, and sends force only when the person goes ahead anyway', async () => {
  overview.accounts[0] = account({ windows: [window('Session', 99), window('Opus week', 100, { scope: 'model' })], bankedResets: 1 });
  vi.mocked(write).mockResolvedValue({ status: 'reset', message: 'Done', availableCount: 0, windowsReset: 2 });
  await panel();
  await click('Use a reset', card('ChatGPT'));
  expect(container.querySelector('[role="alertdialog"]')!.textContent).toContain('Use a reset early?');
  await click('Cancel', container.querySelector('[role="alertdialog"]')!);
  expect(write).not.toHaveBeenCalled();
  await click('Use a reset', card('ChatGPT'));
  await click('Use reset anyway', container.querySelector('[role="alertdialog"]')!);
  expect(write).toHaveBeenCalledWith(`/usage/accounts/${CODEX}/reset`, { confirmed: true, requestId: expect.any(String), force: true });
  // Without a fresh account in the answer, the page reads the accounts again.
  expect(api).toHaveBeenCalledTimes(2);
});

it('keeps the request when ChatGPT\'s answer was lost, so trying again cannot spend twice', async () => {
  vi.mocked(write).mockResolvedValueOnce({ status: 'uncertain', message: '', availableCount: 0, windowsReset: 0 })
    .mockResolvedValueOnce({ status: 'already_redeemed', message: '', availableCount: 1, windowsReset: 0 });
  await panel();
  await click('Use a reset', card('ChatGPT'));
  await click('Use reset', container.querySelector('[role="alertdialog"]')!);
  expect(card('ChatGPT').textContent).toContain('cannot spend a second reset');
  await click('Use a reset', card('ChatGPT'));
  await click('Use reset', container.querySelector('[role="alertdialog"]')!);
  const ids = vi.mocked(write).mock.calls.map(([, body]) => (body as { requestId: string }).requestId);
  expect(ids[1]).toBe(ids[0]);
});

it('closes the question and says why when a reset fails, and retries it as the same reset', async () => {
  vi.mocked(write).mockRejectedValueOnce(new ApiError('A reset for this account is already in progress.', 409))
    .mockResolvedValueOnce({ status: 'reset', message: 'Done', availableCount: 1, windowsReset: 2 }).mockResolvedValueOnce({ status: 'reset', message: 'Done', availableCount: 0, windowsReset: 2 });
  await panel();
  await click('Use a reset', card('ChatGPT'));
  await click('Use reset', container.querySelector('[role="alertdialog"]')!);
  expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  expect(card('ChatGPT').querySelector('[role="alert"]')?.textContent).toBe('A reset for this account is already in progress.');
  await click('Use a reset', card('ChatGPT'));
  await click('Use reset', container.querySelector('[role="alertdialog"]')!);
  // The retry may be the same spend whose answer was lost, so it carries the same request ID.
  const ids = vi.mocked(write).mock.calls.map(([, body]) => (body as { requestId: string }).requestId);
  expect(ids[1]).toBe(ids[0]);
  // A reset that went through is done; the next one is a new request.
  await click('Use a reset', card('ChatGPT'));
  await click('Use reset', container.querySelector('[role="alertdialog"]')!);
  expect(vi.mocked(write).mock.calls.map(([, body]) => (body as { requestId: string }).requestId)[2]).not.toBe(ids[0]);
});
