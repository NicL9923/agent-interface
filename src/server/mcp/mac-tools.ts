import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MacBroker } from "../mac-link.js";
import type { Store } from "../store.js";

/** Identity supplied by the MCP session, never by tool arguments. */
export interface McpToolContext {
  botId: string;
  ownerId?: string;
  shared: boolean;
  /** WildBots conversation that issued the tool call, when one is available. */
  sessionKey?: string;
  /** False only for an attended WildBots chat. Omitted means unattended. */
  scheduled?: boolean;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpToolProvider {
  listTools(ctx: McpToolContext): readonly McpToolDefinition[];
  callTool(
    ctx: McpToolContext,
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<McpToolResult>;
}

export function toolResult(value: Record<string, unknown>, isError = false): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError } : {}),
  };
}

export function toolFailure(code: string, message: string): McpToolResult {
  return toolResult({ ok: false, error: { code, message } }, true);
}

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const screenshotSchema = z.object({
  pngBase64: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

/** Send screenshots as MCP images and keep their bytes out of the text result. */
export function screenshotResult(value: unknown): McpToolResult {
  const parsed = screenshotSchema.safeParse(value);
  if (!parsed.success) return toolFailure("failed", "The computer did not return a valid PNG.");
  const { pngBase64, ...size } = parsed.data;
  const png = Buffer.from(pngBase64, "base64");
  if (
    !png.subarray(0, pngSignature.length).equals(pngSignature) ||
    png.toString("base64") !== pngBase64
  )
    return toolFailure("failed", "The computer did not return a valid PNG.");
  const result = toolResult({ ok: true, value: size });
  result.content.push({ type: "image", mimeType: "image/png", data: pngBase64 });
  return result;
}

export function toolDefinition(
  name: string,
  description: string,
  schema: z.ZodObject,
): McpToolDefinition {
  return { name, description, inputSchema: z.toJSONSchema(schema) };
}

/** The app's live MacBroker implements the same relay contract. */
export type MacLinkRelay = Pick<MacBroker, "invoke">;

type MacAction = Parameters<MacLinkRelay["invoke"]>[0]["action"];
type MacStore = Pick<Store, "presentation"> & { macs: Pick<Store["macs"], "linked"> };

const device = z.string().min(1).max(200).describe("A Mac's name from mac_list, or its ID.");
const path = z.string();
const offset = z.number().int().min(0).optional();
const macTools = new Map<
  string,
  { action: MacAction; definition: McpToolDefinition; schema: z.ZodObject }
>();
function macTool(action: MacAction, description: string, parameters: z.ZodRawShape = {}) {
  const name = `mac_${action}`;
  const schema = z.strictObject({ ...parameters, device: device.optional() });
  macTools.set(name, { action, definition: toolDefinition(name, description, schema), schema });
}

macTool(
  "list",
  "List the user's linked Macs, their online status, granted folders and available abilities.",
);
macTool(
  "run",
  "Run a zsh command confined to the Mac's granted folders and a private temporary folder.",
  {
    command: z.string().min(1).max(16_384),
    cwd: z
      .string()
      .optional()
      .describe(
        "Absolute, ~/..., or relative to the first granted folder. Defaults to that folder.",
      ),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(600)
      .optional()
      .describe("Defaults to 120 seconds."),
  },
);
macTool(
  "read_file",
  "Read a granted file as UTF-8 or base64. Returns the SHA-256 of the whole file.",
  {
    path,
    offset,
    length: z.number().int().min(1).max(1_048_576).optional().describe("Defaults to 262144 bytes."),
  },
);
macTool("write_file", "Create or atomically replace a file in a granted folder. Up to 1 MiB.", {
  path,
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).optional().describe("Defaults to utf8."),
  expectedSha256: z
    .string()
    .optional()
    .describe("Replace only if this SHA-256 still matches the file."),
  createOnly: z.boolean().optional().describe("Fail if the file exists."),
});
macTool("list_dir", "List a directory in a granted folder.", {
  path,
  offset,
  limit: z.number().int().min(1).max(500).optional().describe("Defaults to 200 entries."),
});
macTool(
  "screenshot",
  "Capture the Mac's main display, including all visible apps. Fails while the screen is locked.",
);

const definitions = [...macTools.values()].map(({ definition }) => definition);
const permissionDenied = () =>
  toolFailure(
    "assistant_not_personal",
    "Only the Mac owner's personal bot may use their linked Mac.",
  );
const macNotFound = () => toolFailure("mac_not_found", "Mac not found");

export function createMacMcpTools({
  store,
  relay,
}: {
  store: MacStore;
  relay: MacLinkRelay;
}): McpToolProvider {
  const personalOwner = (ctx: McpToolContext) => {
    if (ctx.shared !== false || !ctx.ownerId) return undefined;
    const current = store.presentation(ctx.botId);
    return current.shared === false && current.ownerId === ctx.ownerId ? ctx.ownerId : undefined;
  };

  return {
    listTools: (ctx) => (personalOwner(ctx) ? definitions : []),
    async callTool(ctx, name, args, signal) {
      const ownerId = personalOwner(ctx);
      if (!ownerId) return permissionDenied();
      const tool = macTools.get(name);
      if (!tool) return toolFailure("unknown_tool", "Unknown Mac tool.");
      const { action, schema } = tool;
      const parsed = schema.safeParse(args === undefined ? {} : args);
      if (!parsed.success) return toolFailure("invalid_arguments", parsed.error.issues[0].message);
      const { device: requested, ...actionArgs } = parsed.data as {
        device?: string;
        [key: string]: unknown;
      };
      // Resolve a supplied name or ID within this owner's current links before calling the broker.
      let target: string | undefined;
      if (requested !== undefined) {
        const linked = store.macs.linked(ownerId);
        target = (
          linked.find((mac) => mac.id === requested) ??
          linked.find((mac) => mac.name.toLowerCase() === requested.toLowerCase())
        )?.id;
        if (!target) return macNotFound();
      }
      if (signal?.aborted)
        return toolFailure("cancelled", "The Mac action was cancelled before dispatch.");
      const outcome = await relay.invoke({
        invocationId: `inv-${randomUUID()}`,
        assistantId: ctx.botId,
        scheduled: ctx.scheduled !== false,
        action,
        ...(target === undefined ? {} : { device: target }),
        args: actionArgs,
      });
      if (!outcome.ok && target && ["choose_mac", "no_mac"].includes(outcome.error.code))
        return macNotFound();
      if (outcome.ok && action === "screenshot") return screenshotResult(outcome.value);
      return toolResult(outcome, !outcome.ok);
    },
  };
}
