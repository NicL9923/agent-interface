import { afterEach, beforeEach, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  listen: vi.fn(async () => {}),
  close: vi.fn<() => Promise<void>>(),
  log: { info: vi.fn(), error: vi.fn() },
}));
vi.mock("node:fs", () => ({ existsSync: () => false }));
vi.mock("../src/server/app.js", () => ({ createApp: async () => ({ app: server }) }));
vi.mock("../src/server/config.js", () => ({ loadConfig: () => ({}) }));
vi.mock("../src/server/hermes.js", () => ({ createHermesRuntime: () => ({}) }));
vi.mock("../src/server/store.js", () => ({ schemaVersion: 1 }));
vi.mock("../src/server/logging.js", () => ({ safeError: (error: unknown) => error }));

const signals = new Map<string | symbol, () => void>();
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  signals.clear();
  vi.spyOn(process, "on").mockImplementation((signal, listener) => {
    signals.set(signal, listener as () => void);
    return process;
  });
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("closes once across signals and clears the deadline after clean shutdown", async () => {
  let finish!: () => void;
  server.close.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  await import("../src/server/index.js");
  signals.get("SIGINT")!();
  signals.get("SIGTERM")!();
  expect(server.close).toHaveBeenCalledTimes(1);
  finish();
  await vi.advanceTimersByTimeAsync(30000);
  expect(server.log.info).toHaveBeenCalledWith("WildBots stopped");
  expect(process.exit).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("exits with failure when closing exceeds the shutdown deadline", async () => {
  server.close.mockReturnValue(new Promise<void>(() => {}));
  await import("../src/server/index.js");
  signals.get("SIGTERM")!();
  await vi.advanceTimersByTimeAsync(29999);
  expect(process.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(process.exit).toHaveBeenCalledWith(1);
  expect(server.log.error).toHaveBeenCalledWith("WildBots shutdown deadline reached");
});

it("exits with failure when cleanup rejects instead of leaving resources running", async () => {
  server.close.mockRejectedValue(new Error("cleanup failed"));
  await import("../src/server/index.js");
  signals.get("SIGTERM")!();
  await vi.advanceTimersByTimeAsync(0);
  expect(process.exit).toHaveBeenCalledWith(1);
  expect(vi.getTimerCount()).toBe(0);
});
