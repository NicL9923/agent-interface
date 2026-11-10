// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearResponseCache, setCsrf } from "../src/client-api";
import { prefetchLinkedChat } from "../src/app/linked-chat";
import { signInHintKey } from "../src/app/storage";
import { useConversation } from "../src/app/use-conversation";
import { useTalk } from "../src/app/use-talk";
import { AutomationPanel } from "../src/components/AutomationPanel";
import { TalkPanel } from "../src/components/TalkPanel";
import type { AutomationOverview } from "../src/shared/automation";
import { FakeEventSource } from "./fake-event-source";
import { advance, button, mountRoot, type Mount } from "./ui-harness";

// Actions that submit work to a chat from outside its composer. The chat opens from the read its
// link started as the page loaded, the person acts, leaves and comes back inside five seconds. The
// link's read is from before the action, so the return must ask the server. The actions run their
// real components through the real client API, against a fake server at fetch that refuses and
// records any request the test did not configure. The chat's change stream never connects here,
// so every conversation read counted is a load the chat made itself; the stream's own fresh read
// on connect is covered in linked-chat-ui and conversation-prefetch.
const NOW = Date.UTC(2026, 10, 10, 15);
let conversations: string[];
let unexpected: string[];
let routes: Record<string, (init: RequestInit) => unknown>;
const page = (text: string) => ({ botId: "ranch", messages: [{ id: "ranch-1", role: "assistant", text }], approvals: [], files: [], activity: { state: "idle" } });
const overview = (): AutomationOverview => ({ botId: "ranch", owner: "Hermes", canManageTriggers: true,
  goals: { supported: true, goal: { title: "Prepare the fall ranch plan", status: "paused", turnsUsed: 2, maxTurns: 20 } },
  tasks: { supported: true, items: [] }, triggers: { supported: true, platformEnabled: true, items: [] },
  skills: { supported: true, approvalRequired: true, installed: [], pending: [] },
});

class FakePeer {
  connectionState = "new";
  ontrack: unknown = null; onconnectionstatechange: unknown = null;
  channel = { readyState: "open", send: vi.fn(), close: vi.fn(), onopen: null as null | (() => void), onmessage: null as null | ((event: { data: string }) => void), onclose: null as unknown };
  addTrack = vi.fn(); close = vi.fn();
  createDataChannel = vi.fn(() => this.channel);
  createOffer = vi.fn(async () => ({ type: "offer", sdp: "v=0 offer" }));
  setLocalDescription = vi.fn(async () => {}); setRemoteDescription = vi.fn(async () => {});
  constructor() { peers.push(this); }
}
const peers: FakePeer[] = [];
class FakeAudio {
  onended: (() => void) | null = null; onerror: (() => void) | null = null;
  autoplay = false; srcObject: unknown = null;
  pause = vi.fn(); removeAttribute = vi.fn(); load = vi.fn(); play = vi.fn(async () => {});
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  // Module state outlives a test: each one starts as a fresh page would.
  clearResponseCache();
  setCsrf("csrf");
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  conversations = [];
  unexpected = [];
  peers.length = 0;
  let reads = 0;
  routes = {
    "GET /api/bots/ranch/conversation?turns=20": () => page(++reads === 1 ? "Read as the page loaded." : "Read on return."),
    "GET /api/bots/ranch/draft": () => null,
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const call = `${init.method ?? "GET"} ${input}`;
    if (call.includes("/conversation")) conversations.push(call);
    const route = routes[call];
    if (!route) {
      unexpected.push(call);
      throw new TypeError(`Unexpected request ${call}`);
    }
    const body = route(init);
    return typeof body === "string" ? new Response(body, { status: 201 }) : new Response(JSON.stringify(body), { status: 200 });
  }));
  localStorage.setItem(signInHintKey, JSON.stringify({ until: NOW + 60_000, user: "one", bots: ["ranch"] }));
  history.replaceState(null, "", "/?bot=ranch");
});
afterEach(() => {
  history.replaceState(null, "", "/");
  localStorage.removeItem(signInHintKey);
  expect(unexpected).toEqual([]);
});

function Chat() {
  const { conversation } = useConversation("ranch", "one");
  return createElement("p", { className: "chat" }, conversation?.messages.map(message => message.text).join(","));
}
const chatText = (mount: Mount) => mount.container.querySelector(".chat")?.textContent;

const actions: [string, () => Promise<void>][] = [
  ["a spoken request in Live Talk", async () => {
    const track = { stop: vi.fn(), enabled: true };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } });
    vi.stubGlobal("RTCPeerConnection", FakePeer);
    vi.stubGlobal("Audio", FakeAudio);
    routes["POST /api/bots/ranch/talk/session"] = () => ({ clientSecret: "ek_fixture", expiresAt: 1, model: "gpt-realtime-2.1", voice: "marin" });
    routes["POST https://api.openai.com/v1/realtime/calls"] = () => "v=0 answer";
    routes["POST /api/bots/ranch/talk/ask"] = () => ({ state: "done", text: "Gate's shut." });
    let talk!: ReturnType<typeof useTalk>;
    const Talk = () => { talk = useTalk("ranch", "Ranch Hand"); return createElement(TalkPanel, { talk, name: "Ranch Hand" }); };
    await mountRoot().render(createElement(Talk));
    await act(async () => talk.start());
    await act(async () => peers[0]!.channel.onopen?.());
    const asked = JSON.stringify({ type: "response.function_call_arguments.done", name: "ask_assistant", call_id: "c1", arguments: JSON.stringify({ request: "Shut the gate" }) });
    await act(async () => peers[0]!.channel.onmessage!({ data: asked }));
    await advance(0);
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => url === "/api/bots/ranch/talk/ask" && JSON.parse(String(init?.body)).request === "Shut the gate")).toBe(true);
    await act(async () => talk.end());
  }],
  ["a goal resumed from the automation controls", async () => {
    routes["GET /api/bots/ranch/automation"] = overview;
    routes["GET /api/routines"] = () => [];
    let resumed: unknown;
    routes["POST /api/bots/ranch/automation/goal/resume"] = init => {
      resumed = JSON.parse(String(init.body));
      return { ...overview(), goals: { ...overview().goals, goal: { ...overview().goals.goal!, status: "active" } } };
    };
    const panel = mountRoot();
    await panel.render(createElement(AutomationPanel, { botId: "ranch", bots: [{ id: "ranch", name: "Ranch Hand", model: "test", shared: true, activity: "idle" }] }));
    await advance(0);
    await act(async () => button("Resume goal", panel.container).click());
    await advance(0);
    expect(resumed).toEqual({ requestId: expect.any(String) });
  }],
];

it.each(actions)("reads the chat again on return after %s, never showing the page the link read", async (_name, perform) => {
  prefetchLinkedChat();
  await advance(0);
  const chat = mountRoot();
  await chat.render(createElement(Chat));
  await advance(0);
  expect(chatText(chat)).toBe("Read as the page loaded.");
  expect(conversations).toHaveLength(1);
  await perform();
  await act(async () => chat.root.unmount());
  const back = mountRoot();
  await back.render(createElement(Chat));
  await advance(0);
  expect(Date.now() - NOW).toBeLessThan(5_000);
  expect(conversations).toHaveLength(2);
  expect(chatText(back)).toBe("Read on return.");
});
