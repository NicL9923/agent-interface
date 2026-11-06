// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { api, write } from "../src/client-api";
import { defaultPreferences, type Bootstrap } from "../src/shared/types";
import type { GroupCatalog, GroupRoom } from "../src/shared/collaboration";
import { FakeEventSource } from "./fake-event-source";
import { GROUP_FALLBACK_POLL_MS } from "../src/app/use-session";
import { advance, mountRoot, stubMatchMedia } from "./ui-harness";

vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (async original => ({ ...await original<typeof import("../src/client-api")>(), api: vi.fn(), write: vi.fn() }))(original)));
vi.mock("../src/app/use-chat-presence", () => ({ useChatPresence: () => {} }));
vi.mock("../src/components/Avatar", async original => ({ ...await original<typeof import("../src/components/Avatar")>(), Avatar: ({ name }: { name?: string }) => createElement("span", { "data-face": name }) }));

const member = (id: string, name: string) => ({ member_id: id, profile: id, handle: id, display_name: name });
const supper: GroupRoom = { room_id: "supper", name: "Supper planning", members: [member("ranch", "Ranch hand"), member("kitchen", "Kitchen companion")],
  latest: { text: "The smoker is free Sunday.", at: "2026-10-31T10:00:00Z", author: "Kitchen companion" } };
const fences: GroupRoom = { room_id: "fences", name: "Fence repair", members: [member("ranch", "Ranch hand"), member("kitchen", "Kitchen companion"), member("garden", "Garden planner")],
  latest: { text: "Posts are ordered.", at: "2026-10-31T12:00:00Z", author: "You" } };
const quiet: GroupRoom = { room_id: "quiet", name: "Quiet room", members: [member("ranch", "Ranch hand"), member("garden", "Garden planner")] };
let root: Root, container: HTMLDivElement, boot: Bootstrap, catalog: GroupCatalog;
const capabilities = Object.fromEntries(["chat", "steering", "approvals", "uploads", "generatedFiles", "botConfiguration", "tools", "skills", "routines", "durableEvents", "idempotency", "imageGeneration", "stop", "portraitGeneration", "avatarMetadata"].map(key => [key, { supported: true }])) as Bootstrap["capabilities"];
const bots = ["ranch", "kitchen", "garden"].map(id => ({ id, name: id === "ranch" ? "Ranch hand" : id === "kitchen" ? "Kitchen companion" : "Garden planner", shared: true, model: "test", activity: "idle" }));
const reads = (match: (path: string) => boolean) => vi.mocked(api).mock.calls.filter(([path]) => match(String(path))).length;
const loaded = () => act(async () => { await vi.dynamicImportSettled(); });
const render = async () => { await act(async () => root.render(createElement(App))); await advance(20); await loaded(); };
const rows = () => [...container.querySelectorAll<HTMLElement>(".home-list .bot-row")];
const roomRows = () => [...container.querySelectorAll<HTMLElement>(".room-row")];
const names = () => rows().map(row => row.querySelector("strong")?.textContent);

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api).mockReset(); vi.mocked(write).mockReset().mockResolvedValue({});
  FakeEventSource.reset(); vi.stubGlobal("EventSource", FakeEventSource);
  stubMatchMedia();
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  history.replaceState(null, "", "/");
  boot = { user: { id: "one", name: "One", email: "one@example.test" }, household: [], preferences: { ...structuredClone(defaultPreferences), startPage: "assistant" }, bots, capabilities, connection: { connected: true }, csrfToken: "x" } as unknown as Bootstrap;
  catalog = { supported: true, canSend: true, rooms: [supper, quiet, fences] };
  vi.mocked(api).mockImplementation(async <T>(path: string) => {
    if (path === "/bootstrap?roster=lean") return boot as T;
    if (path === "/groups") return catalog as T;
    if (path.startsWith("/groups/") && path.includes("/log")) return { events: [], cursor: 0, has_more: false } as T;
    if (path.startsWith("/groups/")) return { room: catalog.rooms.find(room => path === `/groups/${room.room_id}`), driver_status: { working: false, blocked: false, pending_actions: [] } } as T;
    if (path.startsWith("/bots/") && path.includes("/conversation")) return { botId: path.split("/")[2], messages: [], approvals: [], files: [], activity: { state: "idle" } } as T;
    return null as T;
  });
  ({ container, root } = mountRoot());
});

