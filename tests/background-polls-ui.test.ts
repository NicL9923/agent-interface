// @vitest-environment jsdom
import { act, createElement } from "react";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, write } from "../src/client-api";
import { GroupChats } from "../src/components/GroupChats";
import { RoutineEnhancements } from "../src/components/RoutineEnhancements";
import { TodayPanel } from "../src/components/TodayPanel";
import { defaultPreferences } from "../src/shared/types";
import type { Bootstrap } from "../src/shared/types";
import { advance, mountRoot } from "./ui-harness";

vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (async original => ({ ...await original<typeof import("../src/client-api")>(), api: vi.fn(), write: vi.fn() }))(original)));
let root: Root, container: HTMLDivElement, visibility: DocumentVisibilityState;
const bootstrap = { user: { id: "one", name: "One" }, preferences: defaultPreferences, connection: { connected: true },
  bots: [{ id: "ranch", name: "Ranch", activity: "idle" }] } as Bootstrap;
const room = { room_id: "room", name: "Weekend plans", members: [] };
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api).mockReset(); vi.mocked(write).mockReset();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  vi.mocked(api).mockImplementation(async (path: string) => path === "/groups" ? { supported: true, canSend: true, rooms: [room] }
    : path.includes("/log") ? { events: [], cursor: 0, has_more: false }
    : path.startsWith("/groups/") ? { room, driver_status: { working: false, blocked: false, pending_actions: [] } }
    : path === "/today" ? { generatedAt: "2026-10-14T12:00:00Z", frontier: "0", hasMore: false, since: "2026-10-14T00:00:00Z", unavailableBots: [], items: [], events: [] }
    : { requestId: "run", status: "accepted" });
  ({ container, root } = mountRoot());
});
afterEach(() => { Reflect.deleteProperty(document, "visibilityState"); });
async function show(state: DocumentVisibilityState) {
  visibility = state;
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
}
const reads = (match: (path: string) => boolean) => vi.mocked(api).mock.calls.filter(([path]) => match(String(path))).length;

describe("background polls in a hidden tab", () => {
  it.each<[string, () => ReactElement, (path: string) => boolean, number]>([
    ["Today", () => createElement(TodayPanel, { bootstrap, onOpen: vi.fn() }), path => path === "/today", 30_000],
    ["the group list", () => createElement(GroupChats, { bootstrap }), path => path === "/groups", 15_000],
    ["an open group room", () => createElement(GroupChats, { bootstrap }), path => path === "/groups/room", 30_000],
    ["a routine run", () => createElement(RoutineEnhancements, { routine: { id: "r1", botId: "ranch", name: "Morning", schedule: "0 7 * * *", prompt: "Report", enabled: true }, userId: "one" }),
      path => path === "/routines/r1/runs/run", 5_000],
  ])("pauses %s while hidden and refreshes it as soon as it is shown", async (_name, element, match, interval) => {
    localStorage.setItem("agent-interface:routine-trial:one:r1", "run");
    await act(async () => root.render(element()));
    await advance(0);
    const opened = reads(match);
    expect(opened).toBeGreaterThan(0);
    await advance(interval);
    expect(reads(match)).toBe(opened + 1);
    await show("hidden");
    await advance(interval * 10);
    expect(reads(match)).toBe(opened + 1);
    await show("visible");
    await advance(0);
    expect(reads(match)).toBe(opened + 2);
    await advance(interval);
    expect(reads(match)).toBe(opened + 3);
  });
});
