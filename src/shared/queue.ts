import { z } from "zod";
import { MAX_MESSAGE_TEXT } from "./api.js";
import type { FileRef } from "./types.js";

/**
 * One message waiting for the next turn. Once the runtime claims it for a turn it leaves the queue,
 * and an edit, move, send now or cancel aimed at it is refused with 409.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments?: FileRef[];
  /** Who sent it. */
  senderId?: string;
  createdAt?: string | number;
}
/** A bot's queued messages, in the order they will run. */
export interface BotQueue {
  items: QueuedMessage[];
}

export type QueueItemStatus = "queued" | "running" | "completed" | "interrupted" | "cancelled";
export type QueueItemPriority = "normal" | "send_now";

export interface QueueItem {
  id: string;
  botId: string;
  requestId: string;
  senderId: string;
  senderName: string;
  text: string;
  files: FileRef[];
  position: number;
  status: QueueItemStatus;
  priority: QueueItemPriority;
  /** The conversation version at admission. */
  conversationVersion: number;
  createdAt: number;
  updatedAt: number;
  claimedAt?: number;
  settledAt?: number;
  error?: string;
}

export interface WireQueueItem extends Omit<QueueItem, "createdAt"> {
  attachments: FileRef[];
  createdAt: string;
}

export const queueListQuery = z.strictObject({
  includeSettled: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});
export type QueueListRequest = z.output<typeof queueListQuery>;
export interface QueueListResponse {
  items: WireQueueItem[];
  conversationVersion: number;
}

export const queueEditBody = z.strictObject({ text: z.string().max(MAX_MESSAGE_TEXT) });
export type QueueEditRequest = z.input<typeof queueEditBody>;

export const queueReorderBody = z.union([
  z.strictObject({ beforeItemId: z.string().min(1).nullable() }),
  z.strictObject({ toEnd: z.literal(true) }),
]);
export type QueueReorderRequest = z.input<typeof queueReorderBody>;
export type QueueMutationResponse = WireQueueItem & QueueListResponse;
export type QueueEditResponse = QueueMutationResponse;
export type QueueReorderResponse = QueueMutationResponse;
export type QueueSendNowResponse = QueueMutationResponse;
export type QueueCancelResponse = QueueMutationResponse;
