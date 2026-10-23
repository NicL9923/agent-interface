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
