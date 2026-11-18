// @vitest-environment jsdom
import { act, createElement } from "react";
import { beforeEach, expect, it } from "vitest";
import type { Root } from "react-dom/client";
import {
  AgentExchange,
  AgentExchangeGroup,
  ExchangeBots,
  exchangeRuns,
} from "../src/components/AgentExchange";
import type { Bot, Message } from "../src/shared/types";
import { mountRoot, stubMatchMedia, reducedMotionOnly } from "./ui-harness";

const bots = [
  { id: "ranch", name: "Ranch hand" },
  { id: "planner", name: "Planner" },
] as Bot[];
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  stubMatchMedia(reducedMotionOnly);
  ({ root, container } = mountRoot());
});
const render = (message: Message) =>
  act(async () =>
    root.render(
      createElement(
        ExchangeBots.Provider,
        { value: { bots, currentBotId: "ranch" } },
        createElement(AgentExchange, { message, recipient: "Ranch hand" }),
      ),
    ),
  );

it("shows the sender and recipient avatars in delivery order", async () => {
  await render({ id: "in", role: "user", text: "Message from 🤖 Planner (@planner): Bring water" });
  expect(
    [...container.querySelectorAll(".avatar-wrap")].map((avatar) =>
      avatar.getAttribute("aria-label"),
    ),
  ).toEqual(["Planner: Ready", "Ranch hand: Ready"]);
  expect(container.textContent).toContain("Bring water");
});

it("shows an inherited bot reply as a reply to the originating bot", async () => {
  await render({
    id: "reply",
    role: "assistant",
    text: "The gate is closed.",
    origin: { kind: "agent", visibility: "activity", name: "Planner" },
  });
  expect(container.textContent).toContain("Ranch hand → Planner");
  expect(container.querySelector(".message-text")?.textContent).toBe("The gate is closed.");
  expect(container.textContent).not.toContain("Waiting for Hermes");
});

const incoming: Message = {
  id: "in",
  role: "user",
  text: "Message from 🤖 Planner (@planner): Bring water",
};
const outgoing: Message = {
  id: "out",
  role: "tool",
  text: "",
  toolCall: {
    id: "call",
    name: "message_agent",
    arguments: JSON.stringify({ target: "planner", message: "The gate is closed." }),
    status: "failed",
    error: "Planner is offline",
  },
};
const renderGroup = (messages: Message[]) =>
  act(async () =>
    root.render(
      createElement(
        ExchangeBots.Provider,
        { value: { bots, currentBotId: "ranch" } },
        createElement(AgentExchangeGroup, {
          messages,
          recipient: "Ranch hand",
          children: messages.map((message) =>
            createElement(AgentExchange, { key: message.id, message, recipient: "Ranch hand" }),
          ),
        }),
      ),
    ),
  );

it("keeps delivery failures visible while consecutive messages collapse, and preserves the reader's toggle as messages append", async () => {
  await renderGroup([incoming, outgoing]);
  const group = container.querySelector<HTMLDetailsElement>("details")!;
  expect(group.open).toBe(false);
  expect(group.querySelector("summary")?.textContent).toContain("2 bot messages");
  expect(group.querySelector("summary")?.textContent).toContain("1 failed");
  expect(
    [...group.querySelectorAll('summary > .agent-exchange-routes [role="group"]')].map((route) =>
      route.getAttribute("aria-label"),
    ),
  ).toEqual(["Planner to Ranch hand", "Ranch hand to Planner"]);
  await act(async () => {
    group.querySelector("summary")!.click();
  });
  expect(group.open).toBe(true);
  expect(group.textContent).toContain("Planner is offline");
  await renderGroup([incoming, outgoing, { ...incoming, id: "third" }]);
  expect(container.querySelector("details")).toBe(group);
  expect(group.open).toBe(true);
  expect(group.querySelector("summary")?.textContent).toContain("3 bot messages");
  await act(async () => {
    group.querySelector("summary")!.click();
  });
  expect(group.open).toBe(false);
  await renderGroup([incoming]);
  expect(container.querySelector("details")).toBeNull();
  expect(container.textContent).toContain("Bring water");
});

it("uses stable handles for known bots and a neutral avatar for unresolved recipients", async () => {
  await render({
    ...incoming,
    text: "Message from 🤖 Old name (@planner): Bring water",
    origin: { kind: "agent", visibility: "activity", name: "Old name" },
  });
  expect(container.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe(
    "Planner to Ranch hand",
  );
  await render({
    ...outgoing,
    toolCall: {
      ...outgoing.toolCall!,
      arguments: "{bad json",
      status: "running",
      error: undefined,
    },
  });
  expect(container.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe(
    "Ranch hand to another assistant",
  );
  expect(container.querySelectorAll(".avatar-wrap")).toHaveLength(1);
  expect(container.textContent).toContain("Sending message…");
  expect(container.querySelector("button")).toBeNull();
});

it("breaks runs at tools, ordinary replies and attributed human messages", () => {
  const human: Message = { ...incoming, id: "human", sender: { id: "one", name: "One" } };
  const tool: Message = { id: "tool", role: "tool", text: "Weather checked" };
  const reply: Message = {
    id: "reply",
    role: "assistant",
    text: "Ready to go",
    origin: { kind: "human", visibility: "conversation" },
  };
  expect(
    exchangeRuns([incoming, outgoing, tool, incoming, reply, outgoing, human, incoming]).map(
      (run) => run.map((message) => message.id),
    ),
  ).toEqual([["in", "out"], ["tool"], ["in"], ["reply"], ["out"], ["human"], ["in"]]);
});

it("keeps distinct avatar routes when two bots have the same display name", async () => {
  const messages: Message[] = ["planner-one", "planner-two"].map((id) => ({
    id,
    role: "user",
    text: "Check the gate",
    origin: { kind: "agent", visibility: "activity", name: "Planner", handle: id },
  }));
  await act(async () =>
    root.render(
      createElement(
        ExchangeBots.Provider,
        {
          value: {
            currentBotId: "ranch",
            bots: [bots[0], { ...bots[1], id: "planner-one" }, { ...bots[1], id: "planner-two" }],
          },
        },
        createElement(AgentExchangeGroup, { messages, recipient: "Ranch hand", children: null }),
      ),
    ),
  );
  const routes = container.querySelectorAll('summary [role="group"]');
  expect(routes).toHaveLength(2);
});
