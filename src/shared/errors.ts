import type { RuntimeStatus } from "./types.js";

/** Every `code` an error response carries. Clients, including the iOS app, match these exact strings. */
export type ErrorCode =
  | "assistant_not_found"
  | "assistants_changed"
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
  // --- End main assistant ---
  // A Hermes transport failure carries its connection diagnosis.
  | NonNullable<RuntimeStatus["code"]>
  // The web client sets these for failures that never reached the server.
  | "CONNECTION_UNAVAILABLE"
  | "INVALID_RESPONSE";

/** Sent when a request ID already names a different message. */
export const submissionConflictMessage = "This submission ID was already used for different content";
/** Sent when a send reaches the app, or Hermes, while Hermes is being upgraded. The message was not sent and its draft is kept. */
export const hermesMaintenanceSendMessage = "Hermes is being upgraded. Your draft is saved; send it after the update finishes.";
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
