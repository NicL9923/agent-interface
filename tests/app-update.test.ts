// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UPDATE_CHECK_MS, useAppInstall } from "../src/app/use-browser";
import { UpdateNotice } from "../src/app/UpdateNotice";
import { mountRoot } from "./ui-harness";

class Target extends EventTarget {}
let container: HTMLDivElement, root: Root, reload: ReturnType<typeof vi.fn>;
let active: { postMessage: ReturnType<typeof vi.fn> };
let worker: Target & { controller: object | null; register: ReturnType<typeof vi.fn>; ready: Promise<{ active: typeof active }> };
let registration: Target & { waiting: { postMessage: ReturnType<typeof vi.fn> } | null; installing: (Target & { state: string }) | null; update: ReturnType<typeof vi.fn> };

function Harness() {
  return createElement(UpdateNotice, { update: useAppInstall().update });
}
async function render() {
  await act(async () => root.render(createElement(Harness)));
  await act(async () => {});
}
const button = () => container.querySelector<HTMLButtonElement>(".app-update button");

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("PROD", true);
  registration = Object.assign(new Target(), { waiting: null, installing: null, update: vi.fn(async () => undefined) });
  active = { postMessage: vi.fn() };
  worker = Object.assign(new Target(), { controller: {}, register: vi.fn(async () => registration), ready: Promise.resolve({ active }) });
  vi.stubGlobal("navigator", { serviceWorker: worker });
  reload = vi.fn();
  vi.stubGlobal("location", { reload });
  ({ container, root } = mountRoot());
});

describe("app update notice", () => {
  it("asks the active worker to cache the lazy screens once the page is idle", async () => {
    await render();
    expect(active.postMessage).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(active.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "WARM" });
  });

  it("does not ask once the page closes before it is idle", async () => {
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await act(async () => root.unmount());
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(active.postMessage).not.toHaveBeenCalled();
  });

  it("shows a build already waiting and switches to it before reloading", async () => {
    registration.waiting = { postMessage: vi.fn() };
    await render();
    expect(container.textContent).toContain("Update available");
    await act(async () => button()!.click());
    expect(registration.waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(button()!.disabled).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    await act(async () => worker.dispatchEvent(new Event("controllerchange")));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("finds a build deployed while the app stays open", async () => {
    await render();
    expect(button()).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS));
    expect(registration.update).toHaveBeenCalledTimes(1);
    const installing = Object.assign(new Target(), { state: "installing" });
    registration.installing = installing;
    registration.dispatchEvent(new Event("updatefound"));
    registration.waiting = { postMessage: vi.fn() };
    installing.state = "installed";
    await act(async () => installing.dispatchEvent(new Event("statechange")));
    expect(container.textContent).toContain("Refresh to get the latest WildBots.");
  });

  it("checks again when a backgrounded app returns, at most every five minutes", async () => {
    await render();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(registration.update).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 5 * 60_000);
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  it("asks a page left on the old build to reload after another tab updates", async () => {
    await render();
    await act(async () => worker.dispatchEvent(new Event("controllerchange")));
    await act(async () => button()!.click());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("ignores first control but notices a later update from another tab", async () => {
    worker.controller = null;
    await render();
    await act(async () => worker.dispatchEvent(new Event("controllerchange")));
    expect(button()).toBeNull();
    worker.controller = {};
    await act(async () => worker.dispatchEvent(new Event("controllerchange")));
    expect(container.textContent).toContain("Update available");
    await act(async () => button()!.click());
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
