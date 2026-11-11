import { describe, expect, it } from "vitest";
import { replySnippet, watchReplies, type ReplyWatch } from "../src/app/reply-announcement";
import type { Conversation, Message } from "../src/shared/types";

type State = Conversation["activity"]["state"];

const conversation = (messages: Message[], state: State = "idle") =>
  ({ botId: "shared", messages, approvals: [], files: [], activity: { state }, draft: null, readPosition: null });
const question = (id = "q"): Message => ({ id, role: "user", text: "Fix the fence?" });
const say = (id: string, text: string): Message => ({ id, role: "assistant", text });
const tool = (id: string): Message => ({ id, role: "assistant", text: "", toolCall: { id, name: "terminal", status: "completed" } });
/** What the screen reader is given for a read, as use-conversation words it. */
const announced = (watch: ReplyWatch, messages: Message[], state?: State) => {
  const result = watchReplies(watch, conversation(messages, state), false);
  return { ...result, said: result.reply && replySnippet(result.reply.text) };
};

describe("a reply saved as several rows", () => {
  it("is announced whole, without the rows that are not words", () => {
    const rows = [question(), say("a", "I checked the north fence."), tool("t"), { ...say("n", "Checking the gate."), interim: true }, say("b", "The gate latch is loose.")];
    expect(announced({ lastId: "q" }, rows).said).toBe("I checked the north fence. The gate latch is loose.");
  });

  it("is shortened to the announcement's length limit after it is joined", () => {
    const first = "alpha ".repeat(20).trim(), second = "bravo ".repeat(20).trim();
    const { said } = announced({ lastId: "q" }, [question(), say("a", first), tool("t"), say("b", second)]);
    // 200 characters of the joined reply, which runs into the second segment, then an ellipsis.
    expect(said).toContain(`${first} bravo`);
    expect(said!.endsWith("…")).toBe(true);
    expect(said!.length).toBe(201);
  });

  it("is only the newest turn's rows when two turns finished between reads", () => {
    const rows = [question("q1"), say("a1", "First answer."), question("q2"), say("a2", "Second answer."), tool("t"), say("b2", "More of the second.")];
    expect(announced({ lastId: "q1" }, rows).said).toBe("Second answer. More of the second.");
  });

  it("keeps the id of its last row, which is how the screen reader tells replies apart", () => {
    expect(announced({ lastId: "q" }, [question(), say("a", "One."), say("b", "Two.")]).reply?.id).toBe("b");
  });
});

describe("a reply that was already heard", () => {
  // The live reply's text is the whole of it so far, and its separators differ from the saved rows'.
  it("is not read again when its saved rows replace the unsaved copy of all of it", () => {
    const live: Message = { id: "run-inflight", role: "assistant", text: "I checked the north fence.\nThe gate latch is loose." };
    const first = watchReplies({ lastId: "q" }, conversation([question(), live], "thinking"), false);
    expect(first.reply).toBeUndefined();
    const done = announced(watchReplies(first.watch, conversation([question(), live]), false).watch, [question(), say("a", "I checked the north fence."), tool("t"), say("b", "The gate latch is loose.")]);
    expect(done.reply).toBeUndefined();
  });

  it("reads only the rows after the part that was read", () => {
    const heard = { text: "I checked the north fence.", turn: "q" };
    const result = announced({ lastId: "q", heard }, [question(), say("a", "I checked the north fence."), tool("t"), say("b", "The gate latch is loose.")]);
    expect(result.said).toBe("The gate latch is loose.");
  });

  it("stays silent for rows that end with what was read, as one row always did", () => {
    const heard = { text: "The gate latch is loose.", turn: "q" };
    expect(announced({ lastId: "q", heard }, [question(), say("a", "I checked the north fence."), tool("t"), say("b", "The gate latch is loose.")]).reply).toBeUndefined();
  });

  it.each([
    ["words that are not in the reply", { text: "Something else entirely.", turn: "q" }],
    ["the same words in an earlier turn", { text: "The gate latch is loose.", turn: "earlier" }],
  ])("is read in full after %s were heard", (_name, heard) => {
    const result = announced({ lastId: "q", heard }, [question(), say("a", "I checked the north fence."), tool("t"), say("b", "The gate latch is loose.")]);
    expect(result.said).toBe("I checked the north fence. The gate latch is loose.");
  });
});

