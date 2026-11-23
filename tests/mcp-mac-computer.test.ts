import { EventEmitter } from "node:events";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { loadConfig } from "../src/server/config.js";
import { MacBroker, type MacState } from "../src/server/mac-link.js";
import { ComputerLeaseLock, createComputerMcpTools } from "../src/server/mcp/computer-tools.js";
import {
  createMacMcpTools,
  type McpToolContext,
  type McpToolResult,
} from "../src/server/mcp/mac-tools.js";
import { Store } from "../src/server/store.js";
import type { MacDevice } from "../src/server/store-macs.js";

const one = {
  botId: "patch",
  ownerId: "local-one",
  shared: false,
  scheduled: false,
  sessionKey: "patch-chat",
};
const two = {
  botId: "diary",
  ownerId: "local-two",
  shared: false,
  scheduled: false,
  sessionKey: "diary-chat",
};
const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==";
const fail = (code: string, message?: string) => ({
  isError: true,
  structuredContent: { ok: false, error: { code, ...(message && { message }) } },
});
const handoffInput = {
  reason: " The site needs  your sign-in. ",
  what_to_do: "Sign in, then hand control back.",
};

const macFixtures: { broker: MacBroker; store: Store }[] = [];
afterEach(() => {
  for (const { broker, store } of macFixtures.splice(0)) {
    broker.close();
    store.close();
  }
  vi.useRealTimers();
});

function macFixture() {
  const store = new Store(":memory:");
  const config = loadConfig({ LOCAL_DEV_AUTH: "true", APP_ORIGIN: "http://127.0.0.1:3000" });
  const broker = new MacBroker(store, config, Fastify().log);
  macFixtures.push({ broker, store });
  for (const ctx of [one, two]) {
    store.user({
      id: ctx.ownerId,
      name: ctx.ownerId,
      email: `${ctx.ownerId.slice(6)}@localhost.invalid`,
    });
    store.savePresentation(ctx.botId, { shared: false, ownerId: ctx.ownerId });
  }
  const own = store.macs.enroll(one.ownerId, { name: "Studio" })!.device;
  const other = store.macs.enroll(two.ownerId, { name: "Other desk" })!.device;
  const tools = createMacMcpTools({ store, relay: broker });
  return { store, broker, own, other, tools };
}

class MacSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly requests: Record<string, unknown>[] = [];
  private readonly responses = new Map<string, unknown>();

  constructor(broker: MacBroker, device: MacDevice, state: MacState) {
    super();
    broker.attach(device, this as unknown as WebSocket);
    this.receive({ type: "hello", protocol: 1, state });
  }

  respond(action: string, value: unknown) {
    this.responses.set(action, value);
  }

  send(data: string) {
    const request = JSON.parse(data);
    if (request.type !== "invoke") return;
    this.requests.push(request);
    if (!this.responses.has(request.action))
      throw new Error(`Unexpected Mac action ${request.action}`);
    this.receive({
      type: "result",
      id: request.id,
      ok: true,
      value: this.responses.get(request.action),
    });
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }

  private receive(message: Record<string, unknown>) {
    this.emit("message", Buffer.from(JSON.stringify(message)), false);
  }
}

