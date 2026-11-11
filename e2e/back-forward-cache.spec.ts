import type { Page } from "@playwright/test";
import { assistants, conversation, expect, signIn, test } from "./fixtures.js";

/**
 * A page frozen in the back-forward cache hears no storage events, and a restored one can paint before its
 * script runs. The app covers its account's screens as the page leaves (see src/app/account-epoch.ts).
 */
// Playwright's default headless shell has no back-forward cache, and Playwright turns it off in every
// Chromium it launches. Full Chromium in headless mode has one once that switch is left out. These run
// in a file of their own because a browser option needs a worker of its own.
test.use({ channel: "chromium", launchOptions: { ignoreDefaultArgs: ["--disable-back-forward-cache"] } });
type Seen = { covered: boolean; rowsVisible: boolean };
// What the page holds at `resume`, the first moment script runs on a restored page, before the app's listeners.
const watchRestores = () => {
  const seen: Seen[] = (window as unknown as { restores: Seen[] }).restores = [];
  window.addEventListener("resume", () => seen.push({
    covered: document.documentElement.hasAttribute("data-account-covered"),
    rowsVisible: [...document.querySelectorAll("button")].some(item => /Ranch Hand/.test(item.textContent ?? "") && getComputedStyle(item).visibility === "visible"),
  }), { capture: true });
};
// Another site, so leaving puts the page in the cache rather than keeping it.
const away = (page: Page) => page.goto(new URL("/api/auth/config", page.url().replace("127.0.0.1", "localhost")).href);
const restores = (page: Page) => page.evaluate(() => (window as unknown as { restores: Seen[]; kept?: boolean }).kept ? (window as unknown as { restores: Seen[] }).restores : null);

test("a page restored after a sign-out in another tab shows sign-in, and was covered from the moment it came back", async ({ context, page }) => {
  await context.addInitScript(watchRestores);
  await signIn(page);
  await assistants(page).getByRole("button", { name: /Ranch Hand/ }).click();
  await page.evaluate(() => { (window as unknown as { kept: boolean }).kept = true; });
  await away(page);
  const other = await context.newPage();
  await other.goto("/");
  await other.getByRole("button", { name: "Account" }).click();
  await other.getByRole("menu", { name: "Account" }).getByRole("menuitem", { name: "Sign out" }).click();
  await other.getByRole("alertdialog", { name: "Sign out?" }).getByRole("button", { name: "Sign out" }).click();
  await expect(other.getByRole("button", { name: "Enter local workspace" })).toBeVisible();
  await other.close();
  // A restore fires no load event.
  await page.goBack({ waitUntil: "commit" });
  await expect(page.getByRole("button", { name: "Enter local workspace" })).toBeVisible();
  // The same document, so it came from the cache, and member one's rows were never shown uncovered.
  expect(await restores(page)).toEqual([{ covered: true, rowsVisible: false }]);
  await expect(page.getByText("Ranch Hand")).toHaveCount(0);
  await expect(page.locator("html[data-account-covered]")).toHaveCount(0);
});

test("a page restored with the same account comes back as it was left", async ({ context, page }) => {
  await context.addInitScript(watchRestores);
  await signIn(page);
  await assistants(page).getByRole("button", { name: /Ranch Hand/ }).click();
  await page.getByRole("textbox", { name: "Message Ranch Hand" }).fill("Half a thought");
  await page.evaluate(() => { (window as unknown as { kept: boolean }).kept = true; });
  await away(page);
  await page.goBack({ waitUntil: "commit" });
  await expect(page.getByRole("textbox", { name: "Message Ranch Hand" })).toHaveValue("Half a thought");
  expect(await restores(page)).toEqual([{ covered: true, rowsVisible: false }]);
  await expect(page.locator("html[data-account-covered]")).toHaveCount(0);
  await expect(conversation(page).getByText("Morning. The north fence is fixed.")).toBeVisible();
});
