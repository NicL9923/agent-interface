// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, write } from "../src/client-api";
import { useSession } from "../src/app/use-session";
import type { Bootstrap, Preferences } from "../src/shared/types";
import { mountRoot } from "./ui-harness";

vi.mock("../src/client-api", async (original) =>
  (await import("./helpers/request-mock")).withRequest(
    await (async (original) => ({
      ...(await original<typeof import("../src/client-api")>()),
      api: vi.fn(),
      write: vi.fn(),
      changeStream: () => ({ open() {}, close() {}, reconnect() {} }),
    }))(original),
  ),
);
let root: Root, session: ReturnType<typeof useSession>;
const onError = vi.fn();
function Harness() {
  session = useSession({ onFirstBootstrap() {}, onError, onBotGone() {} });
  return null;
}
const preferences = (favorites: string[]) =>
  ({ favorites, followBots: [], sections: [] }) as unknown as Preferences;
const bootstrap = (favorites: string[]) =>
  ({
    user: { id: "one", name: "One" },
    bots: [],
    preferences: preferences(favorites),
    connection: { connected: true },
    csrfToken: "t",
  }) as unknown as Bootstrap;
beforeEach(() => {
  onError.mockClear();
  vi.mocked(write).mockReset();
  ({ root } = mountRoot());
});

it("holds back preferences from a read that overlapped a save, then takes them from the next identical read", async () => {
  let served = bootstrap([]);
  vi.mocked(api).mockImplementation(async () => served as never);
  await act(async () => root.render(createElement(Harness)));
  expect(session.boot?.preferences.favorites).toEqual([]);
  let finish!: (value: Preferences) => void;
  vi.mocked(write).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve as never;
      }),
  );
  let saving!: Promise<void>;
  await act(async () => {
    saving = session.editPreferences(
      (value) => ({ ...value, favorites: ["ranch"] }),
      ["favorites"],
    );
  });
  // Another device starred something; this read overlaps the save, so its preferences wait.
  served = bootstrap(["ranch", "from phone"]);
  await act(async () => {
    await session.refresh();
  });
  expect(session.boot?.preferences.favorites).toEqual([]);
  await act(async () => {
    finish(preferences(["ranch"]));
    await saving;
  });
  expect(session.boot?.preferences.favorites).toEqual(["ranch"]);
  // The client cache answers the next poll with the same object; it still reconciles.
  await act(async () => {
    await session.refresh();
  });
  expect(session.boot?.preferences.favorites).toEqual(["ranch", "from phone"]);
});

// A server from before partial saves answers the merge patch media type with 415 and saves nothing.
describe("a server that predates partial saves", () => {
  const phone = {
    ...preferences(["from phone"]),
    theme: "dark",
    defaultBotId: "ranch",
  } as Preferences;
  const start = async (refusal: ApiError) => {
    let served = bootstrap([]);
    vi.mocked(api).mockImplementation(async () => served as never);
    await act(async () => root.render(createElement(Harness)));
    // Another device saved since this tab read its copy.
    served = { ...bootstrap([]), preferences: phone };
    vi.mocked(api).mockClear();
    vi.mocked(write)
      .mockRejectedValueOnce(refusal)
      .mockImplementation(async (_path, value) => value as never);
    await act(async () => {
      await session.editPreferences(
        (value) => ({ ...value, favorites: ["ranch hand"] }),
        ["favorites"],
      );
    });
  };
  it("gets the save whole, built on a copy read after the refusal", async () => {
    await start(new ApiError("Unsupported Media Type", 415));
    expect(vi.mocked(api)).toHaveBeenCalledWith("/bootstrap?roster=lean");
    expect(vi.mocked(write).mock.calls).toEqual([
      ["/preferences", { favorites: ["ranch hand"] }, "PATCH"],
      ["/preferences", { ...phone, favorites: ["ranch hand"] }, "PATCH"],
    ]);
    expect(session.boot?.preferences).toEqual({ ...phone, favorites: ["ranch hand"] });
    expect(onError).not.toHaveBeenCalled();
  });
  it("reports any other refusal without sending the save whole", async () => {
    await start(new ApiError("Invalid request", 400));
    expect(vi.mocked(api)).not.toHaveBeenCalled();
    expect(vi.mocked(write)).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("Invalid request");
  });
});
