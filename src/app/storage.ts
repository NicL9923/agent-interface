import type { FileRef } from "../shared/types";
import type { ConversationPage } from "../shared/api";
/** A conversation page as the server answers it, with this person's draft and read position. */
export type SavedConversation = ConversationPage;
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
  /** Increases with every local edit; a save records the one it carries. */
  seq?: number;
  /** Fingerprint of the text this device sent from this copy, until the server shows the send. */
  sentHash?: string;
  /** The revision that send was written on; a `sentRevision` past it shows the send completed. */
  sentBase?: number;
  /**
   * The edit sequence of the copy this device last sent. A copy whose `seq` still matches, while
   * `sentHash` marks the send as open, is that copy. Anything typed since, or the server's copy
   * adopted since, is new work even in the same words. Kept after the send completes.
   */
  sentSeq?: number;
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
// Every key this app keeps in browser storage. The names are persisted: renaming one orphans what a
// browser already saved, such as a request whose outcome is uncertain and must be retried, not resent.
export const draftKey = (user: string, bot: string) =>
  `agent-interface:draft:${user}:${bot}`;
export const submissionKey = (user: string, bot: string) =>
  `agent-interface:submission:${user}:${bot}`;
export const goalResumeKey = (user: string, bot: string) => `automation-goal-resume:${user}:${bot}`;
/** In sessionStorage: a sign-in flow belongs to this tab. */
export const integrationFlowKey = (user: string, profile: string) => `integration-flow:${user ? `${user}:` : ""}${profile}`;
export const groupCreateKey = (user: string) => `agent-interface:group-create:${user}`;
export const groupSendKey = (user: string, room: string) => `agent-interface:group-send:${user}:${room}`;
export const routineTrialKey = (user: string, routine: string) => `agent-interface:routine-trial:${user}:${routine}`;
/** In sessionStorage: retain an unclear approval decision across navigation and reloads. */
export const approvalDecisionKey = (user: string, bot: string, approval: string) => `agent-interface:approval:${user}:${bot}:${approval}`;
/** A form card's answers on their way to the assistant, or sent, so a reload neither loses nor resends them. */
export const formReplyKey = (user: string, bot: string, message: string, card: string) => `agent-interface:form-reply:${user}:${bot}:${message}:${card}`;
/** When this browser's sign-in lapses and which chats it could open. See account-epoch.ts. */
export const signInHintKey = "agent-interface:sign-in-hint";
/** The theme this device last showed the account the sign-in hint names, for public/boot.js. */
export const savedThemeKey = "agent-interface:theme";
/**
 * Copies that belong to the account the sign-in hint names. They go with the hint, at sign-out, at a
 * refused session and at a new sign-in, and are shown only while the hint names their account.
 */
export const accountKeys = [savedThemeKey];
/** Which account every tab of this browser acts for, and whether a sign-in or sign-out is under way. See account-epoch.ts. */
export const authEpochKey = "agent-interface:auth-epoch";
export const notificationPromptKey = (user: string) => `agent-interface:notifications-prompt:v2:${user}`;
/**
 * The localStorage records that hold what a member wrote or chose to send: drafts, a message whose
 * outcome is uncertain, a group chat's draft and send, a group being made, and a form's answers.
 * Sign-out removes them. Records that hold only request IDs, choices or a prompt flag stay, so an
 * uncertain request can still be checked instead of repeated after the member signs in again.
 */
const contentPrefixes = (user: string) => [
  `agent-interface:draft:${user}:`, `agent-interface:submission:${user}:`, `agent-interface:group-send:${user}:`,
  `agent-interface:form-reply:${user}:`,
];
/** Removes the records of `user` that hold their content. Every name includes the account, so no other member's go. */
export function forgetAccountContent(user: string) {
  const prefixes = contentPrefixes(user), exact = groupCreateKey(user);
  try {
    const names = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
    for (const name of names)
      if (name !== null && (name === exact || prefixes.some(prefix => name.startsWith(prefix)))) localStorage.removeItem(name);
  } catch { /* Storage that cannot be listed holds nothing this app could read either. */ }
}
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
/** Draft content in a fixed field order: uploads and the server's validation order file fields differently. */
export const draftContent = (draft: Pick<Draft, "text" | "attachments">) =>
  JSON.stringify([draft.text, draft.attachments.map(file => [file.id, file.name, file.mime, file.size ?? null, file.url ?? null])]);
export const sameDraft = (a: Pick<Draft, "text" | "attachments">, b: Pick<Draft, "text" | "attachments">) =>
  draftContent(a) === draftContent(b);
/**
 * Whether this copy may be the one this device sent, untouched since. Drafts are compared by
 * content on the server, so only the edit sequence can tell the sent copy from the same words
 * typed again. A copy from an older version has no sequence and keeps the content-only check.
 */
export const isSentCopy = (draft: Draft) =>
  draft.sentSeq === undefined || draft.sentHash !== undefined && (draft.seq ?? 0) === draft.sentSeq;
/** This device's copy once its send was accepted: emptied if it is still the sent copy. */
export function sentCopy(draft: Draft, submission: Pick<Pending, "text" | "attachments">): Draft {
  return isSentCopy(draft) && sameDraft(draft, submission)
    ? { text: "", attachments: [], botId: draft.botId, userId: draft.userId, baseRevision: draft.baseRevision, baseHash: draft.baseHash, sentHash: draft.sentHash, sentBase: draft.sentBase, sentSeq: draft.sentSeq, seq: draft.seq }
    : draft;
}
export function clearSavedDraft(user: string, submission: Pending) {
  const key = draftKey(user, submission.botId);
  const saved = localRead<Draft>(key);
  if (saved) localSave(key, sentCopy(saved, submission));
}
