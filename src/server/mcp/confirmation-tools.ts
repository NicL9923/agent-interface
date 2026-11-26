import { InvalidInput } from "../../shared/errors.js";
import {
  CONFIRMATION_KINDS,
  type ConfirmationField,
  type ConfirmationKind,
} from "../../shared/confirmations.js";
import type { ConfirmationRepository } from "../store-confirmations.js";
import type {
  McpBotContext,
  McpToolDefinition,
  McpToolProvider,
  McpToolResult,
} from "./wildbots-mcp.js";

function textResult(value: unknown): McpToolResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
    ...(typeof value === "object" && value !== null && !Array.isArray(value)
      ? { structuredContent: value as Record<string, unknown> }
      : {}),
  };
}

const definitions: readonly McpToolDefinition[] = [
  {
    name: "action_confirm",
    description:
      "Ask a household member to confirm an irreversible external action (sending email/messages, deleting external data, publishing, payments, or modifying external records) before executing it. Waits for their structured approval or decline.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...CONFIRMATION_KINDS] },
        title: { type: "string", minLength: 1, maxLength: 200 },
        summary: { type: "string", minLength: 1, maxLength: 4_000 },
        target: { type: "string", maxLength: 500 },
        fields: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              label: { type: "string", minLength: 1, maxLength: 120 },
              value: { type: "string", minLength: 1, maxLength: 4_000 },
            },
            required: ["label", "value"],
            additionalProperties: false,
          },
        },
      },
      required: ["kind", "title", "summary"],
      additionalProperties: false,
    },
  },
];

export function createConfirmationMcpTools(
  confirmations: ConfirmationRepository,
  options: { timeoutMs?: number } = {},
): McpToolProvider {
  return {
    listTools: () => definitions,
    async callTool(
      ctx: McpBotContext,
      name: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<McpToolResult> {
      if (name !== "action_confirm")
        return { content: [{ type: "text", text: "Unknown confirmation tool." }], isError: true };
      const kind = args.kind as ConfirmationKind;
      if (!CONFIRMATION_KINDS.includes(kind))
        throw new InvalidInput("Choose a supported external action kind.");
      if (typeof args.title !== "string" || !args.title.trim())
        throw new InvalidInput("Provide a confirmation title.");
      if (typeof args.summary !== "string" || !args.summary.trim())
        throw new InvalidInput("Provide a confirmation summary.");
      const target = typeof args.target === "string" ? args.target : undefined;
      const fields: ConfirmationField[] = Array.isArray(args.fields)
        ? args.fields
            .filter(
              (item): item is ConfirmationField =>
                !!item &&
                typeof item === "object" &&
                typeof (item as ConfirmationField).label === "string" &&
                typeof (item as ConfirmationField).value === "string",
            )
            .map((item) => ({ label: item.label, value: item.value }))
        : [];
      const created = confirmations.createPending({
        botId: ctx.botId,
        kind,
        title: args.title,
        summary: args.summary,
        target,
        fields,
      });
      const settled = await confirmations.waitForDecision(created.id, signal, options.timeoutMs);
      return textResult({
        id: settled.id,
        status: settled.status,
        ...(settled.decidedBy ? { decidedBy: settled.decidedBy } : {}),
        ...(settled.decisionNote ? { note: settled.decisionNote } : {}),
      });
    },
  };
}
