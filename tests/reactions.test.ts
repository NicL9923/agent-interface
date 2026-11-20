import { describe, expect, it } from "vitest";
import type { Message } from "../src/shared/types";
import { REACTIONS, answerableReply, isReactionMessage, reactionOf } from "../src/shared/reactions";

const person = (id: string, text: string, extra: Partial<Message> = {}): Message => ({
  id,
  role: "user",
  text,
  sender: { id: "one", name: "One" },
  ...extra,
});
const reply = (id: string, text: string, extra: Partial<Message> = {}): Message => ({
  id,
  role: "assistant",
  text,
  ...extra,
});
const question = reply("a", "Want me to add it to the list?");

describe("reactionOf", () => {
  // The iOS app and the web picker send these; the order is the picker's.
  it("offers the five reactions in their contract order", () => {
    expect(REACTIONS.map((reaction) => reaction.emoji)).toEqual(["👍", "❤️", "😂", "🎉", "👎"]);
  });

  it("matches each reaction with and without the U+FE0F variation selector", () => {
    for (const reaction of REACTIONS) {
      const plain = reaction.emoji.replace(/\uFE0F/gu, "");
      expect(reactionOf(plain)).toBe(reaction);
      expect(reactionOf(`${plain}\uFE0F`)).toBe(reaction);
    }
    // The heart is the one a keyboard often sends without its selector.
    expect(reactionOf("\u2764")?.name).toBe("Heart");
  });

  it("matches only a whole text of one reaction", () => {
    expect(reactionOf("  👍\n")?.name).toBe("Thumbs up");
    expect(reactionOf("👍👍")).toBeUndefined();
    expect(reactionOf("👍 ok")).toBeUndefined();
    expect(reactionOf("🔥")).toBeUndefined();
    expect(reactionOf("")).toBeUndefined();
  });
});

describe("isReactionMessage", () => {
  // It reads only the message, so a page boundary, find or another member's copy of the chat cannot change it.
  it("takes a person's message of one reaction as one, wherever it sits", () => {
    expect(isReactionMessage(person("r", "  👍 \n"))).toBe(true);
    expect(
      isReactionMessage(person("r", "\u2764", { sender: { id: "two", name: "Jordan" } })),
    ).toBe(true);
  });

  it("leaves a message with a file, an emoji outside the set and an assistant's emoji as messages", () => {
    const file = { id: "f", name: "gate.jpg", mime: "image/jpeg" };
    expect(isReactionMessage(person("r", "👍", { files: [file] }))).toBe(false);
    expect(isReactionMessage(person("r", "🔥"))).toBe(false);
    expect(isReactionMessage(reply("r", "👍"))).toBe(false);
  });
});

describe("answerableReply", () => {
  it("is the reply that ends the chat, with words or with files alone", () => {
    expect(answerableReply([person("q", "Add salt?"), question])).toBe("a");
    const file = { id: "f", name: "list.pdf", mime: "application/pdf" };
    expect(answerableReply([person("q", "The list?"), reply("f", "", { files: [file] })])).toBe(
      "f",
    );
  });

  it("is nothing once anything else ends the chat", () => {
    expect(answerableReply([question, person("r", "👍")])).toBeUndefined();
    expect(answerableReply([question, { id: "t", role: "tool", text: "ran" }])).toBeUndefined();
    expect(answerableReply([])).toBeUndefined();
  });

  it("is nothing for a progress line, a live reply or a call without words", () => {
    expect(answerableReply([reply("p", "Checking the list…", { interim: true })])).toBeUndefined();
    expect(answerableReply([person("q", "Hi"), reply("s-inflight", "Writ")])).toBeUndefined();
    const call = reply("c", "", { toolCall: { id: "c", name: "list", status: "completed" } });
    expect(answerableReply([person("q", "Hi"), call])).toBeUndefined();
  });

  it("is nothing for a reply to an agent's prompt, which the chat files as activity", () => {
    const agent = person("prompt", "Check the barn", {
      sender: undefined,
      origin: { kind: "agent", visibility: "activity" },
    });
    expect(answerableReply([agent, reply("b", "Barn is fine.")])).toBeUndefined();
  });
});
