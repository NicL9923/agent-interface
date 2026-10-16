// Playwright CLI run-code function. Uses real blocked/delayed chunk requests.
async page => {
  const origin = new URL(page.url());
  if (!["127.0.0.1", "localhost"].includes(origin.hostname)) throw Error("Use a loopback fixture.");
  const fixture = await (await page.request.get(`${origin.origin}/api/bootstrap`)).json();
  if (fixture.user?.email !== "preview@localhost.invalid") throw Error("Use the synthetic household preview.");
  const results = [];
  for (const width of [1440, 390]) for (const failed of [false, true]) {
    const context = await page.context().browser().newContext({ serviceWorkers: "block", viewport: { width, height: 844 } });
    let release;
    const ready = new Promise(resolve => { release = resolve; });
    await context.route("**/api/bootstrap", async route => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({ response, json: { ...data, preferences: { ...data.preferences, presentation: "advanced" } } });
    });
    await context.route("**/ComposerModelPicker-*.js", async route => {
      if (failed) await route.abort("failed");
      else { await ready; await route.continue(); }
    });
    const tab = await context.newPage();
    try {
      await tab.goto(`${origin.origin}/?bot=ranch`, { waitUntil: "domcontentloaded" });
      const label = failed ? "Model controls unavailable. Reload to try again." : "Loading model controls";
      await tab.getByRole("button", { name: label, exact: true }).waitFor();
      const hitTests = await tab.evaluate(() => [".composer textarea", 'button[aria-label="Record voice"]'].map(selector => {
        const element = document.querySelector(selector);
        if (!element) throw Error(`Missing ${selector}`);
        const rect = element.getBoundingClientRect();
        const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { selector, uncovered: !!top && (top === element || element.contains(top)) };
      }));
      if (hitTests.some(test => !test.uncovered)) throw Error(JSON.stringify({ width, failed, hitTests }));
      await tab.locator(".composer textarea").fill("Draft remains editable");
      if (await tab.locator(".composer textarea").inputValue() !== "Draft remains editable") throw Error("Composer lost input.");
      results.push({ width, state: failed ? "failed" : "loading", hitTests, editable: true });
      if (!failed) {
        release();
        await tab.getByRole("button", { name: "Model: openrouter / configured-model", exact: true }).waitFor();
      }
    } finally {
      release();
      await context.close();
    }
  }
  return results;
}
