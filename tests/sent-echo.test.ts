import { describe, expect, it } from "vitest";
import { ECHO_PATIENCE, nextEcho, nextEchoes, restoreSent, sendingDraft, withEchoes } from "../src/app/sent-echo";
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
