import { assistants, conversation, expect, signIn, test } from "./fixtures.js";

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
