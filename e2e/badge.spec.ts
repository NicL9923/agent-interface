import { assistants, expect, setActivity, signIn, test } from "./fixtures.js";

/**
 * The installed app's badge, through a real service worker. The page asks the worker to write it, so one writer
 * orders the page's counts with the worker's own steps at every change of account (see src/app/badge.ts and the
 * top of scripts/service-worker.js). Full Chromium runs this project: the headless shell crashes the page when a
 * service worker calls the badge API (see playwright.config.ts). The calls are recorded and passed on to the real API.
 */
type Counts = { calls: string[] };
const watchPages = () => {
  // Every badge call the page itself makes, kept across reloads. A page a worker controls makes none.
  const calls: string[] = (window as unknown as { pageBadge: string[] }).pageBadge = [];
  for (const name of ["setAppBadge", "clearAppBadge"] as const) {
    const real = navigator[name].bind(navigator);
    navigator[name] = ((...args: [number?]) => { calls.push(`${name}(${args.join("")})`); return real(...args); }) as never;
  }
};

test("the worker writes the badge in the order of the account words, and the page writes none while it controls it", async ({ context, page }) => {
  let crashed = false;
  page.on("crash", () => { crashed = true; });
  await context.addInitScript(watchPages);
  // Member one's page counts one assistant waiting on a decision.
  await setActivity("ranch", "waiting");
  await signIn(page);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const [worker] = context.serviceWorkers();
  expect(worker, "the service worker").toBeDefined();
  await worker!.evaluate(() => {
    const calls: string[] = (self as unknown as Counts).calls = [];
    for (const name of ["setAppBadge", "clearAppBadge"] as const) {
      const real = navigator[name].bind(navigator);
      navigator[name] = ((...args: [number?]) => { calls.push(`${name}(${args.join("")})`); return real(...args); }) as never;
    }
  });
  const workerCalls = () => worker!.evaluate(() => (self as unknown as Counts).calls);
  const pageCalls = () => page.evaluate(() => (window as unknown as { pageBadge: string[] }).pageBadge);

  // A page the worker controls from its first frame: its count reaches the badge through the worker.
  await page.reload();
  await expect(assistants(page).getByRole("button", { name: /Ranch Hand/ })).toBeVisible();
  await expect.poll(workerCalls).toContain("setAppBadge(1)");
  expect(await pageCalls()).toEqual([]);

  // Member one signs out and member two signs in: the old account's clear and the new account's count are
  // ordered by the worker, so the badge ends at member two's count, however the two writers would have raced.
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menu", { name: "Account" }).getByRole("menuitem", { name: "Sign out" }).click();
  await page.getByRole("alertdialog", { name: "Sign out?" }).getByRole("button", { name: "Sign out" }).dispatchEvent("click");
  await expect(page.getByRole("button", { name: "Enter local workspace" })).toBeVisible();
  await expect.poll(async () => (await workerCalls()).at(-1)).toBe("clearAppBadge()");
  await page.getByLabel("Sign in as").selectOption("two");
  await page.getByRole("button", { name: "Enter local workspace" }).click();
  await expect(assistants(page).getByRole("button", { name: /Ranch Hand/ })).toBeVisible();
  await expect.poll(async () => (await workerCalls()).at(-1)).toBe("setAppBadge(1)");
  // Idle: nothing more arrives, the last word is a count, and the page never wrote the badge itself.
  await page.waitForTimeout(500);
  expect((await workerCalls()).at(-1)).toBe("setAppBadge(1)");
  expect(await pageCalls()).toEqual([]);

  // Nothing is waiting any more: the next page's count is zero and the badge clears.
  await setActivity("ranch", "idle");
  await page.reload();
  await expect(assistants(page).getByRole("button", { name: /Ranch Hand/ })).toBeVisible();
  await expect.poll(async () => (await workerCalls()).at(-1)).toBe("clearAppBadge()");
  expect(crashed).toBe(false);
});
