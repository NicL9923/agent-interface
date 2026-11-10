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

test("an open tab is offered a new release, and its next load reaches it without the offer being taken", async ({ page }) => {
  await signIn(page);
  await assistants(page).getByRole("button", { name: /Ranch Hand/ }).click();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const caches = () => page.evaluate(() => globalThis.caches.keys());
  const [current] = await caches();
  expect(current).toMatch(/^agent-interface-[0-9a-f]{16}$/);

  // The tab's own update check, as its timer or a return to the tab runs it, finds and installs the release.
  await deployNextRelease();
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
  await expect(page.getByRole("status").filter({ hasText: "Update available" })).toBeVisible();

  // The person reloads without tapping Refresh. That load finds the release waiting and moves to it.
  await page.reload();
  await expect(conversation(page).getByText("Morning. The north fence is fixed.")).toBeVisible();
  await expect.poll(caches).toEqual([current.replace("agent-interface-", "agent-interface-next-")]);
  await expect(page.getByRole("status").filter({ hasText: "Update available" })).toHaveCount(0);
});
