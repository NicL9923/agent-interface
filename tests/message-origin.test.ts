import { describe, expect, it } from "vitest";
import { isActivityMessage, messageOrigin, wireOrigin, withMessageOrigins } from "../src/shared/message-origin";
import { watchReplies } from "../src/app/reply-announcement";
import type { Message } from "../src/shared/types";

const cron = '[Cronjob "[bot:kimberly] Bunny care & gentle daily plan" output — scheduled job, not the user. Review it, act on anything that needs action, and summarize for the chat.]\n\nTop up hay.';
const user = (text: string, id = "u"): Message => ({ id, role: "user", text });
describe("message provenance", () => {
  it("keeps the cron handoff inspectable and the scheduled answer visible, then resets for a human", () => {
    const rows = withMessageOrigins([user(cron), { id: "scheduled", role: "assistant", text: "Check the bunnies first." }, user("What about lunch?", "human"), { id: "answer", role: "assistant", text: "Soup." }]);
    expect(rows.map(row => row.origin?.visibility)).toEqual(["activity", "conversation", undefined, undefined]);
    expect(rows[1].origin).toMatchObject({ kind: "scheduled", title: "[bot:kimberly] Bunny care & gentle daily plan" });
    expect(rows[0].text).toBe(cron);
  });
  it("preserves unknown external messages and human-authored lookalikes", () => {
    for (const text of ["Hi from Desktop", "[Cronjob] arbitrary text", "I saw a Message from 🤖 Planner: yesterday"]) expect(isActivityMessage(user(text))).toBe(false);
    expect(isActivityMessage({ ...user(cron), sender: { id: "one", name: "Nicolas" } })).toBe(false);
    expect(wireOrigin(user(cron), { app_sender_id: "one", display_metadata: { notification_category: "diagnostic" } })).toEqual({ kind: "human", visibility: "conversation" });
  });
  it("honors structured provenance and keeps bot replies and diagnostics in activity", () => {
    const prompt = user("Native delivery");
    prompt.origin = wireOrigin(prompt, { display_metadata: { origin: { kind: "agent", visibility: "activity", name: "Ledger", handle: "ledger" } } });
    const rows = withMessageOrigins([prompt, { id: "reply", role: "assistant", text: "Balance 42" }]);
    expect(rows.every(isActivityMessage)).toBe(true);
    expect(wireOrigin(user("Native event"), { display_kind: "async_delegation_complete", display_metadata: { display_text: "Subagent Task Completed: Review" } })).toEqual({ kind: "subagent", visibility: "activity", title: "Subagent Task Completed: Review" });
    expect(wireOrigin(user("Future event"), { display_kind: "new_unknown_kind" })).toBeUndefined();
  });
  it("shows resumed answers while collapsing the resume prompt and recognizes legacy delegation", () => {
    const prompt = user("Resume the interrupted turn.");
    prompt.origin = wireOrigin(prompt, { display_kind: "auto_continue" });
    const rows = withMessageOrigins([prompt, { id: "answer", role: "assistant", text: "The report is complete." }]);
    expect(rows.map(isActivityMessage)).toEqual([true, false]);
    for (const text of ["[ASYNC DELEGATION COMPLETE — task-1] Result", "[ASYNC BATCH COMPLETE — batch-1] Result", "A background subagent you dispatched earlier has finished."]) {
      expect(wireOrigin(user(text), { display_kind: "internal_notification" })?.kind).toBe("subagent");
    }
  });
  it("keeps bot handoffs separate from delegation, including tool batches", () => {
    expect(messageOrigin({ id: "dm", role: "tool", text: "", toolName: "message_agent, web_search" })?.kind).toBe("agent");
    expect(messageOrigin({ id: "child", role: "tool", text: "", toolName: "delegate_task" })?.kind).toBe("subagent");
  });
  it("does not announce diagnostic activity but announces the useful scheduled answer", () => {
    const base = { botId: "kimberly", activity: { state: "idle" as const }, approvals: [], files: [] };
    const diagnostic: Message = { id: "d", role: "assistant", text: "Internal failure details", origin: { kind: "diagnostic", visibility: "activity" } };
    expect(watchReplies({}, { ...base, messages: [diagnostic] }, false).reply).toBeUndefined();
    const answer: Message = { ...diagnostic, id: "s", text: "Your reminder is ready.", origin: { kind: "scheduled", visibility: "conversation" } };
    expect(watchReplies({}, { ...base, messages: [answer] }, false).reply?.id).toBe("s");
  });
});
