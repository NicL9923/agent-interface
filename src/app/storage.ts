import type { Conversation, FileRef } from "../shared/types";
export type SavedConversation = Conversation & {
  draft?: { text: string; attachments: FileRef[] };
  readPosition?: { scrollTop?: number; messageId?: string };
  /** Messages before the requested window, present only when one was requested. */
  earlier?: number;
};
export type Draft = {
  text: string;
  attachments: FileRef[];
  botId?: string;
  userId?: string;
  /** Unsaved edits, or a cleared copy whose clear the server has not confirmed. */
  dirty?: boolean;
  /** The server revision this copy was loaded from or last saved as. Missing means 0. */
  baseRevision?: number;
  /** Fingerprint of the content at `baseRevision`, to tell whether this copy changed since. */
  baseHash?: string;
  /** This device's send from this copy was accepted since its base, so older save acknowledgments are stale. */
  sentHere?: boolean;
};
// A file still on its way to Hermes. It joins the draft's attachments once uploaded.
export type LocalUpload = {
  id: string;
  botId: string;
  userId: string;
  file: File;
  preview?: string;
  progress: number;
  status: "queued" | "uploading" | "processing" | "failed";
  error?: string;
};
export type Pending = {
  requestId: string;
  botId: string;
  text: string;
  attachments: FileRef[];
  reviewedInterruption: boolean;
  /** The draft revision this message was written on, so the server clears a draft whose final edits were never saved. */
  draftBaseRevision?: number;
};
export const draftKey = (user: string, bot: string) =>
  `agent-interface:draft:${user}:${bot}`;
export const submissionKey = (user: string, bot: string) =>
  `agent-interface:submission:${user}:${bot}`;
export function localRead<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}
export function localRemove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {}
}
export function localSave(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Server persistence still applies when browser storage is full. */
  }
}
export const sameDraft = (a: Pick<Draft, "text" | "attachments">, b: Pick<Draft, "text" | "attachments">) =>
  a.text === b.text && JSON.stringify(a.attachments) === JSON.stringify(b.attachments);
/** This device's copy once its send was accepted: emptied if it still holds the sent text. */
export function sentCopy(draft: Draft, submission: Pick<Pending, "text" | "attachments">): Draft {
  return sameDraft(draft, submission)
    ? { text: "", attachments: [], botId: draft.botId, userId: draft.userId, baseRevision: draft.baseRevision, baseHash: draft.baseHash, sentHere: true }
    : { ...draft, sentHere: true };
}
export function clearSavedDraft(user: string, submission: Pending) {
  const key = draftKey(user, submission.botId);
  const saved = localRead<Draft>(key);
  if (saved) localSave(key, sentCopy(saved, submission));
}
