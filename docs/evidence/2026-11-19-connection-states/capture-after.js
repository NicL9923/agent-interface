// Playwright CLI run-code function: captures the web app's connection states after the change.
// oxlint-disable-next-line no-unused-expressions -- playwright-cli run-code reads this file as one function expression.
async (page) => {
  const origin = "http://127.0.0.1:3141";
  const outputDir = "__OUT__";
  const prefix = "__PREFIX__";
  const scheme = "__SCHEME__";
  const context = await page
    .context()
    .browser()
    .newContext({ serviceWorkers: "block", reducedMotion: "reduce", colorScheme: scheme });
  const tab = await context.newPage();
  const paths = [];
  const notes = [];
  let mode = "healthy";
  await tab.route("**/api/bootstrap*", async (route) => {
    if (mode === "appDown") return route.abort();
    const response = await route.fetch();
    const boot = await response.json();
    if (mode === "hermesDown")
      boot.connection = {
        ...boot.connection,
        connected: false,
        code: "unreachable",
        detail: "Explicit preview fixture. The configured Hermes host is unavailable.",
      };
    await route.fulfill({ json: boot });
  });
  await tab.route("**/api/bots/*/conversation*", async (route) => {
    if (mode === "appDown") return route.abort();
    if (mode === "chatReadFails")
      return route.fulfill({
        status: 502,
        json: { error: "The Hermes operation could not be completed", code: "unreachable" },
      });
    await route.continue();
  });
  const shot = async (name) => {
    await tab.mouse.move(0, 0);
    await tab.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    const path = `${outputDir}/${prefix}${name}.png`;
    await tab.screenshot({ path, animations: "disabled" });
    paths.push(path);
  };
  const say = async (label) => {
    const text = await tab.evaluate(() => {
      const panel = document.querySelector(".connection-panel");
      const announcer = document.querySelector("[data-connection-announcer]");
      const sync = document.querySelector(".home-sync");
      return {
        panel: panel ? panel.innerText.replace(/\s+/g, " ").slice(0, 300) : null,
        announcer: announcer ? announcer.textContent : null,
        sidebar: sync ? sync.textContent : null,
        dimmed: document.querySelectorAll('.avatar-wrap[data-state="disconnected"]').length,
        badges: document.querySelectorAll('.avatar-wrap[data-state="disconnected"] .avatar-badge')
          .length,
        send: document.querySelector('button[aria-label^="Send"]')?.getAttribute("title") ?? null,
      };
    });
    notes.push({ label, ...text });
  };
  const healthyChat = async (bot) => {
    mode = "healthy";
    await tab.goto(`${origin}/?view=conversation&bot=${bot}`);
    await tab.locator("article[data-message-id]").first().waitFor();
    await tab.waitForTimeout(500);
  };
  const lose = async (next, signal) => {
    mode = next;
    await tab.evaluate((name) => window.dispatchEvent(new Event(name)), signal);
  };
  try {
    for (const width of [1440, 390]) {
      await tab.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      const phone = width === 390;

      // 1. Hermes lost while the app was working: nothing for 3 s, one line, then the reason at 10 s.
      await healthyChat("kitchen");
      await lose("hermesDown", "online");
      await tab.waitForTimeout(1500);
      await say(`hermes-lost-1.5s-${width}`);
      await shot(`1-hermes-lost-in-grace-${width}`);
      await tab.waitForTimeout(2300);
      await say(`hermes-lost-3.8s-${width}`);
      await shot(`2-hermes-lost-reconnecting-${width}`);
      if (phone) {
        await tab.getByRole("button", { name: "Back to assistants", exact: true }).click();
        await tab.waitForTimeout(400);
        await shot(`2b-hermes-lost-home-${width}`);
        await tab.goBack().catch(() => {});
        await tab.waitForTimeout(300);
      }
      await tab.waitForTimeout(7000);
      await say(`hermes-lost-11s-${width}`);
      await shot(`3-hermes-lost-lasting-${width}`);

      // 2. The same with words in the message box.
      await healthyChat("kitchen");
      await tab.locator("textarea").first().fill("Add oat milk to the list");
      await lose("hermesDown", "online");
      await tab.waitForTimeout(10800);
      await say(`hermes-lost-draft-11s-${width}`);
      await shot(`4-hermes-lost-lasting-draft-${width}`);
      await tab.locator("textarea").first().fill("");

      // 3. Only this chat's reads fail; the app and Hermes answer.
      await healthyChat("kitchen");
      await lose("chatReadFails", "agent-interface:reconnect");
      await tab.waitForTimeout(3800);
      await say(`chat-only-3.8s-${width}`);
      await shot(`5-chat-only-reconnecting-${width}`);
      await tab.waitForTimeout(7000);
      await say(`chat-only-11s-${width}`);
      await shot(`6-chat-only-lasting-${width}`);

      // 4. First open of a chat whose read fails.
      mode = "healthy";
      await tab.goto(origin + "/");
      await tab.waitForTimeout(800);
      mode = "chatReadFails";
      await tab.goto(origin + "/?view=conversation&bot=ledger");
      await tab.waitForTimeout(1200);
      await say(`first-open-1.2s-${width}`);
      await shot(`7-first-open-in-grace-${width}`);
      await tab.waitForTimeout(3000);
      await say(`first-open-4.2s-${width}`);
      await shot(`8-first-open-reconnecting-${width}`);

      // 5. Offline, without and with a draft.
      await healthyChat("kitchen");
      await context.setOffline(true);
      await tab.waitForTimeout(3600);
      await say(`offline-${width}`);
      await shot(`9-offline-${width}`);
      await context.setOffline(false);
      await healthyChat("kitchen");
      await tab.locator("textarea").first().fill("Add oat milk to the list");
      await context.setOffline(true);
      await tab.waitForTimeout(3600);
      await say(`offline-draft-${width}`);
      await shot(`10-offline-draft-${width}`);
      await context.setOffline(false);
      await tab.locator("textarea").first().fill("");

      // 6. The app itself unreachable.
      await healthyChat("kitchen");
      await lose("appDown", "online");
      await tab.waitForTimeout(11000);
      await say(`app-down-11s-${width}`);
      await shot(`11-app-down-lasting-${width}`);

      // 7. Hermes down when the page loads: nothing to wait out, so the reason shows at once.
      mode = "hermesDown";
      await tab.goto(origin + "/?view=conversation&bot=kitchen");
      await tab.getByRole("region", { name: "Hermes connection", exact: true }).waitFor();
      await say(`load-hermes-down-${width}`);
      await shot(`12-load-hermes-down-${width}`);
    }
    return { paths, notes };
  } finally {
    await context.close();
  }
}
