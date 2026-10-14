import type { SavedDraft } from "../shared/types";
import { sameDraft } from "./storage";
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
  const value = JSON.stringify([draft.text, draft.attachments]);
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
 * Reconciles this device's copy with the server's after a load, or after a save the server
 * refused because the copy's base revision was stale. `conflict` marks the server's current
 * copy from a 409; a load may be an older read than this copy, and is then ignored.
 *
 * - A clean copy adopts the server draft.
 * - A send cleared the server draft after this copy's base, and this copy still holds the
 *   content of its base: that content was sent, so adopt the server draft.
 * - Otherwise unsaved edits here are new work and win. `push` asks the caller to save them on
 *   the new base.
 */
export function mergeDraft(local: Draft, server: SavedDraft, conflict = false): { draft: Draft; push: boolean } {
  const base = local.baseRevision ?? 0;
  if (!conflict && server.revision < base) return { draft: local, push: false };
  const hash = contentHash(server);
  // Nothing changed: the same object lets a refresh skip rendering.
  if (!local.dirty && !local.sentHere && local.baseRevision === server.revision && local.baseHash === hash && sameDraft(local, server))
    return { draft: local, push: false };
  if (!local.dirty || sameDraft(local, server) || server.sentRevision > base && local.baseHash === contentHash(local))
    return {
      draft: { text: server.text, attachments: server.attachments, botId: local.botId, userId: local.userId, baseRevision: server.revision, baseHash: hash, dirty: false },
      push: false,
    };
  if (server.revision === base) return { draft: local, push: false };
  return { draft: { ...local, baseRevision: server.revision, baseHash: hash, sentHere: undefined }, push: true };
}

/**
 * This device's copy after the server saved `sent` as `server`. Edits typed since stay unsaved.
 * An acknowledgment older than the copy is ignored: one from before a later save, or from a save
 * that went out before this copy's own send was accepted.
 */
export function savedCopy(local: Draft, sent: Pick<Draft, "text" | "attachments">, server: SavedDraft): Draft {
  if (server.revision < (local.baseRevision ?? 0) || local.sentHere && !sameDraft(local, server)) return local;
  return { ...local, baseRevision: server.revision, baseHash: contentHash(server), sentHere: undefined, dirty: sameDraft(local, sent) ? false : local.dirty };
}
