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
  createdAt?: string;
}
/** A bot's queued messages, in the order they will run. */
export interface BotQueue {
  items: QueuedMessage[];
}
