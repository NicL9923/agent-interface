import type { BrowserContext, Page } from "@playwright/test";
import { assistants, conversation, expect, signIn, test } from "./fixtures.js";

/**
 * On a phone one step in from home, a chat, Today, Search or a sheet over home, is one history entry, so the
 * system Back gesture and the browser's Back button take the on-screen Back's step instead of leaving the
 * app. A two-pane layout gains no entries. See src/app/history-nav.ts.
 */
const phone = { width: 390, height: 844 }, desktop = { width: 1280, height: 800 };
const row = (page: Page, name: RegExp) => assistants(page).getByRole("button", { name });
const ranchRow = (page: Page) => row(page, /Ranch Hand/);
const leaves = async (page: Page) => { await page.goBack(); expect(page.url()).toBe("about:blank"); };
// The worker's own tap handler, minus the notification: Playwright cannot click one.
const tapNotification = async (context: BrowserContext, page: Page, url: string) => {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const [worker] = context.serviceWorkers();
  await worker.evaluate(address => (self as unknown as { openChat(notification: { data: { url: string } }): Promise<void> }).openChat({ data: { url: address } }), url);
};
/** Signs the account out from a second tab, which signs out every tab of the profile. */
async function signOutElsewhere(context: BrowserContext) {
  const other = await context.newPage();
  await other.goto("/");
  await other.getByRole("button", { name: "Account" }).click();
  await other.getByRole("menu", { name: "Account" }).getByRole("menuitem", { name: "Sign out" }).click();
  await other.getByRole("alertdialog", { name: "Sign out?" }).getByRole("button", { name: "Sign out" }).click();
  await expect(other.getByRole("button", { name: "Enter local workspace" })).toBeVisible();
  await other.close();
}
/** A fresh tab, so the entry before the app is about:blank and Back out of the app is visible. */
async function signedInTab(context: BrowserContext, path = "/") {
  const first = await context.newPage();
  await signIn(first);
  await first.close();
  const page = await context.newPage();
  await page.goto(path);
  return page;
}

