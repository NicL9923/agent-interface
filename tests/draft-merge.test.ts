import { describe, expect, it } from "vitest";
import { mergeDraft, savedCopy, savedDraft } from "../src/app/draft-merge";
import { sentCopy } from "../src/app/storage";
import type { SavedDraft } from "../src/shared/types";

const server = (text: string, revision: number, sentRevision = 0): SavedDraft =>
  ({ text, attachments: [], revision, reason: sentRevision === revision && revision ? "sent" : "edit", sentRevision });
const local = { text: "Typed here", attachments: [], botId: "ranch", userId: "one" };

describe("draft merge", () => {
  it("adopts the server draft into a clean copy", () => {
    expect(mergeDraft({ ...local, baseRevision: 2 }, server("From the phone", 3))).toEqual({
      draft: { text: "From the phone", attachments: [], botId: "ranch", userId: "one", baseRevision: 3, dirty: false }, push: false,
    });
  });

  it("drops unsaved edits once a send cleared the draft after their base", () => {
    const merged = mergeDraft({ ...local, dirty: true, baseRevision: 2 }, server("", 4, 3));
    expect(merged).toMatchObject({ draft: { text: "", dirty: false, baseRevision: 4 }, push: false });
    // A copy from before revisions existed counts as revision 0.
    expect(mergeDraft({ ...local, dirty: true }, server("", 1, 1)).draft.text).toBe("");
  });

  it("keeps edits typed after this device's own send, whose clear the server reports as newer", () => {
    expect(mergeDraft({ ...local, dirty: true, baseRevision: 2, sentHere: true }, server("", 3, 3), true)).toEqual({
      draft: { ...local, dirty: true, baseRevision: 3, sentHere: undefined }, push: true,
    });
  });

  it("keeps edits typed here over another device's newer edit and saves them on its revision", () => {
    expect(mergeDraft({ ...local, dirty: true, baseRevision: 2 }, server("Phone edit", 5, 1), true)).toEqual({
      draft: { ...local, dirty: true, baseRevision: 5, sentHere: undefined }, push: true,
    });
  });

  it("leaves unsaved edits alone while the server is still on their base", () => {
    const copy = { ...local, dirty: true, baseRevision: 2 };
    expect(mergeDraft(copy, server("Older text", 2))).toEqual({ draft: copy, push: false });
  });

  it("marks matching text saved instead of saving it again", () => {
    expect(mergeDraft({ ...local, dirty: true, baseRevision: 1 }, server("Typed here", 4), true))
      .toMatchObject({ draft: { dirty: false, baseRevision: 4 }, push: false });
  });

  it("ignores a load older than this copy, but not the server's answer to a conflict", () => {
    const copy = { ...local, baseRevision: 7 };
    expect(mergeDraft(copy, server("Older read", 6))).toEqual({ draft: copy, push: false });
    // After a database restore the server's revision is lower; edits still save on it.
    expect(mergeDraft({ ...copy, dirty: true }, server("Restored", 2), true)).toMatchObject({ draft: { text: "Typed here", baseRevision: 2 }, push: true });
  });

  it("records a save without losing edits typed while it was in flight", () => {
    const sent = { text: "Typed", attachments: [] };
    expect(savedCopy({ ...local, text: "Typed", dirty: true, baseRevision: 1, sentHere: true }, sent, server("Typed", 2)))
      .toMatchObject({ dirty: false, baseRevision: 2, sentHere: undefined });
    expect(savedCopy({ ...local, dirty: true, baseRevision: 1 }, sent, server("Typed", 2))).toMatchObject({ text: "Typed here", dirty: true, baseRevision: 2 });
    const newer = { ...local, baseRevision: 5 };
    expect(savedCopy(newer, sent, server("Typed", 2))).toBe(newer);
  });

  it("empties a sent copy but keeps its base, and marks later typing as sent from here", () => {
    const sent = { text: "Typed here", attachments: [] };
    expect(sentCopy({ ...local, baseRevision: 3 }, sent)).toEqual({ text: "", attachments: [], botId: "ranch", userId: "one", baseRevision: 3, sentHere: true });
    expect(sentCopy({ ...local, text: "More", dirty: true, baseRevision: 3 }, sent)).toMatchObject({ text: "More", dirty: true, sentHere: true });
  });

  it("reads a missing draft or a server without revisions as revision 0", () => {
    expect(savedDraft(null)).toEqual({ text: "", attachments: [], revision: 0, reason: "edit", sentRevision: 0 });
    expect(savedDraft({ text: "Old server", attachments: [] })).toMatchObject({ text: "Old server", revision: 0 });
  });
});
