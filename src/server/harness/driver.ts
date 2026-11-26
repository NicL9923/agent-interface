import type { ModelProvider } from "../../shared/types.js";

/**
 * Canonical native harness identifiers matching the Web/iOS picker (`src/shared/types.ts`).
 * `src/shared/harness.ts` currently uses `"claude"` in its registry enum; `normalizeHarnessId`
 * bridges both until unified.
 */
export const HARNESS_DRIVER_IDS = ["antigravity", "codex", "claude-code", "grok", "pi"] as const;
export type HarnessDriverId = (typeof HARNESS_DRIVER_IDS)[number];

export function normalizeHarnessId(id: string | undefined): HarnessDriverId | undefined {
  if (!id) return undefined;
  const trimmed = id.trim().toLowerCase();
  if (trimmed === "agy" || trimmed === "antigravity") return "antigravity";
  if (trimmed === "claude" || trimmed === "claude-code") return "claude-code";
  if (trimmed === "codex" || trimmed === "grok" || trimmed === "pi") return trimmed;
  return undefined;
}

export interface HarnessMcpServerSpec {
  name: string;
  transport: "stdio" | "http";
  /** For stdio transport. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** For Streamable HTTP transport. */
  url?: string;
  headers?: Record<string, string>;
  /**
   * Stable identity for session fingerprinting when the server mints ephemeral per-session
   * credentials via `open`. Static servers omit this and fingerprint by their full spec.
   */
  fingerprint?: string;
  /**
   * Materializes a plain server spec for one newly opened harness session and returns an optional
   * `revoke` callback invoked when that harness session is disposed.
   */
  open?: (context: { sessionKey: string }) => {
    spec: HarnessMcpServerSpec;
    revoke?: () => void;
  };
}

export function mcpServerFingerprint(server: HarnessMcpServerSpec): Record<string, unknown> {
  if (server.fingerprint !== undefined) {
    return { name: server.name, transport: server.transport, fingerprint: server.fingerprint };
  }
  return {
    name: server.name,
    transport: server.transport,
    ...(server.command !== undefined ? { command: server.command } : {}),
    ...(server.args !== undefined ? { args: server.args } : {}),
    ...(server.env !== undefined ? { env: server.env } : {}),
    ...(server.url !== undefined ? { url: server.url } : {}),
    ...(server.headers !== undefined ? { headers: server.headers } : {}),
  };
}

function stripMcpLifecycle(server: HarnessMcpServerSpec): HarnessMcpServerSpec {
  const { fingerprint: _fingerprint, open: _open, ...plain } = server;
  return plain;
}

/**
 * Materializes dynamic per-session MCP servers (such as WildBots loopback MCP) into plain specs
 * suitable for harness drivers, returning an idempotent `revoke` callback that cleans up every
 * minted MCP session. Rolls back any already-opened sessions if a later server throws.
 */
export function materializeMcpServers(
  servers: readonly HarnessMcpServerSpec[] | undefined,
  sessionKey: string,
): { mcpServers: HarnessMcpServerSpec[] | undefined; revoke: () => void } {
  if (!servers) return { mcpServers: undefined, revoke: () => {} };
  const revokers: (() => void)[] = [];
  let revoked = false;
  const revoke = () => {
    if (revoked) return;
    revoked = true;
    for (const fn of revokers.splice(0).reverse()) {
      try {
        fn();
      } catch {
        // Best-effort cleanup across all opened MCP sessions.
      }
    }
  };
  try {
    const mcpServers = servers.map((server) => {
      if (!server.open) return stripMcpLifecycle(server);
      const opened = server.open({ sessionKey });
      if (opened.revoke) revokers.push(opened.revoke);
      return stripMcpLifecycle(opened.spec);
    });
    return { mcpServers, revoke };
  } catch (error) {
    revoke();
    throw error;
  }
}

