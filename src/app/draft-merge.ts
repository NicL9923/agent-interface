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

/**
 * Reconciles this device's copy with the server's after a load, or after a save the server
 * refused because the copy's base revision was stale. `conflict` marks the server's current
 * copy from a 409; a load may be an older read than this copy, and is then ignored.
 *
 * - A clean copy adopts the server draft.
 * - A send cleared the server draft after this copy's base: the text was sent, so drop it.
 *   A copy this device sent from keeps its edits, because that clear may be its own.
 * - Otherwise unsaved edits here win. `push` asks the caller to save them on the new base.
 */
export function mergeDraft(local: Draft, server: SavedDraft, conflict = false): { draft: Draft; push: boolean } {
  const base = local.baseRevision ?? 0;
  if (!conflict && server.revision < base) return { draft: local, push: false };
  if (!local.dirty || sameDraft(local, server) || server.sentRevision > base && !local.sentHere)
    return {
      draft: { text: server.text, attachments: server.attachments, botId: local.botId, userId: local.userId, baseRevision: server.revision, dirty: false },
      push: false,
    };
  if (server.revision === base) return { draft: local, push: false };
  return { draft: { ...local, baseRevision: server.revision, sentHere: undefined }, push: true };
}

/** This device's copy after the server saved `sent` as `server`. Edits typed since stay unsaved. */
export function savedCopy(local: Draft, sent: Pick<Draft, "text" | "attachments">, server: SavedDraft): Draft {
  // A newer copy already came back, for example from a later save.
  if (server.revision < (local.baseRevision ?? 0)) return local;
  return { ...local, baseRevision: server.revision, sentHere: undefined, dirty: sameDraft(local, sent) ? false : local.dirty };
}
