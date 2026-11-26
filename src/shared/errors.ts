import type { RuntimeStatus } from "./types.js";

/** Every `code` an error response carries. Clients, including the iOS app, match these exact strings. */
export type ErrorCode =
  | "assistant_not_found"
  // A new assistant's name has no letter or number, so it makes no ID.
  | "assistant_name_invalid"
  // A file ID whose signature or contents this server did not issue, or no longer accepts.
  | "file_not_found"
  // An approval or question already answered, by someone else or elsewhere, or one that expired.
  | "request_not_pending"
  | "assistants_changed"
  // An assistant whose runtime did not answer, which a read would otherwise report gone.
  | "assistants_unavailable"
  | "created_incomplete"
  | "draft_conflict"
  | "file_too_large"
  // Linking a Mac: see docs/MacLink.md.
  | "confirmation_required"
  | "link_unavailable"
  | "mac_limit"
  | "mac_not_found"
  | "native_required"
  | "hermes_maintenance"
  | "hermes_unauthorized"
  | "interruption_pending"
  | "nothing_to_stop"
  | "run_changed"
  | "MODEL_CONFIRMATION_REQUIRED"
  | "private_confirmation_required"
  | "private_recipients"
  | "reauthentication_required"
  | "routine_ambiguous"
  | "routine_rooms"
  | "routine_rooms_unknown"
  | "session_expired"
  | "sharing_changed"
  // A request ID came back with different content: another tab or device already sent under it.
  | "submission_conflict"
  | "conversation_changed"
  | "queue_item_not_found"
  | "queue_item_not_queued"
  | "queue_item_not_running"
  // Approval scopes (Workstream B): a choice Hermes did not offer, settings an older add-on lacks, and policy guards.
  | "approval_choice_unavailable"
  | "approval_settings_unsupported"
  | "approval_policy_forbidden"
  | "approvals_off"
  // --- Main assistant and check-ins ---
  | "main_not_personal"
  | "main_required"
  | "main_share_confirmation_required"
  | "check_in_hours"
  | "check_in_managed"
  | "check_in_marker"
  | "check_in_unavailable"
  | "check_in_removal_pending"
  | "roster_update_failed"
  | "routine_chats"
  | "main_routine_delivery"
  | "main_routine_busy"
  | "main_activation_failed"
  | "main_clear_pending"
  | "morning_brief_time"
  | "already_decided"
  | "human_signoff_required"
  // --- End main assistant ---
  // A Hermes transport failure carries its connection diagnosis.
  | NonNullable<RuntimeStatus["code"]>
  // The web client sets these for failures that never reached the server.
  | "CONNECTION_UNAVAILABLE"
  | "INVALID_RESPONSE";

/** Sent when a request ID already names a different message. */
export const submissionConflictMessage =
  "This submission ID was already used for different content";
/** Sent when a Stop finds nothing running, so the interrupt, which also clears queued messages and denies approvals, is not sent. */
export const nothingToStopMessage = "Nothing is running right now, so nothing was stopped.";
/** Sent when a Stop names a run that is no longer the one running. */
export const runChangedMessage =
  "A different reply is running now, so nothing was stopped. Look at it, then stop it if you still want to.";
/** Sent when a send reaches the app, or Hermes, while Hermes is being upgraded. The message was not sent and its draft is kept. */
export const hermesMaintenanceSendMessage =
  "Hermes is being upgraded. Your draft is saved; send it after the update finishes.";
/**
 * A refusal as Talk speaks it. A spoken request has no typed draft, so the sentences that tell the person their draft is
 * saved are dropped: they would send someone to a draft that does not exist.
 */
export function withoutDraftClause(message: string): string {
  return message
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !/\bdraft\b/i.test(sentence))
    .join(" ");
}
/** Sent when a conversation's interrupted task needs review before another message starts. */
export const interruptionPendingMessage =
  "Review the interrupted task before starting another message.";

/**
 * A runtime created an assistant, then could neither finish setting it up nor remove it.
 * It still exists as `createdBotId`, so the app keeps a record of who may see it.
 */
export class IncompleteCreationError extends Error {
  constructor(
    message: string,
    readonly createdBotId: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IncompleteCreationError";
  }
}

/** Sent for a missing assistant, the same whether it never existed, was deleted, or is hidden from the caller. */
export const assistantNotFoundMessage = "Assistant not found";
/** Sent when a new assistant's name would make an empty ID, such as one of only emoji or punctuation. */
export const assistantNameMessage = "Use at least one letter or number in the name.";
/** Sent for an approval someone already answered, here or elsewhere, or that expired. */
export const approvalNotPendingMessage = "This approval is no longer pending";
/** Sent when a file ID is no longer valid, such as after the Hermes token changed. */
export const fileNotFoundMessage = "That file is no longer available.";

/** The statuses a refusal answers with: the request is malformed, names something that is gone, or conflicts with a change. */
export type RefusalStatus = 400 | 404 | 409;
/**
 * A runtime turning a request down for a reason the person can act on. The app answers with its status, message and
 * code, and does not log it as a failure. Every runtime adapter throws one of these for a refusal; an error without a
 * status is an upstream failure, which the app answers with a 5xx and a generic message. `statusCode` is the name
 * the app's error handler and its other error checks read.
 */
export class RuntimeRefusal extends Error {
  constructor(
    readonly statusCode: RefusalStatus,
    message: string,
    readonly code?: ErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeRefusal";
  }
}
/** A request the runtime cannot take as sent: fix it and send it again. */
export class InvalidInput extends RuntimeRefusal {
  constructor(message: string, code?: ErrorCode, options?: ErrorOptions) {
    super(400, message, code, options);
  }
}
/** The request names something that does not exist, or no longer does. */
export class NotFound extends RuntimeRefusal {
  constructor(message: string, code?: ErrorCode, options?: ErrorOptions) {
    super(404, message, code, options);
  }
}
/** The request was valid when it was made, but the state it acted on has changed: reload before trying again. */
export class Conflict extends RuntimeRefusal {
  constructor(message: string, code?: ErrorCode, options?: ErrorOptions) {
    super(409, message, code, options);
  }
}