describe("a reply that grows across reads", () => {
  const first = [question(), say("a", "I checked the north fence.")];

  it("waits while the assistant works, then joins the segment a later read adds", () => {
    const waiting = announced({ lastId: "q" }, first, "working");
    expect(waiting.reply).toBeUndefined();
    expect(waiting.watch.waiting?.text).toBe("I checked the north fence.");
    const done = announced(waiting.watch, [...first, tool("t"), say("b", "The gate latch is loose.")]);
    expect(done.said).toBe("I checked the north fence. The gate latch is loose.");
    expect(done.watch.waiting).toBeUndefined();
  });

  it("joins every segment that arrives while it waits, once each", () => {
    const one = announced({ lastId: "q" }, first, "working");
    const two = announced(one.watch, [...first, tool("t"), say("b", "The gate latch is loose.")], "working");
    expect(two.reply).toBeUndefined();
    const done = announced(two.watch, [...first, tool("t"), say("b", "The gate latch is loose."), tool("u"), say("c", "It needs a new hinge.")]);
    expect(done.said).toBe("I checked the north fence. The gate latch is loose. It needs a new hinge.");
  });

  // Hermes saves a row under one id and rewrites it as the text streams in.
  it("reads a held row as it ended up, with the rows before it, when it grew in place while the assistant worked", () => {
    const one = announced({ lastId: "q" }, [question(), say("a", "I checked."), tool("t"), say("b", "The gate")], "working");
    const two = announced(one.watch, [question(), say("a", "I checked."), tool("t"), say("b", "The gate latch is loose.")], "working");
    expect(two.reply).toBeUndefined();
    expect(announced(two.watch, [question(), say("a", "I checked."), tool("t"), say("b", "The gate latch is loose.")]).said).toBe("I checked. The gate latch is loose.");
  });

  it("reads a held row as it grew before joining the segment a later read adds", () => {
    const one = announced({ lastId: "q" }, [question(), say("a", "Checking")], "working");
    const two = announced(one.watch, [question(), say("a", "Checking. All clear.")], "working");
    expect(announced(two.watch, [question(), say("a", "Checking. All clear."), tool("t"), say("b", "Gate shut.")]).said).toBe("Checking. All clear. Gate shut.");
  });

  it("announces the held segment alone when the next read adds nothing and the assistant has finished", () => {
    const waiting = announced({ lastId: "q" }, first, "working");
    expect(announced(waiting.watch, first).said).toBe("I checked the north fence.");
  });

  it("drops a held reply from an earlier turn when a new turn's reply arrives", () => {
    const waiting = announced({ lastId: "q" }, first, "working");
    const next = [...first, question("q2"), say("b", "Second answer.")];
    expect(announced(waiting.watch, next).said).toBe("Second answer.");
  });

  describe("while its last segment is still streaming", () => {
    const streaming = (text: string): Message => ({ id: "run-inflight", role: "assistant", text });
    const intro = [question(), say("a", "Intro."), tool("t")];

    it("keeps the held segment when the saved last segment replaces the streaming one", () => {
      const held = announced({ lastId: "q" }, [question(), say("a", "Intro.")], "working");
      const streamed = announced(held.watch, [...intro, streaming("Answ")], "working");
      expect(streamed.reply).toBeUndefined();
      expect(announced(streamed.watch, [...intro, say("b", "Answer.")]).said).toBe("Intro. Answer.");
    });

    it("keeps it through every read that sees the last segment grow", () => {
      let { watch } = announced(announced({ lastId: "q" }, [question(), say("a", "Intro.")], "working").watch, [...intro, streaming("Answ")], "working");
      ({ watch } = announced(watch, [...intro, streaming("Answer, ple")], "working"));
      ({ watch } = announced(watch, [...intro, say("b", "Answer, please."), tool("u"), streaming("More")], "working"));
      expect(announced(watch, [...intro, say("b", "Answer, please."), tool("u"), say("c", "More.")]).said).toBe("Intro. Answer, please. More.");
    });

    it("reads the held and saved segments with the streaming last one when the turn finishes before it is saved", () => {
      const held = announced({ lastId: "q" }, [question(), say("a", "Intro.")], "working");
      const done = announced(held.watch, [...intro, say("m", "Middle."), streaming("Answer.")]);
      expect(done.said).toBe("Intro. Middle. Answer.");
      expect(done.reply?.id).toBe("run-inflight");
      // Saved later, it is the same words and is not read again.
      expect(announced(done.watch, [...intro, say("m", "Middle."), say("b", "Answer.")]).reply).toBeUndefined();
    });

    it("reads the saved rows ahead of a streaming tail that no read held", () => {
      expect(announced({ lastId: "q" }, [question(), say("a", "Intro."), tool("t"), streaming("Answer.")]).said).toBe("Intro. Answer.");
    });

    it("drops a held segment of an earlier turn when the next turn's reply is streaming", () => {
      const held = announced({ lastId: "q" }, [question(), say("a", "Intro.")], "working");
      expect(announced(held.watch, [question(), say("a", "Intro."), question("q2"), streaming("Second answer.")]).said).toBe("Second answer.");
    });
  });
});
