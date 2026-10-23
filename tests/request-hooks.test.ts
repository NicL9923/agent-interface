// @vitest-environment jsdom
import { act, createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client-api";
import { useAction } from "../src/app/use-action";
import { useResource, type Resource } from "../src/app/use-resource";
import { advance, mountRoot } from "./ui-harness";

vi.mock("../src/client-api", async original => ({ ...await original<typeof import("../src/client-api")>(), api: vi.fn() }));

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const signalOf = (call: number) => (vi.mocked(api).mock.calls[call][1] as RequestInit).signal!;

describe("useResource", () => {
  let latest: Resource<string>;
  let view: ReturnType<typeof mountRoot>;
  function Probe({ path, ...options }: { path: string | null } & Parameters<typeof useResource<string>>[1]) {
    latest = useResource<string>(path, options);
    return null;
  }
  const show = (path: string | null, options: Parameters<typeof useResource<string>>[1] = {}) => view.render(createElement(Probe, { path, ...options }));
  beforeEach(() => {
    vi.mocked(api).mockReset();
    view = mountRoot();
  });

  it("stores the result and keeps it while a reload runs", async () => {
    const reload = deferred<string>();
    vi.mocked(api).mockResolvedValueOnce("first").mockReturnValueOnce(reload.promise);
    await show("/a");
    expect(latest).toMatchObject({ data: "first", loading: false, error: "" });
    let settled!: Promise<void>;
    await act(async () => { settled = latest.reload(); });
    expect(latest).toMatchObject({ data: "first", loading: true });
    await act(async () => { reload.resolve("second"); await settled; });
    expect(latest).toMatchObject({ data: "second", loading: false });
  });

  it("ignores a slow result for a path that is no longer shown, and aborts its request", async () => {
    const slow = deferred<string>();
    vi.mocked(api).mockReturnValueOnce(slow.promise).mockResolvedValueOnce("b data");
    await show("/a");
    await show("/b");
    expect(signalOf(0).aborted).toBe(true);
    await act(async () => slow.resolve("a data"));
    expect(latest).toMatchObject({ data: "b data", loading: false });
  });

  it("drops the data of the old path while the new one loads", async () => {
    const next = deferred<string>();
    vi.mocked(api).mockResolvedValueOnce("a data").mockReturnValueOnce(next.promise);
    await show("/a");
    await show("/b");
    expect(latest.data).toBeNull();
    await show(null);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("does not let a load that was running overwrite data set after it started", async () => {
    const slow = deferred<string>();
    vi.mocked(api).mockReturnValueOnce(slow.promise);
    await show("/a");
    await act(async () => latest.setData("fresher"));
    await act(async () => slow.resolve("older"));
    expect(latest).toMatchObject({ data: "fresher", loading: false });
  });

  it("aborts the load when it unmounts", async () => {
    vi.mocked(api).mockReturnValueOnce(deferred<string>().promise);
    await show("/a");
    expect(signalOf(0).aborted).toBe(false);
    await act(async () => view.root.unmount());
    expect(signalOf(0).aborted).toBe(true);
  });

  it("reports a mapped error and clears it on the next successful load", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("raw")).mockResolvedValueOnce("ok");
    await show("/a", { errorMessage: () => "Could not load." });
    expect(latest).toMatchObject({ data: null, error: "Could not load.", loading: false });
    await act(async () => { await latest.reload(); });
    expect(latest).toMatchObject({ data: "ok", error: "" });
  });

  it("uses a custom loader with the path and an abort signal, and drops its result for an old path", async () => {
    const slow = deferred<string>();
    const signals: AbortSignal[] = [];
    const load = vi.fn((path: string, signal: AbortSignal) => { signals.push(signal); return path === "/a" ? slow.promise : Promise.resolve("b text"); });
    await show("/a", { load });
    await show("/b", { load });
    expect(load.mock.calls.map(([path]) => path)).toEqual(["/a", "/b"]);
    expect(signals[0].aborted).toBe(true);
    await act(async () => slow.resolve("a text"));
    expect(latest).toMatchObject({ data: "b text", error: "" });
    expect(api).not.toHaveBeenCalled();
  });

  it("rejects an unusable response through validate", async () => {
    vi.mocked(api).mockResolvedValueOnce("");
    await show("/a", { validate: value => { if (!value) throw new Error("Incomplete."); } });
    expect(latest).toMatchObject({ data: null, error: "Incomplete." });
  });

  it("polls quietly without stacking requests or raising loading", async () => {
    vi.useFakeTimers();
    const slow = deferred<string>();
    vi.mocked(api).mockResolvedValueOnce("first").mockReturnValueOnce(slow.promise);
    await show("/a", { pollMs: 1000 });
    await advance(1000);
    expect(api).toHaveBeenCalledTimes(2);
    expect(latest.loading).toBe(false);
    await advance(3000);
    expect(api).toHaveBeenCalledTimes(2);
    await act(async () => slow.resolve("second"));
    expect(latest.data).toBe("second");
  });

  it("settles loading at once when skip answers instead of a request", async () => {
    await show("/a", { skip: () => "You're offline." });
    expect(api).not.toHaveBeenCalled();
    expect(latest).toMatchObject({ loading: false, error: "You're offline." });
  });

  it("makes no request without a path", async () => {
    await show(null);
    expect(api).not.toHaveBeenCalled();
    expect(latest).toMatchObject({ data: null, loading: false });
  });
});

describe("useAction", () => {
  let latest: ReturnType<typeof useAction>;
  let view: ReturnType<typeof mountRoot>;
  function Probe() {
    latest = useAction();
    return null;
  }
  beforeEach(async () => {
    view = mountRoot();
    await view.render(createElement(Probe));
  });

  it("blocks a second run while one is in flight", async () => {
    const first = deferred<string>();
    const work = vi.fn(() => first.promise);
    let pending!: Promise<string | undefined>;
    await act(async () => { pending = latest.run(work); });
    expect(latest.busy).toBe(true);
    const second = vi.fn(async () => "second");
    await act(async () => { expect(await latest.run(second)).toBeUndefined(); });
    expect(second).not.toHaveBeenCalled();
    await act(async () => { first.resolve("done"); await pending; });
    expect(latest.busy).toBe(false);
    await act(async () => { await latest.run(second); });
    expect(second).toHaveBeenCalledOnce();
  });

  it("keeps errors and notices apart, and clears both when the next run starts", async () => {
    await act(async () => { await latest.run(async () => "ok", { success: "Saved." }); });
    expect(latest).toMatchObject({ notice: "Saved.", error: "" });
    await act(async () => { await latest.run(async () => { throw new Error("Nope."); }); });
    expect(latest).toMatchObject({ notice: "", error: "Nope." });
  });

  it("lets onError choose the text, or show nothing with null", async () => {
    await act(async () => { await latest.run(async () => { throw new Error("raw"); }, { onError: () => "Friendly." }); });
    expect(latest.error).toBe("Friendly.");
    await act(async () => { await latest.run(async () => { throw new Error("raw"); }, { onError: () => null }); });
    expect(latest.error).toBe("");
  });

  it("calls onSuccess with the result", async () => {
    const onSuccess = vi.fn();
    await act(async () => { await latest.run(async () => 7, { onSuccess }); });
    expect(onSuccess).toHaveBeenCalledWith(7);
  });

  it("drops the result of work that was reset, and frees the action for a new run", async () => {
    const stale = deferred<string>();
    const onSuccess = vi.fn();
    let pending!: Promise<unknown>;
    await act(async () => { pending = latest.run(() => stale.promise, { success: "Stale.", onSuccess }); });
    await act(async () => latest.reset());
    expect(latest.busy).toBe(false);
    const fresh = vi.fn(async () => "fresh");
    await act(async () => { await latest.run(fresh, { success: "Fresh." }); });
    await act(async () => { stale.resolve("late"); await pending; });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(latest).toMatchObject({ busy: false, notice: "Fresh." });
  });

  it("ignores work that finishes after unmount, and says so through the context", async () => {
    const late = deferred<string>();
    const onSuccess = vi.fn();
    let current: (() => boolean) | undefined;
    let pending!: Promise<unknown>;
    await act(async () => { pending = latest.run(async context => { current = context.current; return late.promise; }, { onSuccess }); });
    expect(current!()).toBe(true);
    await act(async () => view.root.unmount());
    await act(async () => { late.resolve("late"); await pending; });
    expect(current!()).toBe(false);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
