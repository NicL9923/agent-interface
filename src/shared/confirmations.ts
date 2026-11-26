export const CONFIRMATION_KINDS = [
  "send_email",
  "delete_data",
  "publish",
  "payment",
  "external_write",
] as const;
export type ConfirmationKind = (typeof CONFIRMATION_KINDS)[number];

export const CONFIRMATION_STATUSES = ["pending", "approved", "declined", "expired"] as const;
export type ConfirmationStatus = (typeof CONFIRMATION_STATUSES)[number];

export interface ConfirmationField {
  label: string;
  value: string;
}

export interface ActionConfirmation {
  id: string;
  botId: string;
  botName?: string;
  kind: ConfirmationKind;
  title: string;
  summary: string;
  target: string | null;
  fields: ConfirmationField[];
  status: ConfirmationStatus;
  decidedBy: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface ConfirmationDecisionInput {
  decision: "approved" | "declined";
  note?: string;
}

export interface ConfirmationListResponse {
  confirmations: ActionConfirmation[];
}

export const CONFIRMATION_KIND_LABELS: Record<ConfirmationKind, string> = {
  send_email: "Send email",
  delete_data: "Delete data",
  publish: "Publish",
  payment: "Payment",
  external_write: "External action",
};
