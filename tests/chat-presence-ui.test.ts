// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { write } from "../src/client-api";
import { IDLE_MS, useChatPresence } from "../src/app/use-chat-presence";
import { advance, mountRoot } from "./ui-harness";

vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (async original => ({ ...await original<typeof import("../src/client-api")>(), write: vi.fn() }))(original)));
let root: Root, container: HTMLDivElement, visibility: DocumentVisibilityState, focused: boolean;
const closed: string[] = [];
function Chat({ botId }: { botId?: string }) {
  useChatPresence(botId, "one");
  return null;
}
const states = () => vi.mocked(write).mock.calls.map(([path, body]) => `${path} ${(body as { state: string }).state}`);
async function render(botId?: string) { await act(async () => root.render(createElement(Chat, { botId }))); }
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(write).mockReset().mockResolvedValue({ ok: true });
  visibility = "visible"; focused = true; closed.length = 0;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  const notification = (url: string) => ({ data: { url }, close: () => closed.push(url) });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => ({
    getNotifications: async () => [notification("https://app.test/?bot=ranch"), notification("https://app.test/?bot=ranch&routine=brief"), notification("https://app.test/?bot=barn")],
  }) } });
  ({ container, root } = mountRoot());
});
afterEach(() => { Reflect.deleteProperty(document, "visibilityState"); Reflect.deleteProperty(navigator, "serviceWorker"); });

it("beats while the chat is attended, closes its notifications here and reports leaving", async () => {
  await render("ranch");
  expect(states()).toEqual(["/bots/ranch/presence active"]);
  expect(closed.map(url => new URL(url).search)).toEqual(["?bot=ranch"]);
  await advance(15_000);
  expect(states()).toHaveLength(2);
  focused = false;
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(states().at(-1)).toBe("/bots/ranch/presence left");
  await advance(30_000);
  expect(states()).toHaveLength(3);
  focused = true;
  await act(async () => window.dispatchEvent(new Event("focus")));
  await render("barn");
  expect(states().slice(-3)).toEqual(["/bots/ranch/presence active", "/bots/ranch/presence left", "/bots/barn/presence active"]);
});

it("goes idle without marking read when nobody touches an open chat", async () => {
  await render("ranch");
  await advance(IDLE_MS + 15_000);
  expect(states().at(-1)).toBe("/bots/ranch/presence idle");
  const count = states().length;
  await advance(60_000);
  expect(states()).toHaveLength(count);
  await act(async () => window.dispatchEvent(new Event("keydown")));
  expect(states().at(-1)).toBe("/bots/ranch/presence active");
  visibility = "hidden";
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(states().at(-1)).toBe("/bots/ranch/presence left");
  await render(undefined);
  expect(states().at(-1)).toBe("/bots/ranch/presence left");
  expect(states().filter(state => state.endsWith("left"))).toHaveLength(1);
});

it("sends one report at a time, so leaving a chat never lands after arriving in the next", async () => {
  let finish = () => {};
  vi.mocked(write).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ ok: true }); }));
  await render("ranch");
  await render("barn");
  expect(states()).toEqual(["/bots/ranch/presence active"]);
  await act(async () => finish());
  expect(states()).toEqual(["/bots/ranch/presence active", "/bots/ranch/presence left", "/bots/barn/presence active"]);
});
