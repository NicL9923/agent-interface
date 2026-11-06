// @vitest-environment jsdom
import { act, createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountRoot } from "./ui-harness";
import { quietConsoleErrors } from "./act-guard";

// Each test loads its own copy, so the page's dedupe and cap start empty, as on a fresh load.
async function load(signedIn = true) {
  vi.resetModules();
  const api = await import("../src/client-api");
  const reports = await import("../src/app/error-reports");
  const { RootBoundary } = await import("../src/app/RootBoundary");
  api.setCsrf(signedIn ? "token" : "");
  return { api, reports, RootBoundary };
}
let fetch: ReturnType<typeof vi.fn>;
const sent = () => fetch.mock.calls.map(([url, init]) => ({ url, headers: Object.fromEntries(new Headers((init as RequestInit).headers)), body: JSON.parse(String((init as RequestInit).body)) }));
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
beforeEach(() => {
  fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  quietConsoleErrors();
  history.replaceState(null, "", "/?bot=secret-room#draft");
});

describe("root error boundary", () => {
  it("replaces a crashed app with a reload screen and reports the crash with its component stack", async () => {
    const { RootBoundary } = await load();
    function Broken(): never { throw new TypeError("rows is undefined"); }
    const { container, render } = mountRoot();
    await render(createElement(RootBoundary, null, createElement(Broken)));
    await settle();
    expect(container.querySelector('[role="alert"] h1')?.textContent).toBe("Something went wrong");
    expect(container.textContent).toContain("Your message drafts are kept.");
    const reload = container.querySelector<HTMLButtonElement>('button[data-slot="button"]');
    expect(reload?.textContent).toBe("Reload");
    const [report] = sent();
    expect(report.url).toBe("/api/client-errors");
    expect(report.headers["x-csrf-token"]).toBe("token");
    expect(report.body).toMatchObject({ kind: "render", message: "TypeError: rows is undefined", route: "/" });
    // The route carries neither the query nor the hash.
    expect(JSON.stringify(report.body)).not.toContain("secret-room");
    expect(report.body.stack).toContain("Broken");
  });

  it("renders its children while nothing fails", async () => {
    const { RootBoundary } = await load();
    const { container, render } = mountRoot();
    await render(createElement(RootBoundary, null, createElement("p", null, "Home")));
    expect(container.textContent).toBe("Home");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("client error reports", () => {
  it("reports uncaught errors and unhandled rejections from the window", async () => {
    const { reports } = await load();
    // A stand-in window: the test runner treats errors dispatched on the real one as its own failures.
    const page = new EventTarget();
    const window = page as unknown as Window;
    const stop = reports.installErrorReporting(window);
    window.dispatchEvent(new ErrorEvent("error", { error: new RangeError("bad index"), message: "bad index" }));
    const rejection = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(rejection, "reason", { value: "socket closed" });
    window.dispatchEvent(rejection);
    // A cross-origin script's opaque error says nothing worth sending.
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
    stop();
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("after stop") }));
    await settle();
    expect(sent().map(report => [report.body.kind, report.body.message])).toEqual([
      ["error", "RangeError: bad index"], ["rejection", "socket closed"]]);
  });

  it("strips URL queries and hashes from what it sends, keeping stack line numbers", async () => {
    const { reports } = await load();
    const cause = new Error("load failed for /api/search?q=SENTINEL#private-draft");
    cause.stack = "Error: load failed\n    at search (https://app.example.invalid/assets/index-abc.js?v=SENTINEL:10:5)";
    reports.reportClientError("error", cause);
    await settle();
    const [report] = sent();
    expect(JSON.stringify(report.body)).not.toMatch(/SENTINEL|private-draft/);
    expect(report.body.message).toBe("Error: load failed for /api/search");
    expect(report.body.stack).toContain("assets/index-abc.js:10:5");
  });

  it("sends nothing while signed out or for a chunk failure the screens already handle", async () => {
    const signedOut = await load(false);
    signedOut.reports.reportClientError("error", new Error("before sign-in"));
    const { reports } = await load();
    reports.reportClientError("rejection", new TypeError("Failed to fetch dynamically imported module: /assets/Find-OLD.js"));
    reports.reportClientError("render", new TypeError("Importing a module script failed."));
    await settle();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends each distinct report once and stops at the page's share", async () => {
    const { reports } = await load();
    const same = new Error("same");
    for (let index = 0; index < 3; index++) reports.reportClientError("error", same);
    for (let index = 0; index < 10; index++) reports.reportClientError("error", `failure ${index}`);
    await settle();
    expect(sent().map(report => report.body.message)).toEqual(["Error: same", "failure 0", "failure 1", "failure 2", "failure 3"]);
    expect(reports.MAX_REPORTS_PER_PAGE).toBe(5);
  });

  it("trims to the server's bounds and never throws, even when the report cannot be sent", async () => {
    const { reports } = await load();
    fetch.mockRejectedValue(new TypeError("offline"));
    const huge = new Error("x".repeat(5000));
    huge.stack = "y".repeat(20_000);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => reports.reportClientError("error", huge)).not.toThrow();
    expect(() => reports.reportClientError("rejection", circular)).not.toThrow();
    await settle();
    const [first, second] = sent().map(report => report.body);
    expect([first.message.length, first.stack.length]).toEqual([1024, 8192]);
    expect(second.message).toBe("[object Object]");
  });

  it("names the release from the built entry script", async () => {
    const { reports } = await load();
    const script = Object.assign(document.createElement("script"), { type: "module", src: "/assets/index-DjeCT2iD.js" });
    document.head.append(script);
    reports.reportClientError("error", new Error("built"));
    script.remove();
    await settle();
    expect(sent()[0].body.release).toBe("index-DjeCT2iD");
  });
});
