import { expect, test } from "./fixtures.js";

// fixtures.ts refuses routes while the service worker runs, because WebKit sends a controlled page's requests past
// them. The refusal must name the fix and cover each way a test registers a route.
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