describe("group chats on home", () => {
  it("lists rooms with the assistants, newest message first, and no separate Group chats link", async () => {
    await render();
    expect(names()).toEqual(["Ranch hand", "Kitchen companion", "Garden planner", "Fence repair", "Supper planning", "Quiet room"]);
    expect([...container.querySelectorAll(".home-links button")].map(button => button.textContent?.trim())).toEqual(["Today"]);
    const [fence, supperRow, quietRow] = roomRows();
    expect(fence.querySelector("small")?.textContent).toContain("You: Posts are ordered.");
    expect(supperRow.querySelector("small")?.textContent).toContain("Kitchen companion: The smoker is free Sunday.");
    expect(supperRow.querySelector("time")).not.toBeNull();
    expect(quietRow.querySelector("small")?.textContent).toContain("No messages yet");
    expect(quietRow.querySelector("time")).toBeNull();
    // Overlapping faces: two for a pair, three for a bigger room.
    expect([...fence.querySelectorAll("[data-face]")].map(face => face.getAttribute("data-face"))).toEqual(["Ranch hand", "Kitchen companion", "Garden planner"]);
    expect(supperRow.querySelectorAll("[data-face]")).toHaveLength(2);
    expect(container.querySelector(".home-list")?.getAttribute("aria-label") ?? container.querySelector(".bot-section")?.getAttribute("aria-label")).toBe("Your chats");
  });

  it("keeps assistant rows alone when Hermes cannot host groups", async () => {
    catalog = { supported: false, canSend: false, rooms: [], reason: "This Hermes version does not expose hosted group chats." };
    await render();
    expect(roomRows()).toHaveLength(0);
    expect(container.querySelector(".bot-section")?.getAttribute("aria-label")).toBe("Your assistants");
    // Nothing to choose from, so the plus button makes an assistant at once.
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="New assistant"]')!.click());
    await loaded();
    expect(container.querySelector(".settings-dialog")).not.toBeNull();
  });

  it("opens a room in the main pane like a conversation, and the conversation again from its row", async () => {
    await render();
    await act(async () => roomRows()[1].click());
    await loaded(); await advance(20);
    expect(roomRows()[1].getAttribute("aria-current")).toBe("page");
    expect(container.querySelector(".chat-header h1")?.textContent).toBe("Supper planning");
    expect(container.querySelector(".chat-header p")?.textContent).toBe("Ranch hand and Kitchen companion");
    expect(container.querySelector(".group-panel")).not.toBeNull();
    expect(container.querySelector(".composer:not(.group-composer)")).toBeNull();
    expect(location.search).toContain("view=group");
    expect(location.search).toContain("room=supper");
    // Picking an assistant leaves the room, and the room row no longer reads as open.
    await act(async () => rows()[0].click());
    await advance(20);
    expect(container.querySelector(".group-panel")).toBeNull();
    expect(roomRows().some(row => row.getAttribute("aria-current") === "page")).toBe(false);
    expect(location.search).not.toContain("room=");
  });

  it("does not poll any room's log from home, only the catalog, and not in a hidden tab", async () => {
    await render();
    const catalogReads = () => reads(path => path === "/groups");
    const opened = catalogReads();
    await advance(5 * 60_000);
    expect(reads(path => path.startsWith("/groups/"))).toBe(0);
    expect(catalogReads() - opened).toBeLessThanOrEqual(11);
    expect(catalogReads()).toBeGreaterThan(opened);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      const before = catalogReads();
      await advance(5 * 60_000);
      expect(catalogReads()).toBe(before);
    } finally { Reflect.deleteProperty(document, "visibilityState"); }
  });

  it("reads the catalog again on the household stream's groups notice and when it reconnects, and polls only every 5 minutes", async () => {
    await render();
    const catalogReads = () => reads(path => path === "/groups");
    const household = [...FakeEventSource.streams].find(stream => stream.url === "/api/events")!;
    expect(household).toBeDefined();
    await act(async () => household.connect());
    await advance(20);
    const opened = catalogReads();
    await advance(GROUP_FALLBACK_POLL_MS - 1000);
    expect(catalogReads()).toBe(opened);
    await act(async () => household.emit("groups", "groups"));
    await advance(20);
    expect(catalogReads()).toBe(opened + 1);
    // A changed room shows without waiting for the poll.
    catalog = { ...catalog, rooms: [...catalog.rooms, { room_id: "barn", name: "Barn raising", members: [member("ranch", "Ranch hand"), member("garden", "Garden planner")] }] };
    await act(async () => household.emit("groups", "groups"));
    await advance(20);
    expect(names()).toContain("Barn raising");
    // Notices sent while the stream was down are lost, so connecting again reads the catalog.
    const before = catalogReads();
    await act(async () => household.connect());
    await advance(20);
    expect(catalogReads()).toBe(before + 1);
  });

  it("makes a group from the plus menu and opens the new room", async () => {
    await render();
    const plus = container.querySelector<HTMLButtonElement>('.home-bar [aria-haspopup="menu"]')!;
    expect(plus.getAttribute("aria-label")).toBe("New");
    expect(container.querySelector('[role="menu"]')).toBeNull();
    await act(async () => plus.click());
    expect([...container.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(["New assistant", "New group chat"]);
    expect(document.activeElement?.textContent).toBe("New assistant");
    await act(async () => container.querySelector<HTMLElement>('[role="menu"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(plus);
    await act(async () => plus.click());
    await act(async () => [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')][1].click());
    await loaded();
    expect(container.querySelector('[role="menu"]')).toBeNull();
    const dialog = container.querySelector(".group-create-sheet")!;
    expect(dialog.querySelector("h2")?.textContent).toBe("New group chat");
    const created: GroupRoom = { room_id: "new-room", name: "Garden crew", members: [member("ranch", "Ranch hand"), member("garden", "Garden planner")] };
    vi.mocked(write).mockResolvedValue({ room: created });
    const input = dialog.querySelector<HTMLInputElement>("input:not([type=checkbox])")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Garden crew"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    for (const box of [...dialog.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].slice(0, 2)) await act(async () => box.click());
    catalog = { ...catalog, rooms: [...catalog.rooms, created] };
    await act(async () => [...dialog.querySelectorAll("button")].find(button => button.textContent === "Create group")!.click());
    await advance(20);
    expect(write).toHaveBeenCalledWith("/groups", expect.objectContaining({ name: "Garden crew", botIds: ["ranch", "kitchen"] }));
    expect(container.querySelector(".group-create-sheet")).toBeNull();
    expect(container.querySelector(".chat-header h1")?.textContent).toBe("Garden crew");
    expect(roomRows().find(row => row.getAttribute("aria-current") === "page")?.textContent).toContain("Garden crew");
  });

  it("says why a group cannot be made yet, and still offers the assistant", async () => {
    catalog = { ...catalog, canSend: false, reason: "Hermes group history is available. Its group coordinator must be running to create rooms or send messages." };
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('.home-bar [aria-haspopup="menu"]')!.click());
    const items = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items[0].disabled).toBe(false);
    expect(items[1].disabled).toBe(true);
    expect(container.querySelector('[role="menu"] small')?.textContent).toContain("group coordinator must be running");
  });

  it("offers to finish a group whose creation may have reached Hermes", async () => {
    localStorage.setItem("agent-interface:group-create:one", JSON.stringify({ requestId: crypto.randomUUID(), name: "Garden crew", botIds: ["ranch", "garden"] }));
    catalog = { supported: true, canSend: true, rooms: [] };
    await render();
    const row = [...container.querySelectorAll<HTMLElement>(".room-pending")][0];
    expect(row.textContent).toContain("Finish creating group");
    expect(row.textContent).toContain("Garden crew · 2 assistants");
    await act(async () => row.click());
    await loaded();
    expect(container.querySelector(".group-create-sheet h2")?.textContent).toBe("Finish creating group");
  });

  it("opens a linked room, and sends the old Group chats link to home", async () => {
    history.replaceState(null, "", "/?view=group&room=fences");
    await render();
    expect(container.querySelector(".chat-header h1")?.textContent).toBe("Fence repair");
    expect(roomRows()[0].getAttribute("aria-current")).toBe("page");
    root.unmount();
    history.replaceState(null, "", "/?view=groups");
    stubMatchMedia(query => query.includes("620px"));
    await render();
    expect(container.querySelector(".bot-rail.open")).not.toBeNull();
    expect(location.search).not.toContain("view=");
  });

  it("goes to a room from the command palette and offers a new group there", async () => {
    await render();
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true })); });
    const palette = document.body.querySelector<HTMLDialogElement>("dialog.command-palette")!;
    const options = () => [...palette.querySelectorAll<HTMLElement>('[role="option"]')];
    const labels = () => options().map(option => option.querySelector(".palette-label")?.textContent);
    expect(labels()).toEqual(expect.arrayContaining(["Supper planning", "Fence repair", "New group chat", "Today"]));
    expect(labels()).not.toContain("Group chats");
    await act(async () => options().find(option => option.querySelector(".palette-label")?.textContent === "Supper planning")!.click());
    await advance(20); await loaded();
    expect(container.querySelector(".chat-header h1")?.textContent).toBe("Supper planning");
  });
});
