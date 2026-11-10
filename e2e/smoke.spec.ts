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

test.describe("after a deploy retires a lazy screen's file", () => {
  // The worker would answer from its own cache, so the browser asks the server, which no longer has the file.
  test.use({ serviceWorkers: "block" });

  test("the screen offers Reload and leaves the page alone until the person takes it", async ({ page, allowConsoleError }) => {
    // Chromium logs the refused file, and React the screen error the prompt handles. Nothing else is excused.
    allowConsoleError.push(/status of 404/, /dynamically imported module/);
    await signIn(page);
    // The page asks for a name this build never had, as a page from the previous release would, and the real server answers.
    const retired = /\/assets\/UsagePanel-[^/]+\.js$/;
    await page.route(retired, route => route.continue({ url: route.request().url().replace(/UsagePanel-[^/]+\.js$/, "UsagePanel-retired0.js") }));
    let loads = 0;
    page.on("load", () => { loads++; });
    const openUsage = async () => {
      await page.getByRole("button", { name: "Account" }).click();
      await page.getByRole("menu", { name: "Account" }).getByRole("menuitem", { name: /Usage/ }).click();
    };

    await openUsage();
    const prompt = page.getByRole("alert").filter({ hasText: "This screen could not load." });
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText("The app may have been updated");
    // Nothing reloaded under the person: the rest of the app is still the page they had.
    expect(loads).toBe(0);
    await expect(assistants(page)).toBeVisible();

    // Reload asks the server for the app again, and the screen opens from what it has now.
    await page.unroute(retired);
    await prompt.getByRole("button", { name: "Reload" }).click();
    await expect.poll(() => loads).toBe(1);
    await openUsage();
    await expect(page.getByText("2 banked resets")).toBeVisible();
  });
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

test("a reply keeps growing across a tool call, and its saved segment never disappears or doubles", async ({ page }) => {
  const saved = "Looking at the north fence.", after = "Post two is loose, so I tightened the wire and checked the gate.";
  const reads: number[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/bots/trail/conversation") reads.push(Date.now()); });
  await signIn(page);
  await assistants(page).getByRole("button", { name: /Trail Cook/ }).click();
  // Every text the transcript showed, as it changed.
  await page.evaluate(() => {
    const region = document.querySelector('[role="region"][aria-label="Conversation"]')!;
    const seen: { at: number; text: string }[] = (window as unknown as { seen: typeof seen }).seen = [];
    new MutationObserver(() => seen.push({ at: Date.now(), text: region.textContent ?? "" }))
      .observe(region, { childList: true, subtree: true, characterData: true });
  });
  await page.getByRole("textbox", { name: "Message Trail Cook" }).fill("Walk the fence line");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(conversation(page).getByText(after, { exact: true })).toBeVisible();
  const seen = await page.evaluate(() => (window as unknown as { seen: { at: number; text: string }[] }).seen);

  // The segment's start never shows twice, not even as a saved copy beside a live tail still catching up.
  // Once it showed whole, every later view holds it: never dropped.
  const starts = (text: string) => text.split("Looking").length - 1;
  expect(seen.filter(view => starts(view.text) > 1).map(view => view.text)).toEqual([]);
  const whole = seen.findIndex(view => view.text.includes(saved));
  expect(whole).toBeGreaterThanOrEqual(0);
  expect(seen.slice(whole).filter(view => !view.text.includes(saved)).map(view => view.text)).toEqual([]);

  // After the tool, the reply grew a word or so at a time, only ever forward, far more often than the chat read.
  const shown = (text: string) => {
    const tail = text.slice(text.indexOf("Post"));
    let length = 0;
    while (length < after.length && tail[length] === after[length]) length++;
    return length;
  };
  const lengths = seen.filter(view => view.text.includes("Post")).map(view => shown(view.text));
  // Text resumed with the first word after the tool, a turn read later, not with the chat's next read.
  expect(lengths[0], lengths.join(" ")).toBeLessThanOrEqual("Post ".length);
  for (let index = 1; index < lengths.length; index++) expect(lengths[index], lengths.join(" ")).toBeGreaterThanOrEqual(lengths[index - 1]);
  const from = seen.find(view => view.text.includes("Post"))!.at, to = seen.find(view => view.text.includes(after))!.at;
  const steps = new Set(lengths).size, readsMeanwhile = reads.filter(at => at >= from && at <= to).length;
  expect(steps, `${steps} growth steps, ${readsMeanwhile} reads`).toBeGreaterThan(readsMeanwhile + 3);
});
