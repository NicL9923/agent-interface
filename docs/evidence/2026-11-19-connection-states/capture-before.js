// Playwright CLI run-code function: captures the web app's connection states from the loopback preview.
// oxlint-disable-next-line no-unused-expressions -- playwright-cli run-code reads this file as one function expression.
async (page) => {
  const origin = "http://127.0.0.1:3141";
  const outputDir = "__OUT__";
  const prefix = "__PREFIX__";
  const context = await page
    .context()
    .browser()
    .newContext({ serviceWorkers: "block", reducedMotion: "reduce", colorScheme: "light" });
  const tab = await context.newPage();
  const paths = [];
  const notes = [];
  let mode = "healthy";
  await tab.route("**/api/bootstrap*", async (route) => {
    const response = await route.fetch();
    const boot = await response.json();
    if (mode === "hermesDown")
      boot.connection = {
        ...boot.connection,
        connected: false,
        code: "unreachable",
        detail: "Explicit preview fixture. The configured Hermes host is unavailable.",
      };
    if (mode === "hermesReconnecting")
      boot.connection = {
        ...boot.connection,
        connected: false,
        code: "reconnecting",
        detail: "Checking the Hermes gateway and durable add-on contract.",
      };
    await route.fulfill({ json: boot });
  });
  await tab.route("**/api/bots/*/conversation*", async (route) => {
    if (mode === "chatReadFails")
      return route.fulfill({
        status: 502,
        json: {
          error: "The Hermes operation could not be completed",
          code: "unreachable",
        },
      });
    await route.continue();
  });
  await tab.route("**/api/**/events*", async (route) => {
    if (mode === "streamsDown") return route.abort();
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
        badges: document.querySelectorAll('.avatar-wrap[data-state="disconnected"]').length,
      };
    });
    notes.push({ label, ...text });
  };
  try {
    for (const width of [1440, 390]) {
      await tab.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      const phone = width === 390;

      // 1. Healthy chat, for reference.
      mode = "healthy";
      await tab.goto(origin + "/?view=conversation&bot=kitchen");
      await tab.locator("article[data-message-id]").first().waitFor();
      await shot(`1-healthy-${width}`);

      // 2. Hermes down, as bootstrap reports it.
      mode = "hermesDown";
      await tab.goto(origin + "/?view=conversation&bot=kitchen");
      await tab.getByRole("region", { name: "Hermes connection", exact: true }).waitFor();
      await say(`hermesDown-${width}`);
      await shot(`2-hermes-down-chat-${width}`);
      if (phone) {
        await tab.getByRole("button", { name: "Back to assistants", exact: true }).click();
        await tab.waitForTimeout(400);
        await shot(`2b-hermes-down-home-${width}`);
      }

      // 3. First click into a chat whose read answers "unreachable" while bootstrap says connected.
      mode = "healthy";
      await tab.goto(origin + "/");
      await tab.waitForTimeout(800);
      mode = "chatReadFails";
      if (phone) {
        await tab.goto(origin + "/?view=conversation&bot=ledger");
      } else {
        await tab.goto(origin + "/?view=conversation&bot=ledger");
      }
      await tab.waitForTimeout(1500);
      await say(`chatReadFails-${width}`);
      await shot(`3-first-open-read-fails-${width}`);

      // 4. Offline.
      mode = "healthy";
      await tab.goto(origin + "/?view=conversation&bot=kitchen");
      await tab.locator("article[data-message-id]").first().waitFor();
      await context.setOffline(true);
      await tab.waitForTimeout(600);
      await say(`offline-${width}`);
      await shot(`4-offline-${width}`);
      await context.setOffline(false);

      // 5. Hermes reconnecting (the code a bootstrap sees mid-reconnect).
      mode = "hermesReconnecting";
      await tab.goto(origin + "/?view=conversation&bot=kitchen");
      await tab.getByRole("region", { name: "Hermes connection", exact: true }).waitFor();
      await say(`hermesReconnecting-${width}`);
      await shot(`5-hermes-reconnecting-${width}`);
    }
    return { paths, notes };
  } finally {
    await context.close();
  }
}
