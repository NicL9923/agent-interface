import { describe, expect, it } from "vitest";
import { awaitingTurn, COPY_HANDOFF_MS, ECHO_PATIENCE, nextEcho, nextEchoes, restoreSent, SENDING_ROW_MS, sendingDraft, withEchoes } from "../src/app/sent-echo";
import type { SentEcho } from "../src/app/sent-echo";
import type { Pending, SavedConversation } from "../src/app/storage";
import type { Message, SubmissionReceipt } from "../src/shared/types";

const sender = { id: "one", name: "One" };
const request: Pending = { requestId: "req", botId: "bot", text: "Hello there", attachments: [], reviewedInterruption: false };
const conversation = (messages: Message[] = [{ id: "a", role: "assistant", text: "Hi" }], state: SavedConversation["activity"]["state"] = "idle"): SavedConversation =>
  ({ botId: "bot", messages, approvals: [], files: [], activity: { state }, draft: null, readPosition: null });
const step = (echo: SentEcho | null, input: Partial<Parameters<typeof nextEcho>[1]>) =>
  nextEcho(echo, { pending: null, receipt: null, sending: false, conversation: conversation(), sender, now: 1000, ...input });
const accepted: SubmissionReceipt = { requestId: "req", status: "accepted", messageId: "row-9" };
const sending = step(null, { pending: request, sending: true })!;

