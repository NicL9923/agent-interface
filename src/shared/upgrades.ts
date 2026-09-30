export type UpgradePhase = "idle" | "checking" | "qualifying" | "ready" | "installing" | "verifying" | "succeeded" | "blocked" | "failed" | "rolled_back";
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
  operationId?: string;
  error?: string;
  checkedAt?: string;
  updatedAt?: string;
  busyBots: string[];
}
export interface UpgradeInstallRequest {
  candidateRevision: string;
  requestId: string;
}
