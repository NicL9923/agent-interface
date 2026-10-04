import type { Conversation, FileRef } from "../shared/types";
export type SavedConversation = Conversation & {
  draft?: { text: string; attachments: FileRef[] };
  readPosition?: { scrollTop?: number; messageId?: string };
};
export type Draft = {
  text: string;
  attachments: FileRef[];
  botId?: string;
  userId?: string;
  dirty?: boolean;
};
export type Pending = {
  requestId: string;
  botId: string;
  text: string;
  attachments: FileRef[];
  reviewedInterruption: boolean;
};
export const draftKey = (user: string, bot: string) =>
  `agent-interface:draft:${user}:${bot}`;
export const submissionKey = (user: string, bot: string) =>
  `agent-interface:submission:${user}:${bot}`;
export const scrollKey = (user: string, bot: string) =>
  `agent-interface:scroll:${user}:${bot}`;
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
export function clearSavedDraft(user: string, submission: Pending) {
  const key = draftKey(user, submission.botId);
  const saved = localRead<Draft>(key);
  if (saved && sameDraft(saved, submission)) {
    const cleared = {
      text: "",
      attachments: [],
      botId: submission.botId,
      userId: user,
    };
    localSave(key, cleared);
    return cleared;
  }
  return null;
}