export interface HarnessSessionSpec {
  botId: string;
  /** WildBots-owned logical session ID. */
  sessionKey: string;
  /** Provider-specific session/thread ID to resume when continuing a live thread. */
  resumeSessionId?: string;
  cwd: string;
  /** Optional Unix user account for per-owner isolation when spawning the child process. */
  osUser?: string;
  model: string;
  provider?: string;
  reasoning?: string;
  speed?: string;
  /** Generated system/developer instructions (persona + memory/skills bootstrap). */
  systemPrompt?: string;
  /** Scoped MCP servers to attach to this harness session (including WildBots local MCP). */
  mcpServers?: HarnessMcpServerSpec[];
  /** Explicit non-secret or API-key env overrides for this session. */
  env?: Record<string, string>;
  /** When true, run without interactive tool/command approval prompts. */
  fullPermissions: boolean;
}

export interface HarnessAttachment {
  id: string;
  name: string;
  mime: string;
  /** Absolute local path on disk accessible to the harness process. */
  path: string;
}

export interface HarnessTurnInput {
  turnId: string;
  text: string;
  attachments?: HarnessAttachment[];
  senderName?: string;
}

export interface HarnessQuestion {
  id: string;
  header?: string;
  question: string;
  options?: string[];
  multiple?: boolean;
}

export type HarnessEvent =
  | { type: "session.ready"; providerSessionId: string }
  | { type: "turn.started"; turnId: string }
  | { type: "text.delta"; turnId: string; delta: string }
  | { type: "reasoning.delta"; turnId: string; delta: string }
  | {
      type: "tool.started";
      turnId: string;
      callId: string;
      name: string;
      arguments?: string;
    }
  | {
      type: "tool.completed";
      turnId: string;
      callId: string;
      name: string;
      output?: string;
      error?: string;
    }
  | {
      type: "question.asked";
      turnId: string;
      requestId: string;
      title?: string;
      prompt: string;
      questions: HarnessQuestion[];
    }
  | {
      type: "usage.reported";
      turnId: string;
      inputTokens?: number;
      outputTokens?: number;
      contextTokens?: number;
      contextWindow?: number;
    }
  | {
      type: "turn.completed";
      turnId: string;
      text?: string;
      stopReason?: "end_turn" | "interrupted" | "error";
    }
  | {
      type: "turn.failed";
      turnId: string;
      message: string;
      recoverable?: boolean;
    }
  | {
      type: "session.closed";
      reason?: string;
      unexpected: boolean;
    };

export interface HarnessDriverCapabilities {
  nativeSteering: boolean;
  resumable: boolean;
  supportsMcp: boolean;
  supportsImages: boolean;
  supportsReasoning: boolean;
  supportsSpeed: boolean;
}

export interface HarnessProbeResult {
  available: boolean;
  version?: string;
  reason?: string;
}

/** A single live harness process/thread session driven through a structured protocol. */
export interface HarnessSession {
  readonly id: string;
  readonly providerSessionId: string | undefined;
  events(listener: (event: HarnessEvent) => void): () => void;
  startTurn(input: HarnessTurnInput): Promise<void>;
  /** Present only when `driver.capabilities.nativeSteering` is true. */
  steer?(input: HarnessTurnInput): Promise<void>;
  answerQuestion(requestId: string, answers: Record<string, string>): Promise<void>;
  interrupt(turnId?: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Contract for one wrapped agent harness (Codex, Claude Code, Grok, Pi).
 * Pattern adapted from pingdotgg/t3code (MIT License, Copyright (c) 2026 T3 Tools Inc.).
 */
export interface HarnessDriver {
  readonly id: HarnessDriverId;
  readonly displayName: string;
  readonly capabilities: HarnessDriverCapabilities;
  probe(): Promise<HarnessProbeResult>;
  listModels(): Promise<ModelProvider[]>;
  openSession(spec: HarnessSessionSpec): Promise<HarnessSession>;
  close?(): Promise<void>;
}
