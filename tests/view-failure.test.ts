// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { api } from "../src/client-api";
import { defaultPreferences } from "../src/shared/types";
import type { Bootstrap } from "../src/shared/types";

vi.mock("../src/client-api", async original => ({ ...await original<typeof import("../src/client-api")>(), api: vi.fn(), write: vi.fn().mockResolvedValue({}), clearResponseCache: vi.fn() }));
// SVG geometry is a browser concern, not part of this regression.
vi.mock("../src/components/Avatar", async original => ({
  ...await original<typeof import("../src/components/Avatar")>(),
  Avatar: () => createElement("span"),
}));
// Find cannot load, as when its file was retired by a release; Groups is healthy.
vi.mock("../src/components/DiscoveryPanel", () => ({ get DiscoveryPanel() { throw new TypeError("Failed to fetch dynamically imported module: /assets/DiscoveryPanel-OLD12345.js"); } }));
vi.mock("../src/components/GroupChats", () => ({ GroupChats: () => createElement("p", { id: "groups-screen" }, "Group chats") }));

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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.spyOn(console, "error").mockImplementation(() => {});
  localStorage.clear();
  history.replaceState(null, "", "/");
  vi.mocked(api).mockImplementation(async <T>(path: string) => (path === "/bootstrap" ? bootstrap : null) as T);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const loaded = () => act(async () => { await vi.dynamicImportSettled(); });

describe("screens that fail to load", () => {
  it("do not stop the next screen from opening", async () => {
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Search & saved"]')!.click());
    await loaded();
    expect(container.querySelector("[role=alert]")?.textContent).toContain("could not load");
    const groups = [...container.querySelectorAll<HTMLButtonElement>(".home-links button")].find(button => button.textContent?.includes("Group chats"))!;
    await act(async () => groups.click());
    await loaded();
    expect(container.querySelector("#groups-screen")?.textContent).toBe("Group chats");
    expect(container.querySelector("[role=alert]")).toBeNull();
  });
});
