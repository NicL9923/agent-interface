import { expect, test } from "./fixtures.js";

// fixtures.ts refuses routes while the service worker runs, because WebKit sends a controlled page's requests past
// them. The refusal must name the fix and cover each way a test registers a route, on every context however made.
test("a route registered while the service worker runs fails at once and names the fix", async ({
  page,
  context,
}) => {
  expect(() => page.route("**/api/bootstrap", () => {})).toThrow(
    `page.route("**/api/bootstrap") cannot see`,
  );
  expect(() => context.route(/\/api\//, () => {})).toThrow(`context.route(/\\/api\\//)`);
  expect(() => page.routeFromHAR("recorded.har")).toThrow(
    'Add test.use({ serviceWorkers: "block" })',
  );
});

test.describe("with the service worker blocked", () => {
  test.use({ serviceWorkers: "block" });
  test("a route answers the page's request", async ({ page }) => {
    await page.route("**/api/route-guard", (route) => route.fulfill({ json: { routed: true } }));
    await page.goto("/");
    expect(
      await page.evaluate(async () => (await (await fetch("/api/route-guard")).json()) as unknown),
    ).toEqual({ routed: true });
  });
});

test("a context the test makes itself refuses routes unless it blocks the worker", async ({
  browser,
}) => {
  const open = await browser.newContext();
  const blocked = await browser.newContext({ serviceWorkers: "block" });
  try {
    expect(() => open.route("**/api/auth/config", () => {})).toThrow(
      'pass serviceWorkers: "block" to browser.newContext',
    );
    expect(() => blocked.route("**/api/auth/config", () => {})).not.toThrow();
    const page = await blocked.newPage();
    await page.route("**/api/route-guard", (route) => route.fulfill({ json: { routed: true } }));
    await page.goto("/");
    expect(
      await page.evaluate(async () => (await (await fetch("/api/route-guard")).json()) as unknown),
    ).toEqual({ routed: true });
  } finally {
    await Promise.all([open.close(), blocked.close()]);
  }
});

// A fixture override that routes before the test starts is refused the same way.
test.extend({
  context: async ({ context }, use) => {
    expect(() => context.route("**/api/bootstrap", () => {})).toThrow(
      `context.route("**/api/bootstrap") cannot see`,
    );
    await use(context);
  },
})("a context fixture's route while the worker runs fails during setup", () => {});
