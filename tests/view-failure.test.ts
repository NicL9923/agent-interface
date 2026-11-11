// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { api } from "../src/client-api";
import { defaultPreferences } from "../src/shared/types";
import type { Bootstrap } from "../src/shared/types";
import { mountRoot, stubMatchMedia } from "./ui-harness";
import { quietConsoleErrors } from "./act-guard";

vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (async original => ({ ...await original<typeof import("../src/client-api")>(), api: vi.fn(), write: vi.fn().mockResolvedValue({}), clearResponseCache: vi.fn() }))(original)));
// Find and the model picker cannot load, as when a release retired their files. The test runs from disk, where no file goes missing, so the
// import itself fails here. Groups is the real module.
vi.mock("../src/components/DiscoveryPanel", () => ({ get DiscoveryPanel() { throw new TypeError("Failed to fetch dynamically imported module: /assets/DiscoveryPanel-OLD12345.js"); } }));
vi.mock("../src/components/ChatModelPicker", () => ({ get ChatModelPicker() { throw new TypeError("Failed to fetch dynamically imported module: /assets/ChatModelPicker-OLD12345.js"); } }));

const bootstrap: Bootstrap = {
  user: { id: "one", name: "One", email: "one@example.test" },
  household: [],
  preferences: { ...defaultPreferences, startPage: "assistant" },
  bots: [{ id: "shared", name: "Shared", shared: true, model: "test", activity: "idle" }],
  capabilities: Object.fromEntries([
    "chat", "steering", "approvals", "uploads", "generatedFiles", "botConfiguration",
    "tools", "skills", "routines", "durableEvents", "idempotency", "imageGeneration",
    "stop", "portraitGeneration", "avatarMetadata",
  ].map(key => [key, { supported: true }])) as Bootstrap["capabilities"],
  connection: { connected: true },
  csrfToken: "test",
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  stubMatchMedia();
  quietConsoleErrors();
  history.replaceState(null, "", "/");
  vi.mocked(api).mockImplementation(async <T>(path: string) => (path === "/bootstrap?roster=lean" ? bootstrap
    : path === "/groups" ? { supported: true, canSend: true, rooms: [{ room_id: "room", name: "Supper planning", members: [] }] }
    : path === "/groups/room" ? { room: { room_id: "room", name: "Supper planning", members: [], latest_seq: 0 } }
    : path.startsWith("/groups/room/log?") ? { events: [], cursor: 0, latest_seq: 0, has_more: false } : null) as T);
  ({ container, root } = mountRoot());
});
const loaded = () => act(async () => { await vi.dynamicImportSettled(); });

describe("screens that fail to load", () => {
  it("keeps the chat and composer usable if the advanced model picker cannot load", async () => {
    vi.mocked(api).mockImplementation(async <T>(path: string) => (path === "/bootstrap?roster=lean"
      ? { ...bootstrap, preferences: { ...bootstrap.preferences, presentation: "advanced" } } : null) as T);
    await act(async () => root.render(createElement(App)));
    await loaded();
    const unavailable = container.querySelector<HTMLButtonElement>('[aria-label="Model controls unavailable. Reload to try again."]');
    expect(unavailable?.disabled).toBe(true);
    expect(unavailable?.closest(".chat-model-slot")).not.toBeNull();
    const input = container.querySelector<HTMLTextAreaElement>(".composer textarea");
    expect(input).not.toBeNull();
    expect(input?.disabled).toBe(false);
  });

  it("do not stop the next screen from opening", async () => {
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Search & saved"]')!.click());
    await loaded();
    expect(container.querySelector("[role=alert]")?.textContent).toContain("could not load");
    const groups = [...container.querySelectorAll<HTMLButtonElement>(".room-row")].find(button => button.textContent?.includes("Supper planning"))!;
    await act(async () => groups.click());
    await loaded();
    expect(container.querySelector(".group-panel")).not.toBeNull();
    expect(container.querySelector("[role=alert]")).toBeNull();
  });
});
