import { test as base, expect, type ConsoleMessage, type Page } from "@playwright/test";
import { controlPort } from "./ports.js";

const controlUrl = `http://127.0.0.1:${controlPort}/csp-violations`;
/** Clears recorded violations and puts the scripted conversations back as they started. */
const resetServer = () => fetch(controlUrl, { method: "DELETE" });
const violations = async () => await (await fetch(controlUrl)).json() as unknown[];
/**
 * Makes the server answer sw.js and the app shell as a new release would, until the next test starts.
 * With `installs: false` the new worker refuses to install. The new shell carries `meta[name=release]`.
 */
export const deployNextRelease = ({ installs = true } = {}) =>
  fetch(`http://127.0.0.1:${controlPort}/next-release${installs ? "" : "?install=fail"}`, { method: "POST" });
/** Holds each send's admission this long before the server answers, as a slow Hermes would, until the next test starts. */
export const slowAdmission = (ms: number) => fetch(`http://127.0.0.1:${controlPort}/admission-delay?ms=${ms}`, { method: "POST" });

/**
 * A signed-out page probes /api/bootstrap and Chromium logs the 401 as a console error. Nothing else is
 * excused here; a test that goes offline on purpose adds its own entries through `allowConsoleError`.
 */
const signedOutProbe = (message: ConsoleMessage) =>
  message.text().includes("401") && new URL(message.location().url || "http://none").pathname === "/api/bootstrap";

export const test = base.extend<{ allowConsoleError: RegExp[]; pageHealth: void }>({
  allowConsoleError: [[], { option: false }],
  // Every page the test opens must stay free of uncaught errors, console errors and CSP violation reports.
  pageHealth: [async ({ context, allowConsoleError }, use) => {
    const problems: string[] = [];
    const watch = (page: Page) => {
      page.on("pageerror", error => problems.push(`Uncaught error: ${error.message}`));
      page.on("console", message => {
        if (message.type() !== "error" || signedOutProbe(message) || allowConsoleError.some(allowed => allowed.test(message.text()))) return;
        problems.push(`Console error: ${message.text()} (${message.location().url})`);
      });
    };
    context.pages().forEach(watch);
    context.on("page", watch);
    await resetServer();
    await use();
    // The browser posts a report after it blocks something, so give a late one a moment to land.
    await expect.poll(violations, { timeout: 1000 }).toEqual([]).catch(() => {});
    expect({ problems, cspViolations: await violations() }).toEqual({ problems: [], cspViolations: [] });
  }, { auto: true }],
});

export { expect };

/** Signs in through the page as the first local household member and waits for the assistant list. */
export async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Enter local workspace" }).click();
  await expect(assistants(page)).toBeVisible();
}
export const assistants = (page: Page) => page.getByRole("region", { name: "Your assistants" });
export const conversation = (page: Page) => page.getByRole("region", { name: "Conversation" });
/** Saves the dark theme for the signed-in member, and reloads so this device keeps it for boot.js. */
export async function chooseDark(page: Page) {
  const saved = await page.evaluate(async () => {
    const boot = await (await fetch("/api/bootstrap")).json() as { csrfToken: string; preferences: Record<string, unknown> };
    return (await fetch("/api/preferences", { method: "PATCH", headers: { "Content-Type": "application/json", "X-CSRF-Token": boot.csrfToken },
      body: JSON.stringify({ ...boot.preferences, theme: "dark" }) })).status;
  });
  expect(saved).toBe(200);
  await page.reload();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
}
