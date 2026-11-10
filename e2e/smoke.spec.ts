import type { Page } from "@playwright/test";
import { assistants, chooseDark, conversation, deployNextRelease, expect, signIn, test } from "./fixtures.js";

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

test("a link to a chat shows sign-in when signed out, then reads the chat beside bootstrap once signed in", async ({ page }) => {
  // Signed out, the link costs one refused bootstrap (which the fixture excuses) and nothing else.
  await page.goto("/?bot=ranch");
  await page.getByRole("button", { name: "Enter local workspace" }).click();
  await expect(conversation(page).getByText("Morning. The north fence is fixed.")).toBeVisible();

  // Signed in, bootstrap is held until the chat's read has started, which proves the read does not wait for it.
  let chatRead!: () => void;
  const chatStarted = new Promise<boolean>(resolve => { chatRead = () => resolve(true); });
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/bots/ranch/conversation") chatRead(); });
  const heldUntil: boolean[] = [];
  await page.route("**/api/bootstrap?*", async route => {
    heldUntil.push(await Promise.race([chatStarted, new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2_000))]));
    await route.continue();
  });
  await page.goto("/?bot=ranch");
  await expect(conversation(page).getByText("Morning. The north fence is fixed.")).toBeVisible();
  expect(heldUntil[0]).toBe(true);
});

test.describe("a returning member's load", () => {
  // Routes see only what the page itself fetches, so the worker must not answer the bundle from its cache.
  test.use({ serviceWorkers: "block" });

  test("draws its first frame in the system's theme when the member signed out between boot.js and the app's code", async ({ page }) => {
    await signIn(page);
    await chooseDark(page);
    // The theme as the app's first frame paints: a MutationObserver runs before the browser paints, after
    // React's layout effects and before its other effects.
    await page.addInitScript(() => {
      new MutationObserver((_changes, observer) => {
        if (!document.getElementById("root")?.firstElementChild) return;
        (window as unknown as { themeAtFirstDraw?: string }).themeAtFirstDraw = document.documentElement.dataset.theme;
        observer.disconnect();
      }).observe(document, { childList: true, subtree: true });
    });
    let themeAtBoot: string | undefined;
    // While the bundle is on its way, another tab of this browser signs the member out and leaves what its sign-out leaves.
    await page.route(/\/assets\/index-[^/]+\.js$/, async route => {
      themeAtBoot = await page.evaluate(async () => {
        const boot = await (await fetch("/api/bootstrap")).json() as { csrfToken: string };
        await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": boot.csrfToken }, body: "{}" });
        localStorage.removeItem("agent-interface:theme");
        localStorage.removeItem("agent-interface:sign-in-hint");
        localStorage.setItem("agent-interface:auth-epoch", JSON.stringify({ id: "elsewhere", at: Date.now(), signedOut: true }));
        return document.documentElement.dataset.theme;
      });
      await route.continue();
    });
    await page.reload();
    await expect(page.getByRole("button", { name: "Enter local workspace" })).toBeVisible();
    // boot.js applied the dark theme, rightly at that moment; nothing of it reaches the app's first frame.
    expect(themeAtBoot).toBe("dark");
    expect(await page.evaluate(() => (window as unknown as { themeAtFirstDraw?: string }).themeAtFirstDraw)).toBe("system");
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("system");
  });

  test("starts bootstrap before the app's code arrives, reads it once, and opens in the saved dark theme", async ({ page }) => {
    await signIn(page);
    // The person chose dark while the system is light, so a theme known only after bootstrap would flash light.
    await chooseDark(page);

    // The bundle is held back, so a bootstrap that waits for the app's code comes after it.
    const order: string[] = [];
    let reloaded = false;
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (reloaded && (path === "/api/bootstrap" || path === "/api/events")) order.push(path);
    });
    await page.route(/\/assets\/index-[^/]+\.js$/, async route => {
      await new Promise(resolve => setTimeout(resolve, 500));
      order.push("bundle");
      await route.continue();
    });
    await page.addInitScript(() => {
      new MutationObserver((_changes, observer) => {
        if (!document.body) return;
        (window as unknown as { themeAtBody?: string }).themeAtBody = document.documentElement.dataset.theme;
        observer.disconnect();
      }).observe(document, { childList: true, subtree: true });
    });
    // Counted from the new document only: the page before it may still be reading bootstrap after its own stream connected.
    page.once("framenavigated", () => { reloaded = true; });
    await page.reload();
    await expect(assistants(page).getByRole("button", { name: /Ranch Hand/ })).toBeVisible();
    await expect.poll(() => order.includes("/api/events")).toBe(true);
    // Before the event stream connects (which reads bootstrap again by design), one read, sent before the bundle arrived.
    expect(order.slice(0, order.indexOf("/api/events"))).toEqual(["/api/bootstrap", "bundle"]);
    expect(await page.evaluate(() => (window as unknown as { themeAtBody?: string }).themeAtBody)).toBe("dark");
  });
});

