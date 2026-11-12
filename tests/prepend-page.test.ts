import { describe, expect, it } from "vitest";
import { prependPage } from "../src/app/conversation-page";
import type { ConversationPage } from "../src/shared/api";
import type { FileRef, Message } from "../src/shared/types";

const file = (n: number): FileRef => ({ id: `f${n}`, name: `fence-${n}.png`, mime: "image/png", url: `/api/files/f${n}` });
const turn = (n: number, files: FileRef[] = []): Message[] => [{ id: `p${n}`, role: "user", text: `Prompt ${n}` },
  { id: `a${n}`, role: "assistant", text: `Reply ${n}`, ...files.length ? { files } : {} }];
const page = (messages: Message[], extra: Partial<ConversationPage> = {}): ConversationPage => ({ botId: "shared", messages, files: [], approvals: [], activity: { state: "idle" },
  draft: null, readPosition: null, ...extra });

describe("an earlier page in front of the view", () => {
  // The view a chat holds: a running turn after p2, with this person's draft and the live state its reads left.
  const view = { ...page([...turn(2, [file(2)]), { id: "sid-inflight", role: "assistant", text: "Checking" }], { files: [file(2)], earlier: 4, earlierFiles: 2,
    version: "b:1:9", activity: { state: "thinking", runId: "run-3" }, draft: { text: "Unsent", attachments: [], revision: 3, reason: "edit", sentRevision: 0 } }) };

  it("puts the page's messages before the one it was read before, and takes its counts and files, each once and in order", () => {
    // f2 is also passed on in the page, by a reply the view's own messages come after.
    const earlier = page([...turn(0, [file(0)]), ...turn(1, [file(1), file(2)])], { files: [file(0), file(1), file(2)], earlier: 0, earlierFiles: 0,
      version: "b:1:7", activity: { state: "idle" }, draft: null, before: "p2" });
    const shown = prependPage(view, earlier, "p2")!;
    expect(shown.messages.map(message => message.id)).toEqual(["p0", "a0", "p1", "a1", "p2", "a2", "sid-inflight"]);
    expect(shown).toMatchObject({ earlier: 0, earlierFiles: 0 });
    expect(shown.files!.map(item => item.id)).toEqual(["f0", "f1", "f2"]);
    // Everything else stays as the view's reads left it: an earlier page carries no running turn.
    expect(shown).toMatchObject({ version: "b:1:9", activity: { state: "thinking", runId: "run-3" }, draft: { text: "Unsent" } });
  });

  it("drops whatever the view holds before that message, which the page holds itself", () => {
    const held = { ...view, messages: [{ id: "a1", role: "assistant" as const, text: "Reply 1" }, ...view.messages] };
    expect(prependPage(held, page(turn(1), { earlier: 2 }), "p2")!.messages.map(message => message.id)).toEqual(["p1", "a1", "p2", "a2", "sid-inflight"]);
  });

  it("places nothing when the view no longer holds that message", () => {
    expect(prependPage(view, page(turn(0), { before: "p9" }), "p9")).toBeUndefined();
  });
});
