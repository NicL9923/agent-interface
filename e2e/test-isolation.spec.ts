import type { Page } from "@playwright/test";
import { enableFullHermes, expect, signIn, test } from "./fixtures.js";
import { controlPort } from "./ports.js";

// Every test starts from the server and fixtures as the first test found them, whatever ran before it. The tests in
// this file run in order, each after one that changed the state it checks.

const bootstrap = (page: Page) =>
  page.evaluate(
    async () =>
      (await (await fetch("/api/bootstrap")).json()) as {
        csrfToken: string;
        preferences: { theme?: string; favorites: string[] };
        capabilities: { liveVoice: { supported: boolean } };
      },
  );
const reset = () => fetch(`http://127.0.0.1:${controlPort}/csp-violations`, { method: "DELETE" });

test("an allowance one test adds is its own", ({ allowConsoleError }) => {
  allowConsoleError.push(/an error only this test excuses/);
  expect(allowConsoleError).toEqual([/an error only this test excuses/]);
});
test("the next test starts with no allowance", ({ allowConsoleError }) => {
  expect(allowConsoleError).toEqual([]);
});

test("a member saves a theme and a pin", async ({ page }) => {
  await signIn(page);
  const { csrfToken, preferences } = await bootstrap(page);
  const saved = await page.evaluate(
    async ({ csrfToken, preferences }) =>
      (
        await fetch("/api/preferences", {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
          body: JSON.stringify({ ...preferences, theme: "dark", favorites: ["ranch"] }),
        })
      ).status,
    { csrfToken, preferences },
  );
  expect(saved).toBe(200);
  expect((await bootstrap(page)).preferences).toMatchObject({
    theme: "dark",
    favorites: ["ranch"],
  });
});
test("the next test starts from the default preferences", async ({ page }) => {
  await signIn(page);
  expect((await bootstrap(page)).preferences).toMatchObject({ theme: "system", favorites: [] });
});

// Bootstrap reuses the runtime's capabilities for 1.5 s, so each read here comes right after the one before it.
test("a fixture switch reaches the next bootstrap in both directions", async ({ page }) => {
  await signIn(page);
  for (let round = 0; round < 3; round++) {
    expect((await bootstrap(page)).capabilities.liveVoice.supported).toBe(false);
    await enableFullHermes();
    expect((await bootstrap(page)).capabilities.liveVoice.supported).toBe(true);
    await reset();
  }
});

// The failed upload screen excuses the 507 its refused uploads log. The same status from another request still fails.
test.describe("an allowance for a refused request", () => {
  test.use({ serviceWorkers: "block" });
  const refuse = async (page: Page, path: string) => {
    await page.route(`**${path}`, (route) => route.fulfill({ status: 507, body: "" }));
    await page.goto("/");
    await page.evaluate(async (path) => {
      await fetch(path, { method: "POST" });
    }, path);
  };
  const uploads = { text: /status of 507/, url: /\/api\/bots\/ranch\/uploads$/ };
  test("excuses that request", async ({ page, allowConsoleError }) => {
    allowConsoleError.push(uploads);
    await refuse(page, "/api/bots/ranch/uploads");
  });
  test("does not excuse the same status from another address", async ({
    page,
    allowConsoleError,
  }) => {
    // The page health check fails this test on the console error, which is what it must do.
    test.fail();
    allowConsoleError.push(uploads);
    await refuse(page, "/api/bots/trail/uploads");
  });
});
