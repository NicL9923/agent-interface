export type UpgradePhase = "idle" | "checking" | "qualifying" | "ready" | "installing" | "verifying" | "succeeded" | "blocked" | "failed" | "rolled_back" | "recovering" | "cancelled";
export interface UpgradeRevision {
  revision: string;
  version?: string;
  notesUrl?: string;
}
export interface UpgradeCheck {
  id: string;
  label: string;
  status: "pending" | "running" | "passed" | "failed";
  detail?: string;
}
export interface UpgradeStatus {
  available: boolean;
  phase: UpgradePhase;
  current?: UpgradeRevision;
  candidate?: UpgradeRevision;
  message: string;
  checks: UpgradeCheck[];
  canCheck: boolean;
  canInstall: boolean;
  canRetry: boolean;
  canCancel: boolean;
  canRestartService: boolean;
  controlRequestId?: string;
  controlAction?: UpgradeControlAction;
  operationId?: string;
  /** Whether the latest operation only checked and tested an update, or installed one. */
  operation?: "check" | "install";
  error?: string;
  checkedAt?: string;
  updatedAt?: string;
  busyBots: string[];
}
export interface UpgradeInstallRequest {
  candidateRevision: string;
  requestId: string;
}

export type UpgradeControlAction = "retry" | "cancel" | "restart_service";
export interface UpgradeControlRequest {
  action: UpgradeControlAction;
  operationId: string;
  requestId: string;
}
