import type { SavedDraft } from "../shared/types";
import { draftContent, isSentCopy, sameDraft } from "./storage";
import type { Draft } from "./storage";

/** Reads a draft response. Someone who never saved a draft, or an older server, is at revision 0. */
export function savedDraft(value: unknown): SavedDraft {
  const draft = (value ?? {}) as Partial<SavedDraft>;
  return {
    text: draft.text ?? "",
    attachments: draft.attachments ?? [],
    revision: draft.revision ?? 0,
    reason: draft.reason === "sent" ? "sent" : "edit",
    sentRevision: draft.sentRevision ?? 0,
  };
}

/** A fingerprint of a draft's content (cyrb53), kept with a cached copy to tell whether it changed since its base. */
export function contentHash(draft: Pick<Draft, "text" | "attachments">): string {
  const value = draftContent(draft);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Reconciles this device's copy with a server draft: a load, a save's acknowledgment, or the
 * current draft from a 409. Every response goes through here and is applied to the copy as it is
 * now, never as it was when the request went out.
 *
 * - A server read older than the copy is ignored, unless `authoritative`: the 409 answering the
 *   copy's latest save, with no other save in flight, as after a database restore.
 * - A clean copy adopts the server draft. While this device's sent text is still on the server,
 *   not yet cleared, the copy keeps waiting for that clear.
 * - A send cleared the server draft after this copy's base, and the copy still holds its base
 *   content or the text this device sent: that text was sent, so adopt the server draft.
 * - Matching content is clean, but only once no other save is in flight (`settled`): an older
 *   save may still land and change the server copy.
 * - Otherwise unsaved edits here are new work and win. `push` asks the caller to save them on
 *   the new base.
 */
export function mergeDraft(local: Draft, server: SavedDraft, { authoritative = false, settled = true } = {}): { draft: Draft; push: boolean } {
  const base = local.baseRevision ?? 0;
  if (!authoritative && server.revision < base) return { draft: local, push: false };
  const hash = contentHash(server);
  // The server's copy is never this device's sent copy, so the send's sequence comes along to say so.
  const adopt = {
    draft: { text: server.text, attachments: server.attachments, botId: local.botId, userId: local.userId, baseRevision: server.revision, baseHash: hash, dirty: false, sentSeq: local.sentSeq },
    push: false,
  };
  // The guard for this device's send lasts until the server shows that send completed.
  const sendShown = local.sentHash !== undefined && server.sentRevision > (local.sentBase ?? 0);
  if (!local.dirty) {
    if (local.sentHash === hash && !sendShown) return { draft: local, push: false };
    // Nothing changed: the same object lets a refresh skip rendering.
    if (local.baseRevision === server.revision && local.baseHash === hash && !local.sentHash && sameDraft(local, server))
      return { draft: local, push: false };
    return adopt;
  }
  const mine = contentHash(local);
  // Typed since this device's send, the copy is new work whatever words it shares with the send.
  const untouched = local.sentHash === undefined || isSentCopy(local);
  if (untouched && server.sentRevision > base && (mine === local.baseHash || sendShown && mine === local.sentHash)) return adopt;
  const current = sendShown ? { ...local, sentHash: undefined, sentBase: undefined } : local;
  if (sameDraft(local, server)) {
    // Saved as it is: the copy stays this device's sent copy until the server shows the send.
    if (settled) return sendShown || local.sentHash === undefined ? adopt
      : { draft: { ...adopt.draft, seq: local.seq, sentHash: local.sentHash, sentBase: local.sentBase }, push: false };
    return { draft: server.revision === base ? current : { ...current, baseRevision: server.revision, baseHash: hash }, push: false };
  }
  if (server.revision === base) return { draft: current, push: false };
  return { draft: { ...current, baseRevision: server.revision, baseHash: hash }, push: true };
}

/** A sequence for a local edit, increasing across reloads, so responses can tell the newest edit. */
let lastSeq = 0;
export function nextSeq() {
  lastSeq = Math.max(Date.now(), lastSeq + 1);
  return lastSeq;
}
