import type { Page } from "@playwright/test";
import { assistants, conversation, deployNextRelease, expect, signIn, test } from "./fixtures.js";

test("a member opens an assistant, sends a message, and the reply arrives without a reload", async ({ page }) => {
  await signIn(page);
  await expect(assistants(page).getByRole("button", { name: /Trail Cook/ })).toBeVisible();
  await assistants(page).getByRole("button", { name: /Ranch Hand/ }).click();
  await expect(conversation(page).getByText("Morning. The north fence is fixed.")).toBeVisible();

  // A marker on the window proves the page was never reloaded: the reply must come over the event stream.
  await page.evaluate(() => { (window as unknown as { sameDocument: boolean }).sameDocument = true; });
  await page.getByRole("textbox", { name: "Message Ranch Hand" }).fill("Is the gate latched?");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(conversation(page).getByText("Howdy, partner. You said: Is the gate latched?", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument)).toBe(true);
});

test("the app opens offline from the service worker, then recovers when the network returns", async ({ context, page, allowConsoleError }) => {
  // Chromium logs each request it refuses while the network is off. Nothing else is excused.
  allowConsoleError.push(/ERR_INTERNET_DISCONNECTED/);
  await signIn(page);
  await assistants(page).getByRole("button", { name: /Ranch Hand/ }).click();
  await expect(conversation(page).getByText("Morning. The north fence is fixed.")).toBeVisible();

  // The first visit has no worker. The worker claims the page once it installs, and a reload under its control
  // fetches whatever this screen lazily needs through it, which is what an offline reopen relies on.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.reload();
  await expect(conversation(page).getByText("Morning. The north fence is fixed.")).toBeVisible();

  // Losing the network mid-session keeps what is on screen and says so.
  await context.setOffline(true);
  await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
  await expect(conversation(page).getByText("Morning. The north fence is fixed.")).toBeVisible();

  // The app never stores API data, so a cold open offline cannot show the conversation. It must still open
  // the shell from the worker's cache and explain itself, not hand over the browser's error page.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your assistants, in one familiar place." })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Can't reach the app right now" })).toBeVisible();

  await context.setOffline(false);
  await expect(assistants(page).getByRole("button", { name: /Ranch Hand/ })).toBeVisible();
});

test("a member opens Usage from the profile menu and sees each account once", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Account" }).click();
  const menu = page.getByRole("menu", { name: "Account" });
  await expect(menu.getByRole("menuitem", { name: /Usage.*ChatGPT · 100% of session/ })).toBeVisible();
  await menu.getByRole("menuitem", { name: /Usage/ }).click();
  const dialog = page.getByRole("dialog", { name: "Usage" });
  const chatgpt = dialog.getByRole("article", { name: "ChatGPT" });
  await expect(chatgpt.getByRole("meter", { name: "Session" })).toHaveAttribute("aria-valuenow", "100");
  await expect(chatgpt.getByText("Used by Ranch Hand, Trail Cook")).toBeVisible();
  await expect(dialog.getByRole("article", { name: "OpenRouter" }).getByText("Fallback")).toBeVisible();
  // Using a reset always asks first; cancelling leaves the account as it was.
  await chatgpt.getByRole("button", { name: "Use a reset" }).click();
  await expect(page.getByRole("alertdialog", { name: "Use a banked reset?" })).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await expect(chatgpt.getByText("2 banked resets")).toBeVisible();
});

// The worker opens the shell from its cache, then checks the server's. After a deploy a person sees the
// old shell at most once: from the next load on, the old worker opens the network's shell, as it would
// with no cached copy, until the new release takes over.
const releaseMark = (page: Page) => page.locator('meta[name="release"]');
const shellNoted = (page: Page) => page.evaluate(async () => {
  for (const key of await caches.keys()) if (await (await caches.open(key)).match("/.shell-outdated")) return key;
  return null;
});

test("after a deploy, the next load opens the new shell, and the new release is offered until it is taken", async ({ page }) => {
  await signIn(page);
  await assistants(page).getByRole("button", { name: /Ranch Hand/ }).click();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const caches = () => page.evaluate(() => globalThis.caches.keys());
  const [current] = await caches();
  expect(current).toMatch(/^agent-interface-[0-9a-f]{16}$/);

  await deployNextRelease();
  // This load opens the cached shell, and the check behind it finds the new one.
  await page.reload();
  await expect(conversation(page).getByText("Morning. The north fence is fixed.")).toBeVisible();
  await expect(releaseMark(page)).toHaveCount(0);
  await expect.poll(() => shellNoted(page)).toBe(current);
  // The update check it ran installed the release, which waits for the person, as on main.
  await expect(page.getByRole("status").filter({ hasText: "Update available" })).toBeVisible();

  await page.reload();
  await expect(conversation(page).getByText("Morning. The north fence is fixed.")).toBeVisible();
  await expect(releaseMark(page)).toHaveCount(1);
  await expect(page.getByRole("status").filter({ hasText: "Update available" })).toBeVisible();

  // Taking it moves to the new worker, whose cache starts with no note. The page reloads meanwhile.
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect.poll(() => caches().catch(() => null)).toEqual([current.replace("agent-interface-", "agent-interface-next-")]);
  await expect(conversation(page).getByText("Morning. The north fence is fixed.")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Update available" })).toHaveCount(0);
  expect(await shellNoted(page)).toBeNull();
});

test("a new release whose worker cannot install still reaches the person on their next load", async ({ page }) => {
  await signIn(page);
  await assistants(page).getByRole("button", { name: /Ranch Hand/ }).click();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const [current] = await page.evaluate(() => globalThis.caches.keys());

  await deployNextRelease({ installs: false });
  await page.reload();
  await expect.poll(() => shellNoted(page)).toBe(current);
  await page.reload();
  await expect(releaseMark(page)).toHaveCount(1);
  await expect(conversation(page).getByText("Morning. The north fence is fixed.")).toBeVisible();
  // The old worker still serves, and nothing offers a release that never installed.
  expect(await page.evaluate(() => globalThis.caches.keys())).toEqual([current]);
  await expect(page.getByRole("status").filter({ hasText: "Update available" })).toHaveCount(0);
});

test("a notification tapped while the app is open switches its chat without reloading it", async ({ context, page }) => {
  await signIn(page);
  await assistants(page).getByRole("button", { name: /Ranch Hand/ }).click();
  await expect(conversation(page).getByText("Morning. The north fence is fixed.")).toBeVisible();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.evaluate(() => { (window as unknown as { sameDocument: boolean }).sameDocument = true; });

  // The worker's own tap handler, minus the notification: Playwright cannot click one.
  const [worker] = context.serviceWorkers();
  await worker.evaluate(() => (self as unknown as { openChat(url: string): Promise<void> }).openChat(`${location.origin}/?bot=trail`));
  await expect(page.getByRole("textbox", { name: "Message Trail Cook" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("bot")).toBe("trail");
  expect(await page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument)).toBe(true);
});
