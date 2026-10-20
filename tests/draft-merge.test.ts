import { describe, expect, it } from "vitest";
import { contentHash, mergeDraft, savedDraft } from "../src/app/draft-merge";
import { isSentCopy, sameDraft, sentCopy } from "../src/app/storage";
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
    expect(mergeDraft(offline, server("", 3, 3), { authoritative: true })).toEqual({
      draft: { ...offline, baseRevision: 3, baseHash: hashOf(""), sentHere: undefined }, push: true,
    });
    // A copy from before fingerprints cannot be shown unchanged, so it is kept.
    expect(mergeDraft({ ...local, dirty: true }, server("", 1, 1), { authoritative: true }).draft.text).toBe("Typed here");
  });

  it("keeps edits typed here over another device's newer edit and saves them on its revision", () => {
    expect(mergeDraft({ ...local, dirty: true, baseRevision: 2 }, server("Phone edit", 5, 1), { authoritative: true })).toMatchObject({
      draft: { text: "Typed here", dirty: true, baseRevision: 5, baseHash: hashOf("Phone edit") }, push: true,
    });
  });

  it("leaves unsaved edits alone while the server is still on their base", () => {
    const copy = { ...local, dirty: true, baseRevision: 2 };
    expect(mergeDraft(copy, server("Older text", 2))).toEqual({ draft: copy, push: false });
  });

  it("marks matching text saved instead of saving it again", () => {
    expect(mergeDraft({ ...local, dirty: true, baseRevision: 1 }, server("Typed here", 4), { authoritative: true }))
      .toMatchObject({ draft: { dirty: false, baseRevision: 4 }, push: false });
  });

  it("ignores a load older than this copy, but not the server's answer to a conflict", () => {
    const copy = { ...local, baseRevision: 7 };
    expect(mergeDraft(copy, server("Older read", 6))).toEqual({ draft: copy, push: false });
    // After a database restore the server's revision is lower; edits still save on it.
    expect(mergeDraft({ ...copy, dirty: true }, server("Restored", 2), { authoritative: true })).toMatchObject({ draft: { text: "Typed here", baseRevision: 2 }, push: true });
  });

  it("records a save without losing edits typed while it was in flight", () => {
    expect(mergeDraft({ ...local, text: "Typed", dirty: true, baseRevision: 1 }, server("Typed", 2)))
      .toMatchObject({ draft: { dirty: false, baseRevision: 2, baseHash: hashOf("Typed") } });
    expect(mergeDraft({ ...local, dirty: true, baseRevision: 1 }, server("Typed", 2))).toMatchObject({ draft: { text: "Typed here", dirty: true, baseRevision: 2 } });
  });

  it("keeps a copy unsaved while an older save may still land, even when the server matches it", () => {
    const reverted = { ...local, text: "A", dirty: true, baseRevision: 1, baseHash: hashOf("A") };
    expect(mergeDraft(reverted, server("A", 1), { settled: false }).draft).toBe(reverted);
    expect(mergeDraft(reverted, server("A", 1)).draft).toMatchObject({ dirty: false });
  });

  it("ignores an older 409 once a newer save landed", () => {
    const saved = { ...local, text: "Newer", baseRevision: 3, baseHash: hashOf("Newer") };
    expect(mergeDraft(saved, server("Older", 2)).draft).toBe(saved);
  });

  it("adopts a later draft with the same text as the last send once the server shows that send", () => {
    // This device sent "Continue" on revision 5 and missed the empty revision 6.
    const cleared = { ...local, text: "", baseRevision: 5, sentHash: hashOf("Continue"), sentBase: 5 };
    expect(mergeDraft(cleared, server("Continue", 7, 6)).draft).toMatchObject({ text: "Continue", baseRevision: 7, dirty: false });
    expect(mergeDraft(cleared, server("Continue", 7, 6)).draft.sentHash).toBeUndefined();
    // Typing on: the guard ends with the send, so later typing of the same text is kept.
    const typing = { ...local, text: "Continue", dirty: true, baseRevision: 5, baseHash: hashOf("Earlier"), sentHash: hashOf("Continue"), sentBase: 8 };
    expect(mergeDraft(typing, server("", 9, 9)).draft.text).toBe("");
    expect(mergeDraft({ ...typing, sentBase: 9 }, server("Other", 10, 9)).draft).toMatchObject({ text: "Continue", baseRevision: 10 });
  });

  it("drops a copy holding the text this device sent once the server shows the send", () => {
    const sending = { ...local, dirty: true, baseRevision: 0, baseHash: hashOf(""), sentHash: hashOf("Typed here") };
    expect(mergeDraft(sending, server("", 1, 1))).toMatchObject({ draft: { text: "", dirty: false, baseRevision: 1 }, push: false });
    expect(mergeDraft(sending, server("", 1, 1)).draft.sentHash).toBeUndefined();
    // A clean copy keeps waiting while a save from before the send still shows the sent text.
    const cleared = { ...local, text: "", baseRevision: 0, sentHash: hashOf("Typed here") };
    expect(mergeDraft(cleared, server("Typed here", 1)).draft).toBe(cleared);
    expect(mergeDraft(cleared, server("", 2, 2)).draft).toMatchObject({ text: "", baseRevision: 2 });
  });

  it("empties a sent copy but keeps its base, and leaves later typing alone", () => {
    const sent = { text: "Typed here", attachments: [] };
    expect(sentCopy({ ...local, baseRevision: 3, baseHash: "h", sentHash: "s" }, sent)).toEqual({ text: "", attachments: [], botId: "ranch", userId: "one", baseRevision: 3, baseHash: "h", sentHash: "s" });
    const more = { ...local, text: "More", dirty: true, baseRevision: 3 };
    expect(sentCopy(more, sent)).toBe(more);
  });

  it("tells the sent copy from the same words typed again by edit sequence", () => {
    const sent = { text: "Typed here", attachments: [] };
    const marked = { ...local, dirty: true, seq: 5, baseRevision: 3, baseHash: contentHash({ text: "Older", attachments: [] }),
      sentHash: contentHash(sent), sentBase: 3, sentSeq: 5 };
    expect(isSentCopy(marked)).toBe(true);
    const cleared = sentCopy(marked, sent);
    expect(cleared).toMatchObject({ text: "", seq: 5, sentSeq: 5, sentHash: marked.sentHash });
    // Typed again in the same words after acceptance: kept, and pushed over the server's clear.
    const retyped = { ...cleared, text: "Typed here", dirty: true, seq: 6 };
    expect(isSentCopy(retyped)).toBe(false);
    expect(sentCopy(retyped, sent)).toBe(retyped);
    expect(mergeDraft(retyped, server("", 4, 4))).toMatchObject({ draft: { text: "Typed here", baseRevision: 4 }, push: true });
    // Typed back to the copy's base words: new work too.
    expect(mergeDraft({ ...retyped, text: "Older" }, server("", 4, 4))).toMatchObject({ draft: { text: "Older" }, push: true });
    // Untouched, the sent copy still gives way to the server's clear.
    expect(mergeDraft(marked, server("", 4, 4)).draft).toMatchObject({ text: "", baseRevision: 4 });
  });

  it("frees a copy the server cleared before the receipt, so the same words typed next are kept", () => {
    const sent = { text: "Typed here", attachments: [] };
    const marked = { ...local, seq: 5, baseRevision: 3, sentHash: contentHash(sent), sentBase: 3, sentSeq: 5 };
    const adopted = mergeDraft(marked, server("", 4, 4)).draft;
    expect(adopted).toMatchObject({ text: "", sentSeq: 5 });
    expect(isSentCopy(adopted)).toBe(false);
    const typed = { ...adopted, text: "Typed here", dirty: true, seq: 7 };
    expect(sentCopy(typed, sent)).toBe(typed);
  });

  it("keeps a saved sent copy as the sent copy until the server shows the send", () => {
    const sent = { text: "Typed here", attachments: [] };
    const marked = { ...local, dirty: true, seq: 5, baseRevision: 3, sentHash: contentHash(sent), sentBase: 3, sentSeq: 5 };
    const saved = mergeDraft(marked, server("Typed here", 4)).draft;
    expect(saved).toMatchObject({ dirty: false, baseRevision: 4 });
    expect(isSentCopy(saved)).toBe(true);
    expect(sentCopy(saved, sent).text).toBe("");
  });

  it("keeps the content-only check for a copy marked by an older version", () => {
    const sent = { text: "Typed here", attachments: [] };
    expect(sentCopy({ ...local, dirty: true }, sent).text).toBe("");
    expect(sentCopy({ ...local, sentHash: contentHash(sent), sentBase: 3 }, sent).text).toBe("");
  });

  it("fingerprints and compares attachments regardless of their field order", () => {
    const uploaded = { id: "map.sig", name: "map.png", mime: "image/png", url: "/api/files/map.sig", size: 6 };
    const validated = { id: "map.sig", name: "map.png", mime: "image/png", size: 6, url: "/api/files/map.sig" };
    expect(contentHash({ text: "Map", attachments: [uploaded] })).toBe(contentHash({ text: "Map", attachments: [validated] }));
    expect(sameDraft({ text: "Map", attachments: [uploaded] }, { text: "Map", attachments: [validated] })).toBe(true);
    expect(contentHash({ text: "Map", attachments: [uploaded] })).not.toBe(contentHash({ text: "Map", attachments: [{ ...uploaded, size: 7 }] }));
  });

  it("reads a missing draft or a server without revisions as revision 0", () => {
    expect(savedDraft(null)).toEqual({ text: "", attachments: [], revision: 0, reason: "edit", sentRevision: 0 });
    expect(savedDraft({ text: "Old server", attachments: [] })).toMatchObject({ text: "Old server", revision: 0 });
  });
});
