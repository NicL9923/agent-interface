// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearResponseCache, setCsrf } from "../src/client-api";
import { QUEUE_POLL_MS, QueuePanel } from "../src/components/QueuePanel";
import type { QueuedMessage } from "../src/shared/queue";
import type { Bootstrap, Bot } from "../src/shared/types";
import { advance, button, mountRoot, typeInto, type Mount } from "./ui-harness";
import { bodyText } from "./helpers/wire-text";

// The panel runs through the real client API against a fake server at fetch, which refuses and
// records any request the test did not configure.
type Reply = { status?: number; body: unknown };
let routes: Record<string, (body: unknown) => Reply>;
let calls: { call: string; body: unknown }[];
let unexpected: string[];
let mount: Mount;
let queue: QueuedMessage[];

const item = (id: string, text = `Message ${id}`): QueuedMessage => ({ id, text });
const boot = (queueManagement?: boolean) =>
  ({
    capabilities:
      queueManagement === undefined ? {} : { queueManagement: { supported: queueManagement } },
  }) as Bootstrap;
const codex: Bot = {
  id: "ranch",
  name: "Ranch hand",
  model: "m",
  shared: true,
  activity: "idle",
  harness: "codex",
};
const render = (props: { boot?: Bootstrap; bot?: Bot; active?: boolean } = {}) =>
  mount.render(
    createElement(QueuePanel, {
      boot: props.boot ?? boot(true),
      bot: props.bot ?? codex,
      active: props.active ?? false,
    }),
  );
const texts = () =>
  Array.from(mount.container.querySelectorAll(".queue-text")).map((row) => row.textContent);
const labelled = (label: string) =>
  mount.container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const press = (label: string) => act(async () => labelled(label).click());
const reads = () => calls.filter(({ call }) => call === "GET /api/bots/ranch/queue").length;

beforeEach(() => {
  vi.useFakeTimers();
  clearResponseCache();
  setCsrf("csrf");
  calls = [];
  unexpected = [];
  queue = [item("a"), item("b"), item("c")];
  routes = { "GET /api/bots/ranch/queue": () => ({ body: { items: queue } }) };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const call = `${init.method ?? "GET"} ${input}`;
      const body = init.body ? JSON.parse(bodyText(init.body)) : undefined;
      calls.push({ call, body });
      const route = routes[call];
      if (!route) {
        unexpected.push(call);
        throw new TypeError(`Unexpected request ${call}`);
      }
      const reply = route(body);
      return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
    }),
  );
  mount = mountRoot();
});
afterEach(() => {
  vi.useRealTimers();
  expect(unexpected).toEqual([]);
});

