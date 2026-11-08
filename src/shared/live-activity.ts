/** One row of the aggregate Live Activity. docs/native-api.md is the contract the iOS app decodes. */
export type LivePhase = "starting" | "thinking" | "working" | "waiting" | "blocked" | "done" | "failed" | "interrupted";
export interface LiveRow {
  botId: string;
  name: string;
  phase: LivePhase;
  status: string;
  detail?: string;
  /** Unix epoch seconds. ActivityKit would decode a Date from the 2001 epoch. */
  since?: number;
  color?: string;
  /**
   * A waiting row's first pending approval, so the Live Activity can offer Decline. Approving
   * still happens in the chat, where the approval card shows what it would run.
   */
  approvalId?: string;
}
export interface LiveState {
  title: string;
  activeCount: number;
  attentionCount: number;
  updatedAt: number;
  rows: LiveRow[];
}
