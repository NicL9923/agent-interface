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
}
export interface LiveState {
  title: string;
  activeCount: number;
  attentionCount: number;
  updatedAt: number;
  rows: LiveRow[];
}
