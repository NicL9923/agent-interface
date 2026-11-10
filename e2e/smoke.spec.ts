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