test.describe("on a phone", () => {
  test.use({ viewport: phone, isMobile: true, hasTouch: true });

  test("Back from a chat shows home with that chat's row focused, and a second Back leaves the app", async ({ page }) => {
    await page.goto("about:blank");
    await signIn(page);
    await ranchRow(page).click();
    await expect(conversation(page).getByText("Morning. The north fence is fixed.")).toBeVisible();
    await page.goBack();
    await expect(assistants(page)).toBeVisible();
    await expect(ranchRow(page)).toBeFocused();
    await expect(page.locator("main.conversation-panel")).toHaveJSProperty("inert", true);
    await leaves(page);
  });

  test("a chat opened again after Back takes the same two steps, with no entries left over", async ({ page }) => {
    await page.goto("about:blank");
    await signIn(page);
    await ranchRow(page).click();
    await expect(page.getByRole("textbox", { name: "Message Ranch Hand" })).toBeVisible();
    const length = await page.evaluate(() => history.length);
    await page.goBack();
    await row(page, /Trail Cook/).click();
    await expect(page.getByRole("textbox", { name: "Message Trail Cook" })).toBeVisible();
    // Opening it pushed one entry over the one Back landed on, which dropped Ranch Hand's.
    expect(await page.evaluate(() => history.length)).toBe(length);
    await page.goBack();
    await expect(row(page, /Trail Cook/)).toBeFocused();
    await leaves(page);
  });

  test("the on-screen Back leaves no entry behind for the system Back to trip on", async ({ page }) => {
    await page.goto("about:blank");
    await signIn(page);
    await ranchRow(page).click();
    await page.getByRole("button", { name: "Back to assistants" }).click();
    await expect(ranchRow(page)).toBeFocused();
    await expect.poll(() => page.evaluate(() => history.state?.wbDepth)).toBe(0);
    await leaves(page);
  });

  for (const [name, open, shown] of [
    ["Today", (page: Page) => page.getByRole("button", { name: "Today" }), (page: Page) => page.getByRole("heading", { name: /Today/ }).first()],
    ["Search", (page: Page) => page.getByRole("button", { name: "Search & saved" }), (page: Page) => page.getByRole("searchbox").first()],
  ] as const) {
    test(`Back from ${name} shows home, and a second Back leaves the app`, async ({ page }) => {
      await page.goto("about:blank");
      await signIn(page);
      await open(page).click();
      await expect(shown(page)).toBeVisible();
      await page.goBack();
      await expect(assistants(page)).toBeVisible();
      await expect(page.locator("main.conversation-panel")).toHaveJSProperty("inert", true);
      await leaves(page);
    });
  }

  test("a link that names a chat lands on it, Back goes home, and a second Back leaves", async ({ context }) => {
    const page = await signedInTab(context, "/?bot=ranch&message=seed-1");
    await expect(conversation(page).getByText("Morning. The north fence is fixed.")).toBeVisible();
    await page.goBack();
    await expect(assistants(page)).toBeVisible();
    await expect(ranchRow(page)).toBeFocused();
    await leaves(page);
  });

  test("a link that names Today lands on it, and Back goes home", async ({ context }) => {
    const page = await signedInTab(context, "/?view=today");
    await expect(page.getByRole("heading", { name: /Today/ }).first()).toBeVisible();
    await page.goBack();
    await expect(assistants(page)).toBeVisible();
    await leaves(page);
  });

  test("a notification tapped on the home list opens its chat in place, and Back goes home", async ({ context }) => {
    const page = await signedInTab(context);
    await expect(assistants(page)).toBeVisible();
    await tapNotification(context, page, "/?bot=trail");
    await expect(page.getByRole("textbox", { name: "Message Trail Cook" })).toBeVisible();
    await page.goBack();
    await expect(assistants(page)).toBeVisible();
    await expect(row(page, /Trail Cook/)).toBeFocused();
    await leaves(page);
  });

  test("a notification tapped inside a chat switches chats without another entry", async ({ context }) => {
    const page = await signedInTab(context);
    await ranchRow(page).click();
    await expect(page.getByRole("textbox", { name: "Message Ranch Hand" })).toBeVisible();
    const length = await page.evaluate(() => history.length);
    await tapNotification(context, page, "/?bot=trail");
    await expect(page.getByRole("textbox", { name: "Message Trail Cook" })).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(length);
    expect(new URL(page.url()).searchParams.get("bot")).toBe("trail");
    await page.goBack();
    await expect(row(page, /Trail Cook/)).toBeFocused();
    await leaves(page);
  });

  test("after a reload inside a chat, Back still shows home rather than the chat again", async ({ page }) => {
    await page.goto("about:blank");
    await signIn(page);
    await ranchRow(page).click();
    await expect(page.getByRole("textbox", { name: "Message Ranch Hand" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message Ranch Hand" })).toBeVisible();
    await page.goBack();
    await expect(assistants(page)).toBeVisible();
    await expect(page.locator("main.conversation-panel")).toHaveJSProperty("inert", true);
    await leaves(page);
  });

  test("Back closes a sheet over home, then the next Back leaves", async ({ page }) => {
    await page.goto("about:blank");
    await signIn(page);
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("menu", { name: "Account" }).getByRole("menuitem", { name: /Usage/ }).click();
    await expect(page.getByRole("dialog", { name: /Usage/ })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("dialog", { name: /Usage/ })).toBeHidden();
    await expect(assistants(page)).toBeVisible();
    await leaves(page);
  });

  test("Back closes a sheet over a chat and stays in the chat, then the next Back goes home", async ({ page }) => {
    await page.goto("about:blank");
    await signIn(page);
    await ranchRow(page).click();
    await page.locator(".chat-identity").click();
    const details = page.getByRole("dialog").first();
    await expect(details).toBeVisible();
    await page.goBack();
    await expect(details).toBeHidden();
    await expect(page.getByRole("textbox", { name: "Message Ranch Hand" })).toBeVisible();
    await page.goBack();
    await expect(ranchRow(page)).toBeFocused();
    await leaves(page);
  });

  test("Back on an edited sheet asks first and keeps it open until told to discard, then the next Back leaves", async ({ page }) => {
    await page.goto("about:blank");
    await signIn(page);
    await page.getByRole("button", { name: /^New( assistant)?$/ }).click();
    const menu = page.getByRole("menu", { name: "New" });
    if (await menu.isVisible()) await menu.getByRole("menuitem", { name: "New assistant" }).click();
    const sheet = page.getByRole("dialog");
    const field = sheet.getByRole("textbox", { name: "Name" });
    await field.fill("Ridge Rider");
    await page.goBack();
    const question = sheet.getByRole("alert").filter({ hasText: "Discard your unsaved changes?" });
    await expect(question).toBeVisible();
    await sheet.getByRole("button", { name: "Keep editing" }).click();
    await expect(field).toHaveValue("Ridge Rider");
    // The question took Back's step, and Back is armed again, so it asks again rather than leaving.
    await page.goBack();
    await expect(question).toBeVisible();
    await sheet.getByRole("button", { name: "Discard changes" }).click();
    await expect(sheet).toBeHidden();
    await expect(assistants(page)).toBeVisible();
    await leaves(page);
  });

  test("a sign-out in another tab while a chat is open leaves nothing for Back to land on, so one Back leaves the app", async ({ context, page }) => {
    await page.goto("about:blank");
    await signIn(page);
    await ranchRow(page).click();
    await expect(page.getByRole("textbox", { name: "Message Ranch Hand" })).toBeVisible();
    await signOutElsewhere(context);
    await expect(page.getByRole("button", { name: "Enter local workspace" })).toBeVisible();
    // The chat's entry is popped and the home entry under it no longer names the chat of the account that left.
    await expect.poll(() => page.evaluate(() => history.state?.wbDepth ?? 0)).toBe(0);
    expect(new URL(page.url()).search).toBe("");
    await leaves(page);
  });

  test("a group chat form with a name and an assistant asks before Back discards it", async ({ page }) => {
    // The e2e server hosts no group coordinator, so its catalog is the one thing scripted: at the network edge.
    await page.route(/\/api\/groups(\?.*)?$/, route => route.request().method() === "GET"
      ? route.fulfill({ json: { supported: true, canSend: true, rooms: [] } }) : route.fallback());
    await page.goto("about:blank");
    await signIn(page);
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "New group chat" }).click();
    const sheet = page.getByRole("dialog", { name: "New group chat" });
    await sheet.getByRole("textbox", { name: "Name" }).fill("Fence crew");
    await sheet.getByRole("checkbox", { name: /Ranch Hand/ }).check();
    await page.goBack();
    const question = sheet.getByRole("alert").filter({ hasText: "Discard your unsaved changes?" });
    await expect(question).toBeVisible();
    await expect(sheet.getByRole("textbox", { name: "Name" })).toHaveValue("Fence crew");
    await expect(sheet.getByRole("checkbox", { name: /Ranch Hand/ })).toBeChecked();
    await sheet.getByRole("button", { name: "Keep editing" }).click();
    await expect(sheet.getByRole("textbox", { name: "Name" })).toHaveValue("Fence crew");
    // The question took Back's step, and Back is armed again, so it asks again rather than leaving.
    await page.goBack();
    await expect(question).toBeVisible();
    await sheet.getByRole("button", { name: "Discard changes" }).click();
    await expect(sheet).toBeHidden();
    await expect(assistants(page)).toBeVisible();
    await leaves(page);
  });

  test("Back pressed while a notification waits on the group form's question leaves the notification cancelled by Keep editing", async ({ context, page }) => {
    await page.route(/\/api\/groups(\?.*)?$/, route => route.request().method() === "GET"
      ? route.fulfill({ json: { supported: true, canSend: true, rooms: [] } }) : route.fallback());
    await page.goto("about:blank");
    await signIn(page);
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "New group chat" }).click();
    const sheet = page.getByRole("dialog", { name: "New group chat" });
    await sheet.getByRole("textbox", { name: "Name" }).fill("Fence crew");
    await tapNotification(context, page, "/?bot=trail");
    const question = sheet.getByRole("alert").filter({ hasText: "Discard your unsaved changes?" });
    await expect(question).toBeVisible();
    // A second close request while the question is open must not replace the notification's.
    await page.goBack();
    await sheet.getByRole("button", { name: "Keep editing" }).click();
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toBeHidden();
    await expect(assistants(page)).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message Trail Cook" })).toBeHidden();
  });

  test("Back on a new group chat form with nothing entered closes it at once", async ({ page }) => {
    await page.route(/\/api\/groups(\?.*)?$/, route => route.request().method() === "GET"
      ? route.fulfill({ json: { supported: true, canSend: true, rooms: [] } }) : route.fallback());
    await page.goto("about:blank");
    await signIn(page);
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "New group chat" }).click();
    const sheet = page.getByRole("dialog", { name: "New group chat" });
    await expect(sheet).toBeVisible();
    await page.goBack();
    await expect(sheet).toBeHidden();
    await expect(assistants(page)).toBeVisible();
    await leaves(page);
  });

  test("a phone widened to two panes drops its entry, so Back leaves at once, and narrowed again, Back goes home", async ({ page }) => {
    await page.goto("about:blank");
    await signIn(page);
    await ranchRow(page).click();
    await expect(page.getByRole("textbox", { name: "Message Ranch Hand" })).toBeVisible();
    await page.setViewportSize(desktop);
    await expect.poll(() => page.evaluate(() => history.state?.wbDepth ?? 0)).toBe(0);
    await expect(page.getByRole("textbox", { name: "Message Ranch Hand" })).toBeVisible();
    await page.setViewportSize(phone);
    await expect.poll(() => page.evaluate(() => history.state?.wbDepth ?? 0)).toBe(1);
    await page.goBack();
    await expect(assistants(page)).toBeVisible();
    await leaves(page);
  });
});

test.describe("on two panes", () => {
  test.use({ viewport: desktop });

  test("choosing chats adds no entries, so one Back leaves the app", async ({ page }) => {
    await page.goto("about:blank");
    await signIn(page);
    const length = await page.evaluate(() => history.length);
    await ranchRow(page).click();
    await expect(page.getByRole("textbox", { name: "Message Ranch Hand" })).toBeVisible();
    await row(page, /Trail Cook/).click();
    await expect(page.getByRole("textbox", { name: "Message Trail Cook" })).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(length);
    await leaves(page);
  });

  test("narrowed to a phone with a chat open, Back goes home", async ({ page }) => {
    await page.goto("about:blank");
    await signIn(page);
    await ranchRow(page).click();
    await page.setViewportSize(phone);
    await expect.poll(() => page.evaluate(() => history.state?.wbDepth ?? 0)).toBe(1);
    await page.goBack();
    await expect(assistants(page)).toBeVisible();
    await leaves(page);
  });
});