describe("sent message echo", () => {
  it("appears for a new send after the last message shown", () => {
    expect(sending).toMatchObject({ status: "sending", after: "a", sentAt: new Date(1000).toISOString() });
    const shown = withEchoes(conversation(), [sending])!;
    expect(shown.messages.at(-1)).toMatchObject({ id: "req", role: "user", text: "Hello there", sender });
  });

  it("says a steered message joined the running task before Hermes's copy arrives, and an unknown one says nothing", () => {
    const steered = step(sending, { receipt: { ...accepted, steered: true } })!;
    expect(withEchoes(conversation(), [steered])!.messages.at(-1)!.steered).toBe(true);
    for (const receipt of [accepted, { ...accepted, steered: false }]) {
      const plain = step(sending, { receipt })!;
      expect(withEchoes(conversation(), [plain])!.messages.at(-1)).not.toHaveProperty("steered");
    }
  });

  it("waits unconfirmed when the request ends without a receipt", () => {
    expect(step(sending, { pending: request })?.status).toBe("unconfirmed");
  });

  it.each<SubmissionReceipt | null>([
    { requestId: "req", status: "rejected" },
    { requestId: "req", status: "interrupted" },
    { requestId: "older", status: "accepted" },
    null,
  ])("leaves with a send that did not go through: %j", (receipt) => {
    expect(step(sending, { receipt })).toBeNull();
  });

  it("stays after acceptance until Hermes's copy arrives by request or row ID", () => {
    const kept = step(sending, { receipt: accepted })!;
    expect(kept).toMatchObject({ status: "accepted", messageId: "row-9", acceptedAt: 1000 });
    for (const id of ["req", "row-9"]) {
      const arrived = conversation([{ id: "a", role: "assistant", text: "Hi" }, { id, role: "user", text: "Hello there" }], "thinking");
      expect(step(kept, { receipt: accepted, conversation: arrived })).toBeNull();
      expect(withEchoes(arrived, [kept])).toBe(arrived);
    }
  });

  it("matches an accepted copy by its words only after the message last shown", () => {
    const earlier = { id: "u0", role: "user" as const, text: "Hello there", sender };
    const kept = step(null, { pending: request, sending: true, conversation: conversation([earlier]) })!;
    const acceptedEcho = step(kept, { receipt: accepted, conversation: conversation([earlier]) })!;
    expect(acceptedEcho).not.toBeNull();
    const saved = conversation([earlier, { id: "u1", role: "user", text: " Hello there ", sender }], "thinking");
    expect(step(acceptedEcho, { receipt: accepted, conversation: saved })).toBeNull();
    const someoneElse = conversation([earlier, { id: "u1", role: "user", text: "Hello there", sender: { id: "two", name: "Two" } }], "thinking");
    expect(step(acceptedEcho, { receipt: accepted, conversation: someoneElse })).not.toBeNull();
  });

  it("stands in for a prompt saved only when its run ends", () => {
    let echo = step(sending, { receipt: accepted })!;
    echo = step(echo, { receipt: accepted, conversation: conversation(undefined, "working"), now: 90_000 })!;
    expect(echo.ran).toBe(true);
    expect(step(echo, { receipt: accepted, conversation: conversation(undefined, "done"), now: 120_000 })).toBeNull();
  });

  it("gives up on an accepted message whose run never shows", () => {
    const echo = step(sending, { receipt: accepted })!;
    expect(step(echo, { receipt: accepted, now: 1000 + ECHO_PATIENCE })).not.toBeNull();
    expect(step(echo, { receipt: accepted, now: 1001 + ECHO_PATIENCE })).toBeNull();
  });

  it("is drawn only in its own assistant's conversation", () => {
    const other = { ...conversation(), botId: "other" };
    expect(withEchoes(other, [sending])).toBe(other);
    expect(step(sending, { pending: request, sending: true, conversation: other })).toBe(sending);
  });

  it("hands the composer back only while the sent copy is the draft", () => {
    const draft = { text: "Hello there", attachments: [], botId: "bot", userId: "one" };
    expect(sendingDraft(draft, request, true)).toBe(true);
    expect(sendingDraft(draft, request, false)).toBe(false);
    expect(sendingDraft({ ...draft, text: "Something new" }, request, true)).toBe(false);
    // Marked by its send, only the untouched copy counts, not the same words typed again.
    const marked = { ...draft, seq: 4, sentHash: "h", sentSeq: 4 };
    expect(sendingDraft(marked, request, true)).toBe(true);
    expect(sendingDraft({ ...marked, seq: 9 }, request, true)).toBe(false);
    expect(sendingDraft({ ...marked, sentHash: undefined }, request, true)).toBe(false);
  });

  it("restores a refused message in front of newer text, once", () => {
    const file = { id: "f1", name: "a.png", mime: "image/png" };
    const sent = { text: "Hello there", attachments: [file] };
    const typed = { text: "Next", attachments: [], botId: "bot", seq: 3 };
    const restored = restoreSent(typed, sent);
    expect(restored).toMatchObject({ text: "Hello there\n\nNext", attachments: [file], dirty: true, seq: 3 });
    expect(restoreSent(restored, sent)).toBe(restored);
    const untouched = { text: "Hello there", attachments: [file] };
    expect(restoreSent(untouched, sent)).toBe(untouched);
  });

  it("leaves when another person signs in", () => {
    const kept = step(sending, { receipt: accepted })!;
    expect(step(kept, { receipt: null, sender: { id: "two", name: "Two" } })).toBeNull();
    expect(step(kept, { receipt: null, sender: undefined })).toBeNull();
  });

  it("anchors on a saved message, and never matches words once its anchor is gone", () => {
    const live = conversation([{ id: "u0", role: "user", text: "continue", sender }, { id: "s-inflight", role: "assistant", text: "Working" }], "working");
    const echo = step(null, { pending: { ...request, text: "continue" }, sending: true, conversation: live })!;
    expect(echo.after).toBe("u0");
    const unanchored = { ...echo, after: "gone", status: "accepted" as const };
    expect(step(unanchored, { receipt: { requestId: "req", status: "accepted" }, conversation: conversation([{ id: "u0", role: "user", text: "continue", sender }], "working") })).not.toBeNull();
  });

  it("keeps an accepted message that is not saved yet while another is sent", () => {
    const photo: Pending = { ...request, requestId: "photo", text: "", attachments: [{ id: "f1", name: "a.png", mime: "image/png" }] };
    const guidance: Pending = { ...request, requestId: "guide", text: "Also check the gate" };
    const accept = (requestId: string): SubmissionReceipt => ({ requestId, status: "accepted" });
    const steps = (echoes: SentEcho[], input: Partial<Parameters<typeof nextEchoes>[1]>) =>
      nextEchoes(echoes, { pending: null, receipt: null, sending: false, conversation: conversation(undefined, "working"), sender, now: 1000, ...input });
    let echoes = steps([], { pending: photo, sending: true });
    echoes = steps(echoes, { receipt: accept("photo") });
    expect(steps(echoes, { receipt: accept("photo") })).toBe(echoes);
    echoes = steps(echoes, { pending: guidance, sending: true, receipt: accept("photo") });
    expect(echoes.map(echo => [echo.request.requestId, echo.status])).toEqual([["photo", "accepted"], ["guide", "sending"]]);
    expect(withEchoes(conversation(undefined, "working"), echoes)!.messages.map(message => message.id)).toEqual(["a", "photo", "guide"]);
    // Guidance refused: the photo stays; its run ends and its row is saved.
    echoes = steps(echoes, { receipt: { requestId: "guide", status: "rejected" } });
    expect(echoes.map(echo => echo.request.requestId)).toEqual(["photo"]);
    expect(steps(echoes, { conversation: conversation(undefined, "done") })).toEqual([]);
  });

  it("shows the same words sent twice until Hermes has each", () => {
    const first = { ...sending, status: "accepted" as const };
    const second = { ...first, request: { ...first.request, requestId: "req-2" } };
    expect(withEchoes(conversation(undefined, "working"), [first, second])!.messages.map(message => message.id)).toEqual(["a", "req", "req-2"]);
  });
});