const macState = (assistantId: string): MacState => ({
  paused: false,
  screenLocked: false,
  screenPermission: "granted",
  folders: [{ name: "dev", path: "/Users/one/dev" }],
  grants: [{ assistantId, abilities: ["files_read", "screenshot"], unattended: false }],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const image = { type: "image", mimeType: "image/png", data: pngBase64 };
function expectScreenshot(result: McpToolResult) {
  expect(result.structuredContent).toEqual({ ok: true, value: { width: 1, height: 1 } });
  expect(result.content).toContainEqual(image);
  expect(result.content.find((item) => item.type === "text")?.text).not.toContain(pngBase64);
}

describe("direct Mac MCP tools", () => {
  it("hides and refuses every tool for a shared bot or a bot without an owner", async () => {
    const { tools, own } = macFixture();
    for (const ctx of [
      { ...one, shared: true },
      { ...one, ownerId: undefined },
    ]) {
      expect(tools.listTools(ctx)).toEqual([]);
      for (const { name } of tools.listTools(one)) {
        expect(await tools.callTool(ctx, name, { device: own.id })).toMatchObject(
          fail(
            "assistant_not_personal",
            "Only the Mac owner's personal bot may use their linked Mac.",
          ),
        );
      }
    }
  });

  it("refuses a stale or mismatched session even for a device list", async () => {
    const { tools, store } = macFixture();
    const refused = async (ctx: McpToolContext) => {
      expect(tools.listTools(ctx)).toEqual([]);
      expect(await tools.callTool(ctx, "mac_list", {})).toMatchObject(
        fail("assistant_not_personal"),
      );
    };
    await refused({ ...one, ownerId: two.ownerId });
    store.savePresentation(one.botId, { shared: true, ownerId: one.ownerId });
    await refused(one);
  });

  it("lists only the owner's devices and makes another member's Mac indistinguishable from a nonexistent Mac", async () => {
    const { tools, own, other, broker } = macFixture();
    const socket = new MacSocket(broker, other, macState(two.botId));
    expect((await tools.callTool(one, "mac_list", {})).structuredContent).toEqual({
      ok: true,
      value: { macs: [{ name: own.name, online: false, lastSeenAt: null }] },
    });
    for (const device of [other.id, other.name, "unknown Mac"]) {
      expect(
        await tools.callTool(one, "mac_read_file", { device, path: "secret.txt" }),
      ).toMatchObject(fail("mac_not_found", "Mac not found"));
    }
    expect(socket.requests).toEqual([]);
  });

  it("uses the live broker for the owner's granted files and screenshots", async () => {
    const { tools, own, broker } = macFixture();
    const socket = new MacSocket(broker, own, macState(one.botId));
    socket.respond("read_file", { content: "the notes", encoding: "utf8" });
    socket.respond("screenshot", { pngBase64, width: 1, height: 1 });
    expect(tools.listTools(one).map((tool) => tool.name)).toEqual([
      "mac_list",
      "mac_run",
      "mac_read_file",
      "mac_write_file",
      "mac_list_dir",
      "mac_screenshot",
    ]);
    const args = { path: "notes.txt", offset: 0, length: 9 };
    expect(
      (await tools.callTool(one, "mac_read_file", { device: own.name.toLowerCase(), ...args }))
        .structuredContent,
    ).toEqual({ ok: true, value: { content: "the notes", encoding: "utf8" } });
    expect(socket.requests[0]).toMatchObject({
      action: "read_file",
      assistantId: one.botId,
      scheduled: false,
      args,
    });
    expectScreenshot(await tools.callTool(one, "mac_screenshot", { device: own.id }));
    expect(socket.requests[1]).toMatchObject({
      action: "screenshot",
      assistantId: one.botId,
      args: {},
    });
  });

  it("preserves device grants and treats a call without attendance metadata as unattended", async () => {
    const { tools, own, broker } = macFixture();
    const socket = new MacSocket(broker, own, macState(one.botId));
    expect(
      await tools.callTool(one, "mac_write_file", { path: "notes.txt", content: "changed" }),
    ).toMatchObject(fail("not_allowed"));
    expect(
      await tools.callTool({ ...one, scheduled: undefined }, "mac_read_file", {
        path: "notes.txt",
      }),
    ).toMatchObject(fail("unattended_not_allowed"));
    expect(socket.requests).toEqual([]);
  });

  it("reports offline devices and immediately refuses a revoked target", async () => {
    const { tools, own, broker, store } = macFixture();
    const args = { device: own.id, path: "notes.txt" };
    expect(await tools.callTool(one, "mac_read_file", args)).toMatchObject(fail("mac_offline"));
    const socket = new MacSocket(broker, own, macState(one.botId));
    expect(store.macs.revoke(own.id, one.ownerId)).toBe(true);
    expect(await tools.callTool(one, "mac_read_file", args)).toMatchObject(
      fail("mac_not_found", "Mac not found"),
    );
    expect(socket.requests).toEqual([]);
  });

  it("rejects invalid tool arguments and cancellation before dispatch", async () => {
    const { tools, own, broker } = macFixture();
    const socket = new MacSocket(broker, own, macState(one.botId));
    expect(await tools.callTool(one, "mac_open_app", {})).toMatchObject(fail("unknown_tool"));
    expect(
      await tools.callTool(one, "mac_run", { command: "pwd", timeoutSeconds: 601 }),
    ).toMatchObject(fail("invalid_arguments"));
    expect(
      await tools.callTool(one, "mac_read_file", { path: "notes.txt", ownerId: two.ownerId }),
    ).toMatchObject(fail("invalid_arguments"));
    expect(
      await tools.callTool(one, "mac_read_file", { path: "notes.txt" }, AbortSignal.abort()),
    ).toMatchObject(fail("cancelled"));
    expect(socket.requests).toEqual([]);
  });
});

describe("shared computer MCP tools", () => {
  it("serializes browser and desktop actions in FIFO order across bots and providers", async () => {
    const started = deferred<void>();
    const finishClick = deferred<void>();
    const actions: unknown[] = [];
    const a = createComputerMcpTools({
      backend: {
        async execute(action, ctx) {
          if (action.name !== "computer_click") throw new Error(`Unexpected action ${action.name}`);
          actions.push([ctx.botId, action]);
          started.resolve();
          await finishClick.promise;
          actions.push("click complete");
          return {};
        },
      },
    });
    const b = createComputerMcpTools({
      backend: {
        async execute(action, ctx) {
          if (action.name !== "browser_navigate" && action.name !== "browser_snapshot")
            throw new Error(`Unexpected action ${action.name}`);
          actions.push([ctx.botId, action]);
          return {};
        },
      },
    });
    const click = a.callTool(one, "computer_click", { x: 20, y: 30 });
    const navigate = b.callTool(two, "browser_navigate", { url: "https://example.com/" });
    const snapshot = b.callTool(one, "browser_snapshot", {});
    await started.promise;
    expect(actions).toEqual([[one.botId, { name: "computer_click", args: { x: 20, y: 30 } }]]);
    finishClick.resolve();
    await Promise.all([click, navigate, snapshot]);
    expect(actions.slice(1)).toEqual([
      "click complete",
      [two.botId, { name: "browser_navigate", args: { url: "https://example.com/" } }],
      [one.botId, { name: "browser_snapshot", args: {} }],
    ]);
  });

  it("releases a failed action for the next queued bot", async () => {
    const tools = createComputerMcpTools({
      lock: new ComputerLeaseLock(),
      backend: {
        async execute(action) {
          if (action.name === "computer_click") throw new Error("The display disconnected.");
          if (action.name === "computer_status") return { running: true };
          throw new Error(`Unexpected action ${action.name}`);
        },
      },
    });
    const click = tools.callTool(one, "computer_click", { x: 0, y: 0 });
    const status = tools.callTool(two, "computer_status", {});
    expect(await click).toMatchObject(fail("failed", "The display disconnected."));
    expect((await status).structuredContent).toEqual({ ok: true, value: { running: true } });
  });

  it("aborts an expired lease and waits for backend recovery before releasing the next action", async () => {
    vi.useFakeTimers();
    expect(() => new ComputerLeaseLock({ leaseTtlMs: 0 })).toThrow(RangeError);
    const lock = new ComputerLeaseLock({ leaseTtlMs: 50 });
    const recovering = deferred<void>();
    const recovered = deferred<void>();
    const next = vi.fn(async () => "second action");
    const first = expect(
      lock.run(async (signal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        recovering.resolve();
        await recovered.promise;
      }),
    ).rejects.toThrow("The computer action timed out.");
    const second = lock.run(next);
    await vi.advanceTimersByTimeAsync(50);
    await first;
    await recovering.promise;
    expect(next).not.toHaveBeenCalled();
    recovered.resolve();
    await expect(second).resolves.toBe("second action");
  });

  it("drops a cancelled queued action without dispatching it", async () => {
    const lock = new ComputerLeaseLock();
    const finishFirst = deferred<void>();
    const first = lock.run(() => finishFirst.promise);
    const cancellation = new AbortController();
    const skipped = vi.fn(async () => {
      throw new Error("Cancelled action ran");
    });
    const cancelled = expect(lock.run(skipped, cancellation.signal)).rejects.toThrow(
      "Turn stopped",
    );
    const third = lock.run(async () => "third action");
    cancellation.abort(new Error("Turn stopped"));
    await cancelled;
    finishFirst.resolve();
    await first;
    await expect(third).resolves.toBe("third action");
    expect(skipped).not.toHaveBeenCalled();
  });

  it("blocks clicks during handoff, drops stale queued input, and accepts fresh input after handback", async () => {
    const active = deferred<void>();
    const firstAction = deferred<void>();
    const handBack = deferred<"handed_back">();
    const cards = deferred<unknown>();
    const clicks: unknown[] = [];
    const tools = createComputerMcpTools({
      lock: new ComputerLeaseLock(),
      backend: {
        async execute(action, ctx) {
          if (action.name === "computer_status") {
            await firstAction.promise;
            return { running: true };
          }
          if (action.name !== "computer_click") throw new Error(`Unexpected action ${action.name}`);
          clicks.push([ctx.botId, action.args]);
          return {};
        },
      },
      async onHandoffRequest(ctx, card) {
        cards.resolve([ctx.sessionKey, card]);
        active.resolve();
        return handBack.promise;
      },
    });
    const status = tools.callTool(two, "computer_status", {});
    const handoff = tools.callTool(one, "computer_request_handoff", handoffInput);
    const staleClick = tools.callTool(two, "computer_click", { x: 1, y: 2 });
    firstAction.resolve();
    await status;
    await active.promise;
    expect(await cards.promise).toEqual([
      one.sessionKey,
      { reason: "The site needs your sign-in.", whatToDo: handoffInput.what_to_do },
    ]);
    expect(await tools.callTool(one, "computer_click", { x: 3, y: 4 })).toMatchObject(
      fail("handoff_active"),
    );
    expect(clicks).toEqual([]);
    handBack.resolve("handed_back");
    expect((await handoff).structuredContent).toMatchObject({
      success: true,
      status: "handed_back",
    });
    expect(await staleClick).toMatchObject(fail("control_changed"));
    expect((await tools.callTool(two, "computer_click", { x: 5, y: 6 })).isError).toBeUndefined();
    expect(clicks).toEqual([[two.botId, { x: 5, y: 6 }]]);
  });

  it("releases handoff when the request is cancelled and the card callback has finished", async () => {
    const opened = deferred<void>();
    const closed = deferred<void>();
    const cancellation = new AbortController();
    const tools = createComputerMcpTools({
      lock: new ComputerLeaseLock(),
      backend: {
        async execute(action) {
          if (action.name !== "computer_click") throw new Error(`Unexpected action ${action.name}`);
          return { clicked: action.args };
        },
      },
      async onHandoffRequest(_ctx, _card, signal) {
        opened.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        await closed.promise;
        return "cancelled";
      },
    });
    const handoff = tools.callTool(
      one,
      "computer_request_handoff",
      handoffInput,
      cancellation.signal,
    );
    await opened.promise;
    cancellation.abort();
    expect(await handoff).toMatchObject(fail("cancelled"));
    const input = { x: 1, y: 2 };
    expect(await tools.callTool(two, "computer_click", input)).toMatchObject(
      fail("handoff_active"),
    );
    closed.resolve();
    await vi.waitFor(async () => {
      expect((await tools.callTool(two, "computer_click", input)).structuredContent).toEqual({
        ok: true,
        value: { clicked: input },
      });
    });
  });

  it("validates input before dispatch and reports screenshot content to the MCP client", async () => {
    const execute = vi.fn(async () => ({ pngBase64, width: 1, height: 1 }));
    const tools = createComputerMcpTools({ lock: new ComputerLeaseLock(), backend: { execute } });
    expect(await tools.callTool(one, "computer_click", { x: -1, y: 0 })).toMatchObject(
      fail("invalid_arguments"),
    );
    expect(
      await tools.callTool(one, "browser_navigate", { url: "file:///etc/hosts" }),
    ).toMatchObject(fail("invalid_arguments"));
    expect(await tools.callTool(one, "constructor", {})).toMatchObject(fail("unknown_tool"));
    expect(execute).not.toHaveBeenCalled();
    expectScreenshot(await tools.callTool(one, "computer_screenshot", {}));
    expect(execute).toHaveBeenCalledWith(
      { name: "computer_screenshot", args: {} },
      one,
      expect.any(AbortSignal),
    );
    execute.mockResolvedValueOnce({ pngBase64: "invalid", width: 1, height: 1 });
    expect(await tools.callTool(one, "computer_screenshot", {})).toMatchObject(fail("failed"));
  });

  it("requires a card callback, a person, and valid card text for handoff", async () => {
    const execute = vi.fn(async () => {
      throw new Error("Unexpected backend call");
    });
    const onHandoffRequest = vi.fn(async () => "declined" as const);
    const lock = new ComputerLeaseLock();
    const missing = createComputerMcpTools({ lock, backend: { execute } });
    expect(missing.listTools(one).map((x) => x.name)).not.toContain("computer_request_handoff");
    expect(await missing.callTool(one, "computer_request_handoff", handoffInput)).toMatchObject(
      fail("computer_unavailable"),
    );
    const tools = createComputerMcpTools({ lock, backend: { execute }, onHandoffRequest });
    expect(
      await tools.callTool({ ...one, scheduled: true }, "computer_request_handoff", handoffInput),
    ).toMatchObject(fail("no_person"));
    expect(
      await tools.callTool(
        { ...one, sessionKey: undefined },
        "computer_request_handoff",
        handoffInput,
      ),
    ).toMatchObject(fail("no_person"));
    expect(
      await tools.callTool(one, "computer_request_handoff", { ...handoffInput, reason: "\u200b" }),
    ).toMatchObject(fail("invalid_arguments"));
    expect(onHandoffRequest).not.toHaveBeenCalled();
    expect(await tools.callTool(one, "computer_request_handoff", handoffInput)).toMatchObject(
      fail("declined"),
    );
  });

  it("times out an unanswered handoff and reopens agent admission when the card closes", async () => {
    vi.useFakeTimers();
    const tools = createComputerMcpTools({
      lock: new ComputerLeaseLock({ leaseTtlMs: 10, handoffTtlMs: 50 }),
      backend: {
        async execute(action) {
          if (action.name !== "browser_snapshot")
            throw new Error(`Unexpected action ${action.name}`);
          return { snapshot: "Sign in" };
        },
      },
      async onHandoffRequest(_ctx, _card, signal) {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return "cancelled";
      },
    });
    const handoff = tools.callTool(one, "computer_request_handoff", handoffInput);
    await vi.advanceTimersByTimeAsync(10);
    expect(await tools.callTool(two, "browser_snapshot", {})).toMatchObject(fail("handoff_active"));
    await vi.advanceTimersByTimeAsync(40);
    expect(await handoff).toMatchObject(fail("timed_out", "The computer handoff timed out."));
    expect((await tools.callTool(two, "browser_snapshot", {})).structuredContent).toEqual({
      ok: true,
      value: { snapshot: "Sign in" },
    });
  });
});
