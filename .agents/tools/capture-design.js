// Playwright CLI run-code function. Screenshots and a geometry report for a design gate.
async (page, { outputDir = ".private/design-review", prefix = "current", screen = "today", stage = "after", fixture } = {}) => {
  const origin = new URL(page.url());
  if (!["127.0.0.1", "localhost"].includes(origin.hostname)) throw Error("Use a loopback fixture.");
  const boot = await (await page.request.get(`${origin.origin}/api/bootstrap`)).json();
  if (boot.user?.email !== "preview@localhost.invalid") throw Error("Use the synthetic household preview.");
  if (!["today", "home", "conversation", "questions", "approvals"].includes(screen)) throw Error(`Unsupported screen: ${screen}`);
  const context = await page.context().browser().newContext({ serviceWorkers: "block", reducedMotion: "reduce", viewport: { width: 1440, height: 1000 } });
  const tab = await context.newPage();
  const pointer = ["questions", "approvals"].includes(screen) ? await context.newCDPSession(tab) : undefined;
  const paths = [], geometry = [];
  let state = "loaded";
  let checked = false;
  let releaseLoading;
  let questionConversation = structuredClone(fixture?.conversation);
  let approvalConversation = structuredClone(fixture?.conversation);
  const approvalSubmissions = [];
  let approvalFailed = false;
  const questionSubmissions = [];
  let questionFailed = false;
  for (const [path, encoded] of Object.entries(fixture?.images || {})) {
    await context.route(`**${path}`, route => route.fulfill({ contentType: "image/png", body: Buffer.from(encoded, "base64") }));
  }
  await context.route("**/api/bots/*/conversation*", async route => {
    if (!["conversation", "questions", "approvals"].includes(screen) || !fixture?.conversation) return route.continue();
    return route.fulfill({ json: screen === "questions" ? questionConversation : screen === "approvals" ? approvalConversation : fixture.conversation });
  });
  if (screen === "questions") await context.route("**/api/bots/*/requests/fixture-question", async route => {
    questionSubmissions.push(route.request().postDataJSON());
    if (fixture.answerError && !questionFailed) {
      questionFailed = true;
      return route.fulfill({ status: 503, json: { error: fixture.answerError } });
    }
    questionConversation = structuredClone(fixture.afterAnswer);
    return route.fulfill({ json: { ok: true } });
  });
  if (screen === "approvals") await context.route("**/api/bots/*/approvals/fixture-approval", async route => {
    const submission = route.request().postDataJSON();
    approvalSubmissions.push(submission);
    await new Promise(resolve => setTimeout(resolve, 300));
    if (fixture.decisionError && !approvalFailed) {
      approvalFailed = true;
      return route.fulfill({ status: 503, json: { error: fixture.decisionError } });
    }
    approvalConversation = structuredClone(submission.decision === "approved" ? fixture.afterApproved : fixture.afterDenied);
    return route.fulfill({ json: { ok: true } });
  });
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
    if (screen === "approvals" && state === "unsupported") value.capabilities.approvals = { supported: false, reason: fixture.unsupportedReason };
    if (fixture?.preferences) value.preferences = { ...value.preferences, ...fixture.preferences };
    if (screen === "home" && state === "three-pins") value.preferences.favorites = ["ranch", "garden", "kitchen"];
    if (screen === "home" && state === "no-pins") value.preferences.favorites = [];
    return route.fulfill({ response, json: value });
  });
  const capture = async (name, width, height, theme = "light") => {
    await tab.setViewportSize({ width, height });
    if (pointer) await pointer.send("Emulation.setTouchEmulationEnabled", { enabled: width <= 620, maxTouchPoints: 1 });
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
    if (screen === "approvals") {
      await tab.addInitScript(() => {
        document.addEventListener("DOMContentLoaded", () => {
          if (sessionStorage.getItem("design-large-text") === "true") document.documentElement.style.fontSize = "200%";
        });
      });
      await tab.goto(`${origin.origin}/?bot=ranch`);
      const card = tab.locator('[data-attention-kind="approval"]');
      await card.waitFor();
      const expiryFontSize = await card.locator("small").evaluate(el => parseFloat(getComputedStyle(el).fontSize));
      if (stage !== "before" && expiryFontSize < 14) throw Error("Approval expiry text is too small.");
      for (const [name, width, height, theme] of [
        ["desktop", 1440, 1000, "light"], ["desktop-dark", 1440, 1000, "dark"],
        ["phone", 390, 844, "light"], ["phone-dark", 390, 844, "dark"],
        ["narrow", 320, 720, "light"], ["tablet", 768, 1024, "light"],
      ]) {
        await tab.setViewportSize({ width, height });
        await pointer.send("Emulation.setTouchEmulationEnabled", { enabled: width <= 620, maxTouchPoints: 1 });
        await tab.emulateMedia({ colorScheme: theme });
        await tab.goto(`${origin.origin}/?bot=ranch`);
        await card.waitFor(); await capture(name, width, height, theme);
      }
      await tab.setViewportSize({ width: 390, height: 844 });
      await tab.evaluate(() => sessionStorage.setItem("design-large-text", "true"));
      await tab.reload(); await card.waitFor();
      await capture("large-text", 390, 844);
      await tab.locator(".transcript").evaluate(el => { el.scrollTop = el.scrollHeight; });
      await capture("large-text-bottom", 390, 844);
      await tab.evaluate(() => sessionStorage.removeItem("design-large-text"));
      state = "unsupported";
      await tab.goto(`${origin.origin}/?bot=ranch`); await card.waitFor();
      if (await card.getByRole("button", { name: "Approve", exact: true }).isEnabled()) throw Error("Unsupported decisions must be disabled.");
      if (stage !== "before") await card.getByText(fixture.unsupportedReason, { exact: true }).waitFor();
      await capture("unsupported", 390, 844);
      state = "loaded";
      const confirmations = [];
      for (const choice of ["approved", "denied"]) {
        approvalConversation = structuredClone(fixture.conversation); approvalFailed = false;
        await tab.goto(`${origin.origin}/?bot=ranch`); await card.waitFor();
        const action = card.getByRole("button", { name: choice === "approved" ? "Approve" : "Decline", exact: true });
        if (choice === "approved") {
          await action.focus(); await tab.keyboard.press("Shift+Tab"); await tab.keyboard.press("Tab");
          if (!await action.evaluate(el => el.matches(":focus-visible"))) throw Error("Approval needs keyboard focus.");
          await capture("keyboard-focus", 390, 844);
        }
        await action.click();
        await tab.getByText(fixture.decisionError, { exact: true }).waitFor();
        await capture(choice + "-error", 390, 844);
        await action.click();
        await card.getByRole("button", { name: choice === "approved" ? "Approved" : "Declined", exact: true }).waitFor();
        if (stage !== "before" && await tab.getByText(fixture.decisionError, { exact: true }).count()) throw Error("Accepted decision kept its old error.");
        if (stage !== "before") {
          const status = card.getByRole("status");
          const expected = choice === "approved" ? "Approval sent." : "Decline sent.";
          await status.getByText(expected, { exact: true }).waitFor();
          const style = await status.evaluate(el => ({ fontSize: parseFloat(getComputedStyle(el).fontSize), opacity: getComputedStyle(el).opacity, color: getComputedStyle(el).color }));
          if (style.fontSize < 14 || style.opacity !== "1") throw Error("The confirmation needs readable, undimmed text.");
          confirmations.push({ choice, text: expected, ...style });
        }
        await capture(choice + "-sent", 390, 844);
        await tab.reload(); await card.waitFor({ state: "hidden" });
        await capture(choice, 390, 844);
      }
      if (approvalSubmissions.length !== 4 || approvalSubmissions.some((item, i) => item.decision !== (i < 2 ? "approved" : "denied"))) throw Error("Decision retry payload changed.");
      return { paths, geometry, approvalSubmissions, submittedAfterReload: true, expiryFontSize, confirmations };
    }
    if (screen === "questions") {
      await tab.addInitScript(() => {
        document.addEventListener("DOMContentLoaded", () => {
          if (sessionStorage.getItem("design-large-text") === "true") document.documentElement.style.fontSize = "200%";
        });
      });
      await tab.goto(`${origin.origin}/?bot=ranch`);
      const card = tab.locator(".attention-card");
      const openings = [];
      const open = async (name, width, height, theme = "light", large = false) => {
        await tab.setViewportSize({ width, height });
        await pointer.send("Emulation.setTouchEmulationEnabled", { enabled: width <= 620, maxTouchPoints: 1 });
        await tab.emulateMedia({ colorScheme: theme });
        await tab.evaluate(large => sessionStorage.setItem("design-large-text", String(large)), large);
        await tab.goto(`${origin.origin}/?bot=ranch`);
        await card.waitFor();
        await capture(name, width, height, theme);
        const firstChoiceVisible = await card.locator(".option-card").first().evaluate(el => {
          const choice = el.getBoundingClientRect(), viewport = document.querySelector(".transcript").getBoundingClientRect();
          const header = document.querySelector(".chat-header").getBoundingClientRect();
          return choice.top >= Math.max(viewport.top, header.bottom) - 1 && choice.bottom <= viewport.bottom + 1;
        });
        const jumpVisible = await tab.locator(".jump-latest").count() > 0;
        openings.push({ name, firstChoiceVisible, jumpVisible });
        if (stage !== "before" && (jumpVisible || (!large && !firstChoiceVisible))) throw Error(`Question opening failed at ${name}.`);
      };
      await open("initial-phone", 390, 844);
      const initialChoiceVisible = openings[0].firstChoiceVisible;
      for (const [name, width, height, theme] of [
        ["desktop", 1440, 1000, "light"], ["desktop-dark", 1440, 1000, "dark"],
        ["phone", 390, 844, "light"], ["phone-dark", 390, 844, "dark"],
        ["narrow", 320, 720, "light"], ["tablet", 768, 1024, "light"],
      ]) {
        await open(name, width, height, theme);
        await tab.locator(".transcript").evaluate(el => { el.scrollTop = el.scrollHeight; });
        await capture(name + "-bottom", width, height, theme);
      }
      await open("large-text", 390, 844, "light", true);
      await tab.locator(".transcript").evaluate(el => { el.scrollTop = el.scrollHeight; });
      await capture("large-text-bottom", 390, 844);
      await tab.evaluate(() => sessionStorage.removeItem("design-large-text"));
      await tab.goto(`${origin.origin}/?bot=ranch`);
      await card.waitFor();
      const route = card.locator("fieldset").first();
      await route.getByText("Write my own answer", { exact: true }).click();
      await route.getByRole("textbox").fill("A shaded loop under two miles, with a place to rest.");
      await card.getByText("A picnic packing list", { exact: true }).click();
      await card.getByText("An offline route map", { exact: true }).click();
      await card.getByRole("textbox", { name: "Anything else I should know?", exact: true }).fill("One child tires easily. Plan a slow morning.");
      const submit = card.getByRole("button", { name: "Send answers", exact: true });
      if (!await submit.isEnabled()) throw Error("Complete answers did not enable Send.");
      await capture("answers", 390, 844);
      await route.getByRole("textbox").focus();
      await capture("own-answer-focus", 390, 844);
      await submit.click();
      await tab.getByText(fixture.answerError, { exact: true }).waitFor();
      if (await route.getByRole("textbox").inputValue() !== "A shaded loop under two miles, with a place to rest.") throw Error("A failed submission lost the answer.");
      await capture("submit-error", 390, 844);
      const errorFontSize = await tab.locator(".notice.error").evaluate(el => parseFloat(getComputedStyle(el).fontSize));
      if (stage !== "before" && errorFontSize < 14) throw Error("The error recovery text is too small.");
      await capture("submit-error-narrow", 320, 720);
      await tab.setViewportSize({ width: 390, height: 844 });
      const accepted = tab.waitForResponse(response => response.url().endsWith("/requests/fixture-question") && response.status() === 200);
      await submit.click();
      await accepted;
      if (stage !== "before") {
        const settled = card.getByRole("button", { name: "Answers sent", exact: true });
        await settled.waitFor();
        if (await settled.isEnabled() || await tab.getByText(fixture.answerError, { exact: true }).count()) throw Error("An accepted answer kept a stale error or allowed duplicate submission.");
      }
      await capture("answers-sent", 390, 844);
      // The synthetic server cannot push an event for this context's private fixture snapshot.
      await tab.reload();
      await card.waitFor({ state: "hidden", timeout: 15000 });
      await capture("submitted", 390, 844);
      if (questionSubmissions.length !== 2 || JSON.stringify(questionSubmissions[0]) !== JSON.stringify(questionSubmissions[1])) throw Error("Retry changed the question answers.");
      return { paths, geometry, questionSubmissions, answersPreserved: true, submittedAfterReload: true, initialChoiceVisible, openings, errorFontSize,
        touchMedia: await tab.evaluate(() => matchMedia("(pointer: coarse)").matches) };
    }
    if (screen === "conversation") {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await tab.goto(`${origin.origin}/?bot=ranch`);
      await tab.locator(".message-markdown").last().waitFor();
      const metadataContrast = [];
      const checkMetadata = async name => {
        const ratio = await tab.locator(".message-user .message-attribution").first().evaluate(el => {
          const luminance = color => {
            const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255)
              .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
            return channels.reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
          };
          const values = [getComputedStyle(el).color, getComputedStyle(el.closest(".message-user")).backgroundColor].map(luminance).sort((a, b) => a - b);
          return (values[1] + 0.05) / (values[0] + 0.05);
        });
        if (stage !== "before" && ratio < 4.5) throw Error(`Message metadata contrast ${ratio.toFixed(2)}:1 in ${name}`);
        metadataContrast.push({ name, ratio });
      };
      const edge = async end => tab.locator(".transcript").evaluate((el, end) => { el.scrollTop = end ? el.scrollHeight : 0; }, end);
      for (const [name, width, height, theme] of [
        ["desktop", 1440, 1000, "light"], ["desktop-dark", 1440, 1000, "dark"],
        ["phone", 390, 844, "light"], ["phone-dark", 390, 844, "dark"],
        ["narrow", 320, 720, "light"], ["tablet", 768, 1024, "light"],
      ]) {
        await tab.setViewportSize({ width, height });
        await edge(false); await capture(name, width, height, theme);
        await checkMetadata(name);
        await edge(true); await capture(name + "-latest", width, height, theme);
      }
      await tab.setViewportSize({ width: 390, height: 844 });
      await tab.locator(".composer textarea").fill("Make the picnic vegetarian. Keep the walk under two miles.");
      await capture("draft", 390, 844);
      if (!await tab.getByRole("button", { name: "Send message", exact: true }).isEnabled()) throw Error("A draft did not enable Send.");
      await tab.locator(".composer textarea").focus();
      await capture("composer-focus", 390, 844);
      await tab.locator(".composer textarea").fill("");
      await edge(true);
      await tab.getByRole("button", { name: "Copy code", exact: true }).click();
      await tab.getByText("Code copied.", { exact: true }).waitFor();
      const copied = await tab.evaluate(() => navigator.clipboard.readText());
      if (!copied.includes("for gate in north east barn")) throw Error("Copy code lost content.");
      await capture("copied-code", 390, 844);
      await tab.getByRole("button", { name: "Copy code", exact: true }).focus();
      await tab.keyboard.press("Shift+Tab");
      await tab.keyboard.press("Tab");
      if (!await tab.getByRole("button", { name: "Copy code", exact: true }).evaluate(el => el.matches(":focus-visible"))) throw Error("Copy code did not show keyboard focus.");
      await capture("code-focus", 390, 844);
      await tab.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      await edge(false); await capture("large-text", 390, 844);
      await edge(true); await capture("large-text-latest", 390, 844);
      return { paths, geometry, metadataContrast, codeCopied: true, draftEnabledSend: true, codeKeyboardFocus: true };
    }
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
