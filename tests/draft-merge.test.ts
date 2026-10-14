import { describe, expect, it } from "vitest";
import { contentHash, mergeDraft, savedCopy, savedDraft } from "../src/app/draft-merge";
import { sentCopy } from "../src/app/storage";
import type { SavedDraft } from "../src/shared/types";

const server = (text: string, revision: number, sentRevision = 0): SavedDraft =>
  ({ text, attachments: [], revision, reason: sentRevision === revision && revision ? "sent" : "edit", sentRevision });
const local = { text: "Typed here", attachments: [], botId: "ranch", userId: "one" };

const hashOf = (text: string) => contentHash({ text, attachments: [] });

describe("draft merge", () => {
  it("adopts the server draft into a clean copy", () => {
    expect(mergeDraft({ ...local, baseRevision: 2 }, server("From the phone", 3))).toEqual({
      draft: { text: "From the phone", attachments: [], botId: "ranch", userId: "one", baseRevision: 3, baseHash: hashOf("From the phone"), dirty: false }, push: false,
    });
  });

  it("returns the same copy when nothing changed, so a refresh does not re-render", () => {
    const copy = { ...local, baseRevision: 3, baseHash: hashOf("Typed here") };
    expect(mergeDraft(copy, server("Typed here", 3)).draft).toBe(copy);
  });

  it("drops an unsaved copy still holding its base content once a send cleared the draft after that base", () => {
    const merged = mergeDraft({ ...local, dirty: true, baseRevision: 2, baseHash: hashOf("Typed here") }, server("", 4, 3));
    expect(merged).toMatchObject({ draft: { text: "", dirty: false, baseRevision: 4 }, push: false });
  });

  it("keeps work changed since its base when another device sends, and saves it on the new revision", () => {
    const offline = { ...local, text: "Offline note", dirty: true, baseRevision: 2, baseHash: hashOf("Shared plan") };
    expect(mergeDraft(offline, server("", 3, 3), true)).toEqual({
      draft: { ...offline, baseRevision: 3, baseHash: hashOf(""), sentHere: undefined }, push: true,
    });
    // A copy from before fingerprints cannot be shown unchanged, so it is kept.
    expect(mergeDraft({ ...local, dirty: true }, server("", 1, 1), true).draft.text).toBe("Typed here");
  });

  it("keeps edits typed here over another device's newer edit and saves them on its revision", () => {
    expect(mergeDraft({ ...local, dirty: true, baseRevision: 2 }, server("Phone edit", 5, 1), true)).toMatchObject({
      draft: { text: "Typed here", dirty: true, baseRevision: 5, baseHash: hashOf("Phone edit") }, push: true,
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
    expect(savedCopy({ ...local, text: "Typed", dirty: true, baseRevision: 1 }, sent, server("Typed", 2)))
      .toMatchObject({ dirty: false, baseRevision: 2, baseHash: hashOf("Typed") });
    expect(savedCopy({ ...local, dirty: true, baseRevision: 1 }, sent, server("Typed", 2))).toMatchObject({ text: "Typed here", dirty: true, baseRevision: 2 });
    const newer = { ...local, baseRevision: 5 };
    expect(savedCopy(newer, sent, server("Typed", 2))).toBe(newer);
  });

  it("ignores an acknowledgment of a save that went out before this copy's send was accepted", () => {
    const next = { ...local, text: "Next message", dirty: true, baseRevision: 1, sentHere: true };
    expect(savedCopy(next, { text: "Sent message", attachments: [] }, server("Sent message", 2))).toBe(next);
    // The server holding exactly this copy is still worth recording.
    expect(savedCopy({ ...next, text: "Sent message" }, { text: "Sent message", attachments: [] }, server("Sent message", 2))).toMatchObject({ dirty: false, baseRevision: 2 });
  });

  it("empties a sent copy but keeps its base, and marks later typing as sent from here", () => {
    const sent = { text: "Typed here", attachments: [] };
    expect(sentCopy({ ...local, baseRevision: 3, baseHash: "h" }, sent)).toEqual({ text: "", attachments: [], botId: "ranch", userId: "one", baseRevision: 3, baseHash: "h", sentHere: true });
    expect(sentCopy({ ...local, text: "More", dirty: true, baseRevision: 3 }, sent)).toMatchObject({ text: "More", dirty: true, sentHere: true });
  });

  it("reads a missing draft or a server without revisions as revision 0", () => {
    expect(savedDraft(null)).toEqual({ text: "", attachments: [], revision: 0, reason: "edit", sentRevision: 0 });
    expect(savedDraft({ text: "Old server", attachments: [] })).toMatchObject({ text: "Old server", revision: 0 });
  });
});
