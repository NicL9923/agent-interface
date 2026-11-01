export interface ComputerStatus {
  available: boolean;
  running: boolean;
  browserReady: boolean;
  label: string;
  reason?: string;
  control: { kind: "bot" | "human" | "idle"; name?: string; mine?: boolean };
  /** target is blank when this person may not use the shell. confirmationRequired asks for a fresh sign-in first. */
  terminal: { available: boolean; target: string; reason?: string; confirmationRequired?: boolean };
}

export interface ComputerAttachment {
  ticket: string;
  path: string;
  viewerId: string;
}

export type ComputerRequest =
  | { action: "status"; actorId?: string; actorName?: string }
  | { action: "observe"; actorId: string; actorName: string; viewerId?: string }
  | { action: "take" | "release"; actorId: string; actorName: string; viewerId: string }
  /** Not now on an assistant's handoff request. Hermes checks it belongs to that profile's conversation. */
  | { action: "handoff"; decision: "decline"; profile: string; requestId: string; epoch: string; sessionId: string; actorId: string; actorName: string };

/** The add-on's native ask method. src/hermes/computer.py HANDOFF must match; tests/computer-api.test.ts checks. */
export const computerHandoffMethod = "agent_interface.computer_handoff";

/**
 * An assistant asking a person to take over the household computer. Hermes settles it as
 * handed back once someone who took control returns it, or declined by Not now; a chat
 * message closes it. reason and whatToDo are the assistant's own words.
 */
export interface ComputerHandoff {
  epoch: string;
  sessionId: string;
  reason: string;
  whatToDo: string;
}
export type ComputerHandoffResult = { status: "ok" | "expired" };

export interface ComputerStreamTicket {
  path: string;
  expiresAt: string;
  viewerId?: string;
  sessionId?: string;
  target?: string;
}
