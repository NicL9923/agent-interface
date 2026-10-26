// Playwright CLI run-code function. Screenshots and a geometry report for a design gate.
async (page, { outputDir = ".private/design-review", prefix = "current", screen = "today", fixture } = {}) => {
  const origin = new URL(page.url());
  if (!["127.0.0.1", "localhost"].includes(origin.hostname)) throw Error("Use a loopback fixture.");
  const boot = await (await page.request.get(`${origin.origin}/api/bootstrap`)).json();
  if (boot.user?.email !== "preview@localhost.invalid") throw Error("Use the synthetic household preview.");
  if (!["today", "home"].includes(screen)) throw Error(`Unsupported screen: ${screen}`);
  const context = await page.context().browser().newContext({ serviceWorkers: "block", reducedMotion: "reduce", viewport: { width: 1440, height: 1000 } });
  const tab = await context.newPage();
  const paths = [], geometry = [];
  let state = "loaded";
  let checked = false;
  let releaseLoading;
  for (const [path, encoded] of Object.entries(fixture?.images || {})) {
    await context.route(`**${path}`, route => route.fulfill({ contentType: "image/png", body: Buffer.from(encoded, "base64") }));
  }
  await context.route("**/api/today", async route => {
    if (!fixture?.overview || screen !== "today") return route.continue();
    const value = structuredClone(fixture.overview);
    if (state === "loading") await new Promise(resolve => { releaseLoading = resolve; });
    if (state === "error" && checked) return route.fulfill({ status: 503, json: { error: "The connection was interrupted." } });
    if (state === "all-clear") { value.items = []; value.events = []; value.upcoming = []; }
    if (state === "partial") {
      const item = value.items.find(item => item.botId === "guide") || value.items[0];
      item.activity = { state: "disconnected" };
      item.error = "Could not read this Hermes conversation. Open it to reconnect.";
      item.approvals = []; item.attention = [];
      value.unavailableBots = [item.botId];
    }
    if (state === "paged") value.hasMore = true;
    checked = true;
    return route.fulfill({ json: value });
  });
  await context.route("**/api/bootstrap*", async route => {
    const response = await route.fetch();
    const value = await response.json();
    if (fixture) value.bots = state === "empty" ? [] : fixture.bots;
    if (fixture?.preferences) value.preferences = { ...value.preferences, ...fixture.preferences };
    if (screen === "home" && state === "three-pins") value.preferences.favorites = ["ranch", "garden", "kitchen"];
    if (screen === "home" && state === "no-pins") value.preferences.favorites = [];
    return route.fulfill({ response, json: value });
  });
  const capture = async (name, width, height, theme = "light") => {
    await tab.setViewportSize({ width, height });
    await tab.emulateMedia({ colorScheme: theme });
    // Await the React media-query update, fonts and at least two painted frames.
    await tab.evaluate(async ({ theme, width, height }) => {
      document.documentElement.dataset.theme = theme;
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (innerWidth !== width || innerHeight !== height) throw Error("Viewport did not settle.");
    }, { theme, width, height });
    if (!/menu|focus/.test(name)) {
      await tab.mouse.move(width - 1, height - 1);
      await tab.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    }
    const path = `${outputDir}/${prefix}-${screen}-${name}.png`;
    if (screen === "home" && name.startsWith("desktop") && !name.includes("menu")) {
      await tab.locator(".bot-rail").screenshot({ path, animations: "disabled" });
    } else { await tab.screenshot({ path, animations: "disabled" }); }
    paths.push(path);
    geometry.push({ name, width, height, ...await tab.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      column: document.querySelector(".today-content")?.getBoundingClientRect().width,
      attention: [...document.querySelectorAll(".today-attention-list .today-row")].map(row => {
        const { top, bottom } = row.getBoundingClientRect();
        return { top, bottom, label: row.textContent };
      }),
    })) });
  };
  try {
    if (screen === "home") {
      await tab.goto(`${origin.origin}/?bot=ranch`);
      await tab.locator(".pinned-bot").first().waitFor();
      await capture("desktop", 1440, 1000);
      await capture("desktop-dark", 1440, 1000, "dark");
      await tab.locator(".pinned-bot").first().focus();
      await tab.keyboard.press("Shift+F10");
      await tab.getByRole("menu", { name: "Ranch hand", exact: true }).waitFor();
      await capture("desktop-menu", 1440, 1000);
      await tab.getByRole("menuitem", { name: "Move to section" }).hover();
      await tab.getByRole("menu", { name: "Home section", exact: true }).waitFor();
      await capture("desktop-submenu", 1440, 1000);
      await tab.keyboard.press("Escape");
      await tab.keyboard.press("Escape");
      await tab.setViewportSize({ width: 390, height: 844 });
      await tab.goto(origin.origin);
      await tab.locator(".bot-rail.open").waitFor();
      await capture("phone", 390, 844);
      await capture("phone-dark", 390, 844, "dark");
      for (const variant of ["three-pins", "no-pins"]) {
        state = variant;
        await tab.goto(origin.origin);
        await tab.locator(".bot-rail.open").waitFor();
        await tab.getByRole("button", { name: "Settings", exact: true }).waitFor();
        await capture(variant, 390, 844);
      }
      state = "loaded";
      await tab.goto(origin.origin);
      await tab.locator(".pinned-bot").first().waitFor();
      await capture("narrow", 320, 720);
      await tab.locator(".pinned-bot").first().click({ button: "right" });
      await tab.getByRole("menu", { name: "Ranch hand", exact: true }).waitFor();
      await capture("phone-menu", 390, 844);
      await tab.keyboard.press("Escape");
      await tab.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      await capture("large-text", 390, 844);
      await tab.locator(".home-scroll").evaluate(el => { el.scrollTop = el.scrollHeight; });
      await capture("large-text-scrolled", 390, 844);
      await tab.evaluate(() => { document.documentElement.style.removeProperty("font-size"); });
      state = "empty";
      await tab.goto(origin.origin);
      await tab.locator(".bot-rail").getByRole("button", { name: "Create an assistant", exact: true }).waitFor();
      await capture("empty", 390, 844);
      return { paths, geometry };
    }
    await tab.goto(`${origin.origin}/?view=today`);
    await tab.getByRole("heading", { name: /Needs your attention|Since you were away/ }).first().waitFor();
    await capture("desktop", 1440, 1000);
    await capture("desktop-dark", 1440, 1000, "dark");
    await capture("phone", 390, 844);
    await capture("phone-dark", 390, 844, "dark");
    await capture("narrow", 320, 720);
    await capture("tablet", 768, 1024);
    if (fixture) {
      for (const variant of ["all-clear", "partial", "paged"]) {
        state = variant;
        await tab.reload();
        await tab.getByRole("button", { name: /Mark.*caught up/ }).waitFor();
        await capture(variant, 390, 844);
        if (variant === "partial" && await tab.locator(".today-attention-list").count()) {
          await tab.locator(".today-attention-list .today-row").filter({ hasText: "Disconnected" }).click();
          await tab.waitForURL(url => url.searchParams.get("bot") === "guide" && !url.searchParams.has("view"));
          await tab.goto(`${origin.origin}/?view=today`);
          await tab.getByRole("heading", { name: /Needs your attention/ }).waitFor();
        }
      }
      state = "error";
      await tab.getByRole("button", { name: "Refresh", exact: true }).click();
      await tab.getByRole("alert").waitFor();
      await capture("stale-error", 390, 844);
      state = "loading";
      await tab.reload({ waitUntil: "domcontentloaded" });
      await tab.getByText("Checking your assistants...", { exact: true }).waitFor();
      await capture("loading", 390, 844);
      releaseLoading();
      await tab.getByRole("heading", { name: /Needs your attention/ }).waitFor();
      if (!await tab.locator(".today-content").count()) return { paths, geometry };
      await tab.getByRole("button", { name: "Refresh", exact: true }).focus();
      await tab.keyboard.press("Tab");
      if (!await tab.locator(".today-attention-list .today-row").first().evaluate(el => el === document.activeElement)) {
        throw Error("Tab did not reach the first request.");
      }
      await capture("keyboard-focus", 1440, 1000);
      await tab.keyboard.press("Enter");
      await tab.waitForURL(url => url.searchParams.get("bot") === "ranch" && !url.searchParams.has("view"));
    }
    return { paths, geometry };
  } finally { await context.close(); }
}
