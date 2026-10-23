// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { api, write } from "../src/client-api";
import { useSession } from "../src/app/use-session";
import type { Bootstrap, Preferences } from "../src/shared/types";
import { mountRoot } from "./ui-harness";

vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (async original => ({
  ...await original<typeof import("../src/client-api")>(), api: vi.fn(), write: vi.fn(),
  changeStream: () => ({ open() {}, close() {} }),
}))(original)));
let root: Root, container: HTMLDivElement, session: ReturnType<typeof useSession>;
function Harness() {
  session = useSession({ onIdentityChange() {}, onFirstBootstrap() {}, onError() {}, onBotGone() {} });
  return null;
}
const preferences = (favorites: string[]) => ({ favorites, followBots: [], sections: [] }) as unknown as Preferences;
const bootstrap = (favorites: string[]) => ({
  user: { id: "one", name: "One" }, bots: [], preferences: preferences(favorites), connection: { connected: true }, csrfToken: "t",
}) as unknown as Bootstrap;
beforeEach(() => {
  ({ container, root } = mountRoot());
});

it("holds back preferences from a read that overlapped a save, then takes them from the next identical read", async () => {
  let served = bootstrap([]);
  vi.mocked(api).mockImplementation(async () => served as never);
  await act(async () => root.render(createElement(Harness)));
  expect(session.boot?.preferences.favorites).toEqual([]);
  let finish!: (value: Preferences) => void;
  vi.mocked(write).mockImplementation(() => new Promise(resolve => { finish = resolve as never; }));
  let saving!: Promise<void>;
  await act(async () => { saving = session.editPreferences(value => ({ ...value, favorites: ["ranch"] })); });
  // Another device starred something; this read overlaps the save, so its preferences wait.
  served = bootstrap(["ranch", "from phone"]);
  await act(async () => { await session.refresh(); });
  expect(session.boot?.preferences.favorites).toEqual([]);
  await act(async () => { finish(preferences(["ranch"])); await saving; });
  expect(session.boot?.preferences.favorites).toEqual(["ranch"]);
  // The client cache answers the next poll with the same object; it still reconciles.
  await act(async () => { await session.refresh(); });
  expect(session.boot?.preferences.favorites).toEqual(["ranch", "from phone"]);
});