describe("when it shows", () => {
  it.each([
    ["the runtime has no queue management", boot(false), codex],
    ["a server from before harnesses sends no queue capability", boot(), codex],
    ["the bot runs on Hermes", boot(true), { ...codex, harness: "hermes" }],
    [
      "the bot names no harness, so it runs on Hermes",
      boot(true),
      { ...codex, harness: undefined },
    ],
    [
      "the bot's own harness turns queue management off",
      boot(true),
      { ...codex, capabilities: { queueManagement: { supported: false } } },
    ],
  ])("stays hidden and never reads the queue when %s", async (_, bootstrap, bot) => {
    await render({ boot: bootstrap, bot });
    await advance(QUEUE_POLL_MS * 2);
    expect(mount.container.querySelector(".queue-panel")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("follows the bot's own capability over the bootstrap's", async () => {
    await render({
      boot: boot(false),
      bot: { ...codex, capabilities: { queueManagement: { supported: true } } },
    });
    await advance(0);
    expect(texts()).toEqual(["Message a", "Message b", "Message c"]);
  });

  it("stays hidden while nothing waits, and polls only while a turn runs or messages wait", async () => {
    queue = [];
    await render();
    await advance(0);
    expect(mount.container.querySelector(".queue-panel")).toBeNull();
    await advance(QUEUE_POLL_MS * 3);
    expect(reads()).toBe(1);
    // A turn starting reads at once, then keeps reading while it runs.
    await render({ active: true });
    await advance(0);
    expect(reads()).toBe(2);
    queue = [item("a", "Check the north fence")];
    await advance(QUEUE_POLL_MS);
    expect(texts()).toEqual(["Check the north fence"]);
    expect(mount.container.querySelector("h2")?.textContent).toContain("1 message queued");
  });
});

describe("changes", () => {
  beforeEach(async () => {
    await render();
    await advance(0);
  });

  it.each([
    ["the second message up goes before the first", "Move queued message 2 up", "b", "a", "bac"],
    ["the first message down goes before the third", "Move queued message 1 down", "a", "c", "bac"],
    ["the second message down goes to the end", "Move queued message 2 down", "b", null, "acb"],
  ] as const)("reorders when %s", async (_, label, moved, before, order) => {
    routes[`POST /api/bots/ranch/queue/${moved}/reorder`] = () => {
      const rest = queue.filter((entry) => entry.id !== moved);
      const at = before ? rest.findIndex((entry) => entry.id === before) : rest.length;
      rest.splice(
        at,
        0,
        queue.find((entry) => entry.id === moved)!,
      );
      return { body: { items: rest } };
    };
    await press(label);
    expect(calls.at(-1)).toEqual({
      call: `POST /api/bots/ranch/queue/${moved}/reorder`,
      body: { beforeItemId: before },
    });
    expect(texts()).toEqual(order.split("").map((id) => `Message ${id}`));
    // Focus stays on the control that moved it, or the other move button once that one ends.
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Move queued message/);
  });

  it("offers no move past either end", () => {
    expect(labelled("Move queued message 1 up").disabled).toBe(true);
    expect(labelled("Move queued message 3 down").disabled).toBe(true);
  });

  it("edits a message's text, refusing an unchanged or empty edit, and Escape keeps the original", async () => {
    await press("Edit queued message 2");
    const field = () => mount.container.querySelector<HTMLTextAreaElement>(".queue-edit textarea")!;
    expect(document.activeElement).toBe(field());
    expect(button("Save").disabled).toBe(true);
    await typeInto(field(), "   ");
    expect(button("Save").disabled).toBe(true);
    await act(async () =>
      field().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(mount.container.querySelector(".queue-edit")).toBeNull();
    expect(document.activeElement).toBe(labelled("Edit queued message 2"));
    await press("Edit queued message 2");
    await typeInto(field(), "Feed the horses first");
    routes["PATCH /api/bots/ranch/queue/b"] = (body) => ({
      body: { items: [item("a"), { id: "b", ...(body as { text: string }) }, item("c")] },
    });
    await act(async () => button("Save").click());
    expect(calls.at(-1)).toEqual({
      call: "PATCH /api/bots/ranch/queue/b",
      body: { text: "Feed the horses first" },
    });
    expect(texts()).toEqual(["Message a", "Feed the horses first", "Message c"]);
    expect(mount.container.querySelector(".queue-edit")).toBeNull();
  });

  it("sends a message now and cancels another, hiding once the queue empties", async () => {
    routes["POST /api/bots/ranch/queue/a/send-now"] = () => ({
      body: { items: [item("b"), item("c")] },
    });
    await press("Send queued message 1 now");
    expect(calls.at(-1)?.call).toBe("POST /api/bots/ranch/queue/a/send-now");
    expect(texts()).toEqual(["Message b", "Message c"]);
    routes["DELETE /api/bots/ranch/queue/b"] = () => ({ body: { items: [item("c")] } });
    await press("Cancel queued message 1");
    expect(calls.at(-1)?.call).toBe("DELETE /api/bots/ranch/queue/b");
    routes["DELETE /api/bots/ranch/queue/c"] = () => ({ body: { items: [] } });
    await press("Cancel queued message 1");
    expect(mount.container.querySelector(".queue-panel")).toBeNull();
  });

  it("explains a message that already started, and shows what still waits", async () => {
    routes["POST /api/bots/ranch/queue/a/send-now"] = () => ({
      status: 409,
      body: { error: "Queue item is running." },
    });
    queue = [item("b"), item("c")];
    await press("Send queued message 1 now");
    await advance(0);
    expect(mount.container.querySelector('[role="alert"]')?.textContent).toBe(
      "That message already started, so it can't be changed. The queue now shows what is still waiting.",
    );
    expect(texts()).toEqual(["Message b", "Message c"]);
  });

  it("shows any other refusal as the server gave it, and keeps the queue", async () => {
    routes["DELETE /api/bots/ranch/queue/a"] = () => ({
      status: 400,
      body: { error: "Messages from another person can't be cancelled." },
    });
    await press("Cancel queued message 1");
    expect(mount.container.querySelector('[role="alert"]')?.textContent).toBe(
      "Messages from another person can't be cancelled.",
    );
    expect(texts()).toEqual(["Message a", "Message b", "Message c"]);
  });
});
