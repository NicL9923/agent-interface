// Playwright CLI run-code function. Exercise a real Chromium touch long-press on home.
async (page, { outputDir = ".private/design-review" } = {}) => {
  const origin = new URL(page.url());
  if (!["127.0.0.1", "localhost"].includes(origin.hostname)) throw Error("Use a loopback fixture.");
  const fixture = await (await page.request.get(`${origin.origin}/api/bootstrap`)).json();
  if (fixture.user?.email !== "preview@localhost.invalid") throw Error("Use the synthetic household preview.");
  const context = await page.context().browser().newContext({ serviceWorkers: "block", reducedMotion: "reduce", isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
  const tab = await context.newPage();
  try {
    await tab.goto(origin.origin);
    await tab.locator(".bot-rail.open .pinned-bot").first().waitFor();
    const target = tab.locator(".pinned-bot").first();
    const box = await target.boundingBox();
    const client = await context.newCDPSession(tab);
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
    try { await tab.getByRole("menu").waitFor({ timeout: 3000 }); }
    finally { await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); }
    await tab.getByRole("menu").waitFor();
    if (!await tab.locator(".bot-rail.open").isVisible()) throw Error("Long-press opened the conversation.");
    const path = `${outputDir}/web-home-touch-menu.png`;
    await tab.screenshot({ path, animations: "disabled" });
    // Base UI protects the opening gesture from outside dismissal for 500 ms.
    await tab.waitForTimeout(550);
    const dismissalTarget = await tab.evaluate(() => {
      const element = document.elementFromPoint(380, 820);
      return { tag: element?.tagName, backdrop: element?.hasAttribute("data-base-ui-inert") };
    });
    if (!dismissalTarget.backdrop) throw Error("The menu backdrop is behind the home list.");
    await tab.touchscreen.tap(380, 820);
    await tab.getByRole("menu").waitFor({ state: "hidden" });
    if (!await tab.locator(".bot-rail.open").isVisible()) throw Error("Dismissing the menu opened the conversation.");
    return { touchLongPress: true, homeStayedOpen: true, dismissalTarget, path };
  } finally { await context.close(); }
}