test("a sign-out or sign-in in one tab changes the account every other tab shows, without a reload", async ({ context, page }) => {
  await signIn(page);
  await expect(assistants(page).getByRole("button", { name: /Ranch Hand/ })).toBeVisible();
  const other = await context.newPage();
  await other.goto("/");
  await expect(assistants(other).getByRole("button", { name: /Ranch Hand/ })).toBeVisible();
  await page.evaluate(() => { (window as unknown as { sameDocument: boolean }).sameDocument = true; });

  await other.bringToFront();
  await other.getByRole("button", { name: "Account" }).click();
  await other.getByRole("menu", { name: "Account" }).getByRole("menuitem", { name: "Sign out" }).click();
  // This checks the tabs, not the sheet's layout, so the press goes to the button whatever overlaps it.
  await other.getByRole("alertdialog", { name: "Sign out?" }).getByRole("button", { name: "Sign out" }).dispatchEvent("click");
  await expect(page.getByRole("button", { name: "Enter local workspace" })).toBeVisible();
  await expect(page.getByText("Ranch Hand")).toHaveCount(0);

  await other.getByLabel("Sign in as").selectOption("two");
  await other.getByRole("button", { name: "Enter local workspace" }).click();
  await expect(assistants(page).getByRole("button", { name: /Ranch Hand/ })).toBeVisible();
  await page.getByRole("button", { name: "Account" }).click();
  await expect(page.getByRole("menu", { name: "Account" })).toContainText("two@localhost.invalid");
  expect(await page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument)).toBe(true);
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
// The releases' caches. The worker also keeps which account may see notifications, in a cache every release keeps.
const releaseCaches = (page: Page) => page.evaluate(async () => (await globalThis.caches.keys()).filter(key => key.startsWith("agent-interface-")));
const shellNoted = (page: Page) => page.evaluate(async () => {
  for (const key of await caches.keys()) if (await (await caches.open(key)).match("/.shell-outdated")) return key;
  return null;
});

test("after a deploy, the next load opens the new shell, and the new release is offered until it is taken", async ({ page }) => {
  await signIn(page);
  await assistants(page).getByRole("button", { name: /Ranch Hand/ }).click();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const caches = () => releaseCaches(page);
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
  const [current] = await releaseCaches(page);

  await deployNextRelease({ installs: false });
  await page.reload();
  await expect.poll(() => shellNoted(page)).toBe(current);
  await page.reload();
  await expect(releaseMark(page)).toHaveCount(1);
  await expect(conversation(page).getByText("Morning. The north fence is fixed.")).toBeVisible();
  // The old worker still serves, and nothing offers a release that never installed.
  expect(await releaseCaches(page)).toEqual([current]);
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

test("a notification tapped while the app is open switches its chat without reloading it", async ({ context, page }) => {
  await signIn(page);
  await assistants(page).getByRole("button", { name: /Ranch Hand/ }).click();
  await expect(conversation(page).getByText("Morning. The north fence is fixed.")).toBeVisible();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.evaluate(() => { (window as unknown as { sameDocument: boolean }).sameDocument = true; });

  // The worker's own tap handler, minus the notification: Playwright cannot click one.
  const [worker] = context.serviceWorkers();
  await worker.evaluate(() => (self as unknown as { openChat(notification: { data: { url: string } }): Promise<void> }).openChat({ data: { url: "/?bot=trail" } }));
  await expect(page.getByRole("textbox", { name: "Message Trail Cook" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("bot")).toBe("trail");
  expect(await page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument)).toBe(true);
});

test.describe("on a phone held sideways with its on-screen keyboard up", () => {
  test.use({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });

  test("a long draft scrolls inside the message box and Send stays on screen to tap", async ({ page }) => {
    // Chromium shows no keyboard. Safari reports one as a visual viewport shorter than the page, so this one
    // shrinks to 190px, what a landscape iPhone leaves above its keyboard, and then to 140px.
    await page.addInitScript(() => {
      const viewport = Object.assign(new EventTarget(), { height: innerHeight, width: innerWidth, scale: 1, pageTop: 0, pageLeft: 0, offsetTop: 0, offsetLeft: 0 });
      Object.defineProperty(window, "visualViewport", { value: viewport });
      (window as unknown as { openKeyboard(height: number): void }).openKeyboard = height => {
        viewport.height = height;
        viewport.dispatchEvent(new Event("resize"));
      };
    });
    await signIn(page);
    await assistants(page).getByRole("button", { name: /Ranch Hand/ }).click();
    const field = page.getByRole("textbox", { name: "Message Ranch Hand" });
    await field.tap();
    const draft = Array.from({ length: 8 }, (_, line) => `Line ${line + 1} of the feed order`).join("\n");
    await field.fill(draft);
    const send = page.getByRole("button", { name: "Send message" });
    // 140px leaves less than the header and the composer need together, so the header gives way, not Send.
    for (const visible of [190, 140]) {
      await page.evaluate(height => (window as unknown as { openKeyboard(height: number): void }).openKeyboard(height), visible);
      const box = (await send.boundingBox())!;
      expect({ top: box.y >= 0, bottom: box.y + box.height <= visible }, `Send at ${box.y} to ${box.y + box.height} of ${visible}`)
        .toEqual({ top: true, bottom: true });
      // Nothing covers it, so a tap at its center reaches it.
      expect(await send.evaluate(button => {
        const { left, top, width, height } = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(left + width / 2, top + height / 2));
      })).toBe(true);
      // The draft scrolls inside its own box, and the app fits the frame without the shell scrolled to show it.
      expect(await field.evaluate(input => {
        const own = input.getBoundingClientRect(), form = input.closest("form")!.getBoundingClientRect();
        return { scrolls: input.scrollHeight > input.clientHeight, inForm: own.top >= form.top && own.bottom <= form.bottom,
          shellScrolled: document.querySelector(".app-shell")!.scrollTop };
      })).toEqual({ scrolls: true, inForm: true, shellScrolled: 0 });
    }

    await send.tap();
    await expect(conversation(page).getByText(`Howdy, partner. You said: ${draft}`)).toBeAttached();
    await expect(field).toBeFocused();
  });
});