describe("the assistant thinking before Hermes reports the turn", () => {
  const acceptedEcho = step(sending, { receipt: accepted })!;
  it("shows while a message sent to an idle chat is on its way, and after Hermes accepts it until the turn shows", () => {
    expect(awaitingTurn([sending], conversation(), 1000)).toBe(true);
    expect(awaitingTurn([acceptedEcho], conversation(), 1000)).toBe(true);
    // A finished or failed turn before it does not count as work: the new message starts another.
    for (const state of ["done", "failed", "interrupted"] as const) expect(awaitingTurn([sending], conversation(undefined, state), 1000)).toBe(true);
  });

  // Each case is one reason the row must not be there.
  it.each<[string, SentEcho[], SavedConversation | null]>([
    ["no conversation is loaded", [sending], null],
    ["nothing was sent", [], conversation()],
    ["Hermes reports the turn's own work", [sending], conversation(undefined, "working")],
    ["the message went to another assistant", [{ ...sending, request: { ...request, botId: "other" } }], conversation()],
    ["it ended without a receipt", [step(sending, { pending: request })!], conversation()],
    ["Hermes steered it into the running task", [step(sending, { receipt: { ...accepted, steered: true } })!], conversation()],
    ["it was sent while the chat showed work", [step(null, { pending: request, sending: true, conversation: conversation(undefined, "working") })!], conversation()],
    ["its turn already showed work", [{ ...acceptedEcho, ran: true }], conversation()],
    ["Hermes's copy is in the chat with a reply after it",
      [acceptedEcho], conversation([{ id: "a", role: "assistant", text: "Hi" }, { id: "row-9", role: "user", text: "Hello there" }, { id: "b", role: "assistant", text: "Done" }])],
    ["its request has been out longer than the bound", [{ ...sending, slow: true }], conversation()],
  ])("does not show when %s", (_, echoes, shown) => {
    expect(awaitingTurn(echoes, shown, 1000)).toBe(false);
  });

  const copied = conversation([{ id: "a", role: "assistant", text: "Hi" }, { id: "row-9", role: "user", text: "Hello there" }]);
  it("stays while Hermes's copy is in the chat before the turn's report, and only for the handoff bound", () => {
    const kept = step(acceptedEcho, { receipt: accepted, conversation: copied, now: 2000 })!;
    expect(kept).toMatchObject({ copiedAt: 2000 });
    expect(awaitingTurn([kept], copied, 2000)).toBe(true);
    // The copy is Hermes's, so the echo is not drawn a second time.
    expect(withEchoes(copied, [kept])).toBe(copied);
    expect(step(kept, { receipt: accepted, conversation: copied, now: 2000 + COPY_HANDOFF_MS - 1 })).toBe(kept);
    expect(step(kept, { receipt: accepted, conversation: copied, now: 2000 + COPY_HANDOFF_MS })).toBeNull();
    // The report takes over, and a steered or already-run message never stood for a new turn.
    expect(step(kept, { receipt: accepted, conversation: { ...copied, activity: { state: "thinking" } }, now: 2100 })).toBeNull();
    expect(step({ ...acceptedEcho, steered: true }, { receipt: accepted, conversation: copied, now: 2000 })).toBeNull();
    // Only a message Hermes accepted hands off: one still on its way leaves with its copy, as before.
    expect(step(sending, { pending: request, sending: true, conversation: conversation([{ id: "req", role: "user", text: "Hello there" }]) })).toBeNull();
  });

  it("marks a request out for the bound as slow, and starts the bound again when a retry goes out", () => {
    const out = (echo: SentEcho, now: number, isSending = true) => step(echo, { pending: request, sending: isSending, now })!;
    expect(out(sending, 1000 + SENDING_ROW_MS - 1)).toBe(sending);
    const slow = out(sending, 1000 + SENDING_ROW_MS);
    expect(slow).toMatchObject({ status: "sending", slow: true });
    const unconfirmed = out(slow, 9000, false);
    const retried = out(unconfirmed, 20_000);
    expect(retried).toMatchObject({ status: "sending", slow: false, sendingSince: 20_000 });
    expect(awaitingTurn([retried], conversation(), 20_000)).toBe(true);
  });
  // What tells this turn's outcome from the last one's: a read that began after the one that brought the copy.
  const settled = (state: "done" | "failed" | "interrupted", version?: string): SavedConversation =>
    ({ ...copied, activity: { state }, ...version ? { version } : {} });
  // While Hermes admits a message it has saved the copy and not opened the run, so that read reports the turn before.
  // What the chat showed at the send cannot tell the two apart: a cached chat or one not yet loaded shows something else.
  it.each<[string, SavedConversation | null]>([
    ["an idle chat", conversation()],
    ["a finished turn", { ...conversation(undefined, "done"), version: "b:0:4" }],
    ["the same failure", { ...conversation(undefined, "failed"), version: "b:0:4" }],
    ["no conversation yet", null],
    ["another chat", { ...conversation(), botId: "other" }],
  ])("keeps the row through a settled report in the read that brings the copy, when the message was sent from %s", (_, shownAtSend) => {
    const sent = step(step(null, { pending: request, sending: true, conversation: shownAtSend }), { receipt: accepted, conversation: shownAtSend })!;
    for (const state of ["failed", "interrupted", "done"] as const) {
      const kept = step(sent, { receipt: accepted, conversation: settled(state, "b:0:5"), now: 2000 })!;
      expect(kept).toMatchObject({ copiedAt: 2000, copiedVersion: "b:0:5" });
      expect(awaitingTurn([kept], settled(state, "b:0:5"), 2000)).toBe(true);
    }
  });

  it("ends on a settled report from a later read, and only one the server's version can order after the copy's", () => {
    const kept = step(acceptedEcho, { receipt: accepted, conversation: settled("failed", "b:0:5"), now: 2000 })!;
    for (const state of ["failed", "interrupted", "done"] as const) {
      // A read that began after the one that brought the copy reports this turn, so its outcome is the turn's own.
      expect(awaitingTurn([kept], settled(state, "b:0:6"), 2100)).toBe(false);
      expect(step(kept, { receipt: accepted, conversation: settled(state, "b:0:6"), now: 2100 })).toBeNull();
      // The same read again, an older one, another server process's, or one without a version orders nothing.
      for (const version of ["b:0:5", "b:0:4", "c:0:9", undefined]) {
        expect(awaitingTurn([kept], settled(state, version), 2100)).toBe(true);
        expect(step(kept, { receipt: accepted, conversation: settled(state, version), now: 2100 })).toBe(kept);
      }
    }
    // A copy that came in a read without a version is never ordered before a later one; the handoff bound ends it.
    const unversioned = step(acceptedEcho, { receipt: accepted, conversation: settled("failed"), now: 2000 })!;
    expect(awaitingTurn([unversioned], settled("failed", "b:0:6"), 2100)).toBe(true);
    expect(step(unversioned, { receipt: accepted, conversation: settled("failed", "b:0:6"), now: 2000 + COPY_HANDOFF_MS })).toBeNull();
  });

  // The clock runs while another chat is open, so a return never paints a row whose bound has passed.
  it("treats a bound as over by the clock alone, even before the echo is stepped or while another chat is open", () => {
    const kept = step(acceptedEcho, { receipt: accepted, conversation: copied, now: 2000 })!;
    expect(awaitingTurn([kept], copied, 2000 + COPY_HANDOFF_MS - 1)).toBe(true);
    expect(awaitingTurn([kept], copied, 2000 + COPY_HANDOFF_MS)).toBe(false);
    expect(awaitingTurn([sending], conversation(), 1000 + SENDING_ROW_MS - 1)).toBe(true);
    expect(awaitingTurn([sending], conversation(), 1000 + SENDING_ROW_MS)).toBe(false);
    const elsewhere = { ...conversation(), botId: "other" };
    expect(step(kept, { receipt: accepted, conversation: elsewhere, now: 2000 + COPY_HANDOFF_MS - 1 })).toBe(kept);
    expect(step(kept, { receipt: accepted, conversation: elsewhere, now: 2000 + COPY_HANDOFF_MS })).toBeNull();
  });
});
