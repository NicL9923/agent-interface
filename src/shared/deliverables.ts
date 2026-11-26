import type { InlineDocument } from "./inline-ui.js";
import type { ReplyCard } from "./reply-cards.js";
import type { FileRef } from "./types.js";

export const DELIVERABLE_KINDS = ["view", "card", "file"] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

export interface DeliverableItem {
  id: string;
  kind: DeliverableKind;
  botId: string;
  botName: string;
  messageId: string;
  createdAt: string | null;
  title: string;
  subtitle?: string;
  inlineDoc?: InlineDocument;
  card?: ReplyCard;
  file?: FileRef;
}

export interface DeliverablesResponse {
  items: DeliverableItem[];
}
