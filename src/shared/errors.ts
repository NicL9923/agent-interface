import type { RuntimeStatus } from "./types.js";

/** Every `code` an error response carries. Clients, including the iOS app, match these exact strings. */
export type ErrorCode =
  | "assistant_not_found"
  | "assistants_changed"
  | "created_incomplete"
  | "draft_conflict"
  | "file_too_large"
  | "hermes_maintenance"
  | "hermes_unauthorized"
  | "interruption_pending"
  | "MODEL_CONFIRMATION_REQUIRED"
  | "private_confirmation_required"
  | "private_recipients"
  | "reauthentication_required"
  | "session_expired"
  | "sharing_changed"
  // A Hermes transport failure carries its connection diagnosis.
  | NonNullable<RuntimeStatus["code"]>
  // The web client sets these for failures that never reached the server.
  | "CONNECTION_UNAVAILABLE"
  | "INVALID_RESPONSE";

/** Sent when a conversation's interrupted task needs review before another message starts. */
export const interruptionPendingMessage = "Review the interrupted task before starting another message.";

/**
 * A runtime created an assistant, then could neither finish setting it up nor remove it.
 * It still exists as `createdBotId`, so the app keeps a record of who may see it.
 */
export class IncompleteCreationError extends Error {
  constructor(message: string, readonly createdBotId: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IncompleteCreationError";
  }
}
