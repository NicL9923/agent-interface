import { vi } from "vitest";

type Row = Record<string, any>;
/** An add-on revision the transport accepts, as the adapter tests use. */
const revision = "b9cb268deffc97946ec11645aa622a7353dd0591";
export const HERMES_URL = "http://127.0.0.1:19119";
// The add-on's page size, from src/hermes/extension.py.
const PAGE_TURNS = 20;

/**
 * The add-on's history window, ported from `history_window` in src/hermes/extension.py, so a windowed open
 * here returns what Hermes would: the rows from the window's first prompt on, earlier rows only when they
 * carry files, every row with its position among visible rows, and all rows when the cut would start at
 * the first row or mid-turn.
 */
export function historyWindow(messages: Row[], sid: string, start?: string, turns = 0): { rows: Row[]; cut?: { earlier: number; context: number } } {
  const visible = messages.filter(row => row.display_kind !== "hidden");
  const identity = (index: number) => String(visible[index].app_request_id ?? visible[index].row_id ?? `${sid}-${index}`);
  let end = typeof start === "string" && start ? visible.findIndex((_, index) => identity(index) === start) : -1;
  if (end < 0) { end = visible.length; turns = Math.max(turns, PAGE_TURNS); }
  let first = end;
  while (first > 0 && turns > 0) if (visible[--first].role === "user") turns--;
  if (first === 0 || visible[first].role !== "user") return { rows: messages };
  const kept = new Set<number>();
  let prompt: number | undefined;
  for (let index = 0; index < first; index++) {
    const row = visible[index];
    if (row.role === "user") prompt = index;
    const files = row.role === "user" ? row.app_attachments : row.app_artifacts;
    if (Array.isArray(files) && files.length) {
      kept.add(index);
      if (row.role === "assistant" && prompt !== undefined) kept.add(prompt);
    }
  }
  const indexes = [...[...kept].sort((a, b) => a - b), ...Array.from({ length: visible.length - first }, (_, offset) => first + offset)];
  return { rows: indexes.map(index => ({ ...visible[index], app_index: index })), cut: { earlier: first, context: kept.size } };
}

/**
 * One Hermes gateway with the verified add-on, over a stand-in WebSocket that the real Hermes runtime
 * connects to. Only the socket is fake. Opens answer from the state when they were asked, after `openDelay`
 * milliseconds of timer time, or when a test releases them while `holdOpens` is set. A method it does not
 * script answers an error, so an unexpected call fails at its name.
 */
export function fakeHermes() {
  const sid = "live-one";
  const hermes = {
    sid,
    history: [] as Row[],
    running: false,
    runId: undefined as string | undefined,
    inflight: {} as Row,
    openRequests: [] as Row[],
    openDelay: 0,
    /** Opens waiting out `openDelay`. */
    delayed: 0,
    holdOpens: false,
    profiles: ["shared"],
    /** Every request the runtime sent, in order. */
    calls: [] as Row[],
    /** Opens waiting for a test to release them while `holdOpens` is set. */
    held: [] as { params: Row; release: () => void }[],
    sockets: [] as FakeSocket[],
    opens: () => hermes.calls.filter(call => call.method === "agent-interface.open"),
    frame(type: string, payload: Row = {}) {
      hermes.sockets.at(-1)!.receive({ method: "event", params: { session_id: sid, type, payload } });
    },
    request(method: string, id: string, params: Row = {}) {
      hermes.sockets.at(-1)!.receive({ jsonrpc: "2.0", id, method, params: { session_id: sid, ...params } });
    },
    drop() { hermes.sockets.at(-1)!.close(); },
  };
  const answerOpen = (params: Row): Row => {
    const window = params.window && !params.omit_messages ? historyWindow(hermes.history, sid, params.window.start, params.window.turns) : undefined;
    return structuredClone({
      session_id: sid, canonical_stored_session_id: "stored-one", info: { running: hermes.running },
      ...(hermes.runId ? { app_run_id: hermes.runId } : {}), inflight: hermes.inflight, open_requests: hermes.openRequests,
      executor_epoch: "epoch-one",
      messages: params.omit_messages ? [] : window ? window.rows : hermes.history,
      ...(window?.cut ? { app_window: window.cut } : {}),
    });
  };
  class FakeSocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = FakeSocket.CONNECTING;
    constructor(readonly url: string | URL) {
      super();
      hermes.sockets.push(this);
      queueMicrotask(() => { this.readyState = FakeSocket.OPEN; this.dispatchEvent(new Event("open")); });
    }
    receive(frame: unknown) {
      if (this.readyState === FakeSocket.OPEN) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
    }
    send(text: string) {
      if (this.readyState !== FakeSocket.OPEN) throw new Error("Cannot send on a closed socket.");
      const request = JSON.parse(text) as Row;
      hermes.calls.push(request);
      const reply = (result: unknown) => this.receive({ jsonrpc: "2.0", id: request.id, result });
      if (request.method === "client.capabilities") return queueMicrotask(() => reply({}));
      if (request.method === "agent-interface.capabilities")
        return queueMicrotask(() => reply({ revision, durable_admission: true, durable_events: true, canonical_open: true, executor_epoch: "epoch-one" }));
      if (request.method === "profiles.list")
        return queueMicrotask(() => reply({ profiles: hermes.profiles.map(name => ({ name, ui_meta: { agent_interface: { name } } })) }));
      if (request.method === "agent-interface.open") {
        if (!hermes.profiles.includes(request.params.profile)) return queueMicrotask(() => this.receive({ jsonrpc: "2.0", id: request.id, error: { code: 4040, message: "Unknown Hermes profile" } }));
        const value = answerOpen(request.params);
        if (hermes.holdOpens) { hermes.held.push({ params: request.params, release: () => reply(value) }); return; }
        if (hermes.openDelay) {
          hermes.delayed++;
          setTimeout(() => { hermes.delayed--; reply(value); }, hermes.openDelay);
          return;
        }
        return queueMicrotask(() => reply(value));
      }
      // Admits a send as a new task, with the run a test set, as the add-on answers once it accepted it.
      if (request.method === "agent-interface.submit")
        return queueMicrotask(() => reply({ requestId: request.params.request_id, status: "accepted", runId: hermes.runId ?? request.params.request_id }));
      queueMicrotask(() => this.receive({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Fake Hermes does not script ${request.method}.` } }));
    }
    close() {
      if (this.readyState === FakeSocket.CLOSED) return;
      this.readyState = FakeSocket.CLOSED;
      this.dispatchEvent(new Event("close"));
    }
  }
  const realFetch = globalThis.fetch;
  vi.stubGlobal("WebSocket", FakeSocket);
  // Hermes's HTTP surface answers nothing this suite needs. The app's own listener stays reachable.
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
    String(input instanceof Request ? input.url : input).startsWith(HERMES_URL) ? Promise.resolve(new Response("Not scripted", { status: 404 })) : realFetch(input, init));
  return hermes;
}
export type FakeHermes = ReturnType<typeof fakeHermes>;

/** A saved history row as the add-on returns it. */
export const row = (id: string | number, role: string, text: string, extra: Row = {}): Row => ({ row_id: id, role, content: text, text, ...extra });
