import { describe, expect, it } from "vitest";
import type { Message } from "../src/shared/types";
import { REACTIONS, reactionAnswers, reactionOf } from "../src/shared/reactions";

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
/** What each message answers: the reply's ID, or undefined when it is an ordinary message. */
const answered = (messages: Message[]) => {
  const answers = reactionAnswers(messages);
  return Object.fromEntries(messages.map((message) => [message.id, answers.get(message.id)]));
};

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

describe("reactionAnswers", () => {
  it("takes a person's lone reaction after a reply as an answer to it, whitespace and all", () => {
    expect(answered([question, person("r", "  👍 \n")])).toMatchObject({ r: "a" });
  });

  it("takes a reaction without its variation selector the same way", () => {
    expect(answered([question, person("r", "\u2764")])).toMatchObject({ r: "a" });
  });

  it("leaves a message with a file as a message", () => {
    const file = { id: "f", name: "gate.jpg", mime: "image/jpeg" };
    expect(answered([question, person("r", "👍", { files: [file] })]).r).toBeUndefined();
  });

  it("leaves a scheduled prompt as a prompt, even when its text is a reaction", () => {
    const scheduled = person("r", "👍", {
      sender: undefined,
      origin: { kind: "scheduled", visibility: "conversation" },
    });
    expect(answered([question, scheduled]).r).toBeUndefined();
  });

  it("leaves a lone emoji outside the set as a message", () => {
    expect(answered([question, person("r", "🔥")]).r).toBeUndefined();
  });

  it("leaves a reaction after a person's message as a message", () => {
    expect(answered([question, person("q", "Yes please"), person("r", "👍")]).r).toBeUndefined();
  });

  it("leaves a reaction after a progress line as a message", () => {
    const progress = reply("p", "Checking the list…", { interim: true });
    expect(answered([progress, person("r", "👍")]).r).toBeUndefined();
  });

  it("looks past tool rows that follow the reply", () => {
    const messages = [
      question,
      { id: "tool", role: "tool", text: "ran", toolName: "shell" } as Message,
      reply("call", "", { toolCall: { id: "c", name: "list", status: "completed" } }),
      person("r", "👍"),
    ];
    expect(answered(messages).r).toBe("a");
  });

  it("answers the same reply with reactions in a row from different members", () => {
    const messages = [
      question,
      person("mine", "👍"),
      person("theirs", "🎉", { sender: { id: "two", name: "Jordan" } }),
    ];
    expect(answered(messages)).toMatchObject({ mine: "a", theirs: "a" });
  });

  it("leaves an emoji as a message once anything but a reply comes between", () => {
    const messages = [
      question,
      person("r1", "👍"),
      reply("b", "Added."),
      person("r2", "❤️"),
      person("words", "Thanks"),
      person("r3", "😂"),
    ];
    expect(answered(messages)).toEqual({
      a: undefined,
      r1: "a",
      b: undefined,
      r2: "b",
      words: undefined,
      r3: undefined,
    });
  });

  // Nothing before the window is read, so its first message cannot be shown as an answer to it.
  it("leaves the first message as a message", () => {
    expect(answered([person("r", "👍")]).r).toBeUndefined();
  });

  it("does not answer a reply that went to an agent's prompt, which the chat files as activity", () => {
    const agent = person("prompt", "Check the barn", {
      sender: undefined,
      origin: { kind: "agent", visibility: "activity" },
    });
    expect(answered([agent, reply("b", "Barn is fine."), person("r", "👍")]).r).toBeUndefined();
  });
});
