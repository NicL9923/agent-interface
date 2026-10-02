export interface ComputerStatus {
  available: boolean;
  running: boolean;
  browserReady: boolean;
  label: string;
  reason?: string;
  control: { kind: "bot" | "human" | "idle"; name?: string; mine?: boolean };
  terminal: { available: boolean; target: string; reason?: string };
}

export interface ComputerAttachment {
  ticket: string;
  path: string;
  viewerId: string;
}

export type ComputerRequest =
  | { action: "status"; actorId?: string; actorName?: string }
  | { action: "observe"; actorId: string; actorName: string; viewerId?: string }
  | { action: "take" | "release"; actorId: string; actorName: string; viewerId: string };

export interface ComputerStreamTicket {
  path: string;
  expiresAt: string;
  viewerId?: string;
  sessionId?: string;
  target?: string;
}
