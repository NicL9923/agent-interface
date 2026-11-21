import {
  test as base,
  expect,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
} from "@playwright/test";
import { controlPort } from "./ports.js";

const controlUrl = `http://127.0.0.1:${controlPort}/csp-violations`;
/** Clears recorded violations and puts the scripted conversations back as they started. */
const resetServer = () => fetch(controlUrl, { method: "DELETE" });
const violations = async () => (await (await fetch(controlUrl)).json()) as unknown[];
/**
 * Makes the server answer sw.js and the app shell as a new release would, until the next test starts.
 * With `installs: false` the new worker refuses to install. The new shell carries `meta[name=release]`.
 */
export const deployNextRelease = ({ installs = true } = {}) =>
  fetch(`http://127.0.0.1:${controlPort}/next-release${installs ? "" : "?install=fail"}`, {
    method: "POST",
  });
/** Gives an assistant this roster activity from the next bootstrap on, such as "waiting", which counts on the app badge, until the next test starts. */
export const setActivity = (botId: string, state: string) =>
  fetch(
    `http://127.0.0.1:${controlPort}/activity?bot=${encodeURIComponent(botId)}&state=${encodeURIComponent(state)}`,
    { method: "POST" },
  );
/** The files the browser uploaded since the test started, with their bytes as base64. */
export const uploadedFiles = async () =>
  (await (await fetch(`http://127.0.0.1:${controlPort}/uploads`)).json()) as {
    name: string;
    mime: string;
    base64: string;
  }[];
export const enableGroupCatalog = () =>
  fetch(`http://127.0.0.1:${controlPort}/group-catalog`, { method: "POST" });
/** Makes the runtime a Hermes with settings, routines, automation and live voice, until the next test starts. See e2e/server.ts. */
export const enableFullHermes = () =>
  fetch(`http://127.0.0.1:${controlPort}/full-hermes`, { method: "POST" });
/** Makes Hermes refuse every upload with a 507, until the next test starts. */
export const failUploads = () =>
  fetch(`http://127.0.0.1:${controlPort}/upload-failure`, { method: "POST" });
export const releaseChat = () =>
  fetch(`http://127.0.0.1:${controlPort}/release-chat`, { method: "POST" });
/** Holds each send's admission this long before the server answers, as a slow Hermes would, until the next test starts. */
export const slowAdmission = (ms: number) =>
  fetch(`http://127.0.0.1:${controlPort}/admission-delay?ms=${ms}`, { method: "POST" });

/**
 * A signed-out page probes /api/bootstrap and Chromium logs the 401 as a console error. Nothing else is
 * excused here; a test that goes offline on purpose adds its own entries through `allowConsoleError`.
 */
const signedOutProbe = (message: ConsoleMessage) =>
  message.text().includes("401") &&
  new URL(message.location().url || "http://none").pathname === "/api/bootstrap";

/**
 * WebKit sends every request from a page the service worker controls through the worker, including the ones the
 * worker leaves to the network (scripts/service-worker.js never answers /api), and page and context routes never
 * see those requests. Chromium still routes them, so a routed test passed there and timed out only in WebKit after
 * a merge, four times. A route therefore fails at once in both browsers unless the test blocks the worker.
 */
const refuseRoutes = (target: Page | BrowserContext, kind: "page" | "context") => {
  const refuse = (url: unknown) => {
    throw new Error(
      `${kind}.route(${typeof url === "string" ? JSON.stringify(url) : String(url)}) cannot see the requests of a page ` +
        'the service worker controls in WebKit. Add test.use({ serviceWorkers: "block" }) to this test or its describe, ' +
        "or test the worker without routes.",
    );
  };
  target.route = refuse as typeof target.route;
  target.routeFromHAR = refuse as typeof target.routeFromHAR;
};

export const test = base.extend<{
  allowConsoleError: RegExp[];
  pageHealth: void;
  routesNeedBlockedWorker: void;
}>({
  allowConsoleError: [[], { option: false }],
  routesNeedBlockedWorker: [
    async ({ context, serviceWorkers }, use) => {
      if (serviceWorkers !== "block") {
        refuseRoutes(context, "context");
        // The context has no page yet, and the event reaches every page it opens, the `page` fixture's first.
        context.on("page", (page) => refuseRoutes(page, "page"));
      }
      await use();
    },
    { auto: true },
  ],
  // Every page the test opens must stay free of uncaught errors, console errors and CSP violation reports.
  pageHealth: [
    async ({ context, allowConsoleError, browserName }, use) => {
      if (browserName === "webkit")
        await context.addInitScript(() => {
          // Playwright WebKit has no push service; leave the app and its error handling real.
          if (typeof PushManager === "undefined") return;
          PushManager.prototype.getSubscription = async () => null;
          PushManager.prototype.subscribe = async () => {
            throw new Error("no push service in Playwright WebKit");
          };
        });
      const problems: string[] = [];
      const watch = (page: Page) => {
        page.on("pageerror", (error) => problems.push(`Uncaught error: ${error.message}`));
        page.on("console", (message) => {
          // Linux WebKit ignores this Chromium viewport extension and reports the ignored key as an error.
          if (
            browserName === "webkit" &&
            message.text() ===
              'Viewport argument key "interactive-widget" not recognized and ignored.'
          )
            return;
          if (
            message.type() !== "error" ||
            signedOutProbe(message) ||
            allowConsoleError.some((allowed) => allowed.test(message.text()))
          )
            return;
          problems.push(`Console error: ${message.text()} (${message.location().url})`);
        });
      };
      context.pages().forEach(watch);
      context.on("page", watch);
      await resetServer();
      await use();
      // The browser posts a report after it blocks something, so give a late one a moment to land.
      await expect
        .poll(violations, { timeout: 1000 })
        .toEqual([])
        .catch(() => {});
      expect({ problems, cspViolations: await violations() }).toEqual({
        problems: [],
        cspViolations: [],
      });
    },
    { auto: true },
  ],
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
    const boot = (await (await fetch("/api/bootstrap")).json()) as {
      csrfToken: string;
      preferences: Record<string, unknown>;
    };
    return (
      await fetch("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": boot.csrfToken },
        body: JSON.stringify({ ...boot.preferences, theme: "dark" }),
      })
    ).status;
  });
  expect(saved).toBe(200);
  await page.reload();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
}

/** Exercise the worker's notification handler through the page on both browser engines. */
export async function tapNotification(page: Page, url: string) {
  await page.evaluate(async (address) => {
    const worker = (await navigator.serviceWorker.ready).active!;
    await new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      worker.postMessage({ type: "TEST_OPEN_CHAT", url: address }, [channel.port2]);
    });
  }, url);
}
