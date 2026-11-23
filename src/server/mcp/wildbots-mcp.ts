import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { addAbortListener, once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Conflict, InvalidInput, NotFound, RuntimeRefusal } from "../../shared/errors.js";
import { visible } from "../bot-access.js";
import { assertBotHandoffAllowed } from "../credential-policy.js";
import type { HarnessMcpServerSpec } from "../harness/driver.js";
import type { SecretBotContext, SecretRepository } from "../store-secrets.js";
import type { Store } from "../store.js";
import { generateImageTool, type ImageGenerationOptions } from "./image-gen.js";

export type McpBotContext = Readonly<
  SecretBotContext & {
    allowedTools?: readonly string[];
    /** The application-owned chat session, when the tool is called from a chat. */
    sessionKey?: string;
    /** Set by the application when opening a session for a scheduled run. */
    scheduled?: boolean;
  }
>;
export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
export type McpToolResult = {
  content: readonly (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  )[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
export interface McpToolProvider {
  listTools(ctx: McpBotContext): readonly McpToolDefinition[];
  callTool(
    ctx: McpBotContext,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): McpToolResult | Promise<McpToolResult>;
}

export type SecretInputRequest = {
  id: string;
  name: string;
  prompt: string;
  context: McpBotContext;
};
/** The authenticated card handler supplies a value here only when the human elects to save it. */
export type SecretInputOutcome =
  | { status: "cancelled" }
  | { status: "submitted"; save?: { value: string; createdBy: string } };

export interface WildbotsMcpOptions {
  store: Pick<Store, "transcripts" | "managedBots" | "presentation">;
  secrets: SecretRepository;
  onSecretRequest?: (
    request: SecretInputRequest,
    signal: AbortSignal,
  ) => Promise<SecretInputOutcome>;
  onMessageBot?: (
    message: {
      source: McpBotContext;
      targetBotId: string;
      message: string;
    },
    signal: AbortSignal,
  ) => Promise<void>;
  imageGeneration?: ImageGenerationOptions;
  extraToolProviders?: readonly McpToolProvider[];
  sessionTtlMs?: number;
}

type Args = Record<string, unknown>;
type ToolCall = (ctx: McpBotContext, args: Args, signal: AbortSignal) => unknown;
type RequestId = string | number;
type Session = {
  context: McpBotContext;
  expected: Buffer;
  expiresAt: number;
  signal: AbortSignal;
  revoke: () => void;
  protocolVersion?: string;
  calls: Map<RequestId, AbortController>;
};

const path = "/mcp";
const protocolVersions = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
const maxRequestBytes = 64 * 1024;
const tokenPattern = /^Bearer ([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/i;
const missingDigest = Buffer.alloc(32);
const digest = (secret: string) => createHash("sha256").update(secret).digest();
const object = (value: unknown): value is Args =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringInput = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });

function textArg(args: Args, name: string, maxLength: number): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim() || value.length > maxLength)
    throw new InvalidInput(`Provide a valid ${name}.`);
  return value;
}

function textResult(value: unknown): McpToolResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
    ...(object(value) && { structuredContent: value }),
  };
}

function builtInTools(options: WildbotsMcpOptions, assertSession: (ctx: McpBotContext) => void) {
  const { store, secrets, imageGeneration, onSecretRequest, onMessageBot } = options;
  const tools = new Map<string, { definition: McpToolDefinition; call: ToolCall }>();
  function add(
    name: string,
    description: string,
    properties: Args,
    required: string[],
    call: ToolCall,
  ) {
    tools.set(name, {
      definition: {
        name,
        description,
        inputSchema: { type: "object", properties, required, additionalProperties: false },
      },
      call,
    });
  }
  add(
    "chat_search",
    "Search this assistant's chat history.",
    { query: stringInput(2_000), limit: { type: "integer", minimum: 1, maximum: 50 } },
    ["query"],
    (ctx, args) => {
      const query = textArg(args, "query", 2_000);
      const limit = args.limit === undefined ? 10 : args.limit;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50)
        throw new InvalidInput("Choose a search limit from 1 to 50.");
      // FTS highlighting can split a literal secret before redaction.
      const hits = store.transcripts.search([ctx.botId], query, { limit, highlight: false });
      return {
        hits: hits.map((hit) => ({
          ...hit,
          snippet: secrets.redactForBot(ctx.botId, hit.snippet),
        })),
      };
    },
  );
  add(
    "secret_list",
    "List the names of secrets available to this assistant.",
    {},
    [],
    async (ctx, _args, signal) => ({ names: await secrets.listSecrets(ctx, signal) }),
  );
  add(
    "secret_get",
    "Get a saved secret for tool use. Keep its value out of chat and tool logs.",
    { name: stringInput(128) },
    ["name"],
    async (ctx, args, signal) => {
      const value = await secrets.getSecret(ctx, textArg(args, "name", 128), signal);
      if (value === undefined) throw new NotFound("Secret not found.");
      return { value };
    },
  );

  if (onSecretRequest)
    add(
      "secret_request",
      "Ask a person to enter a credential privately. Returns only the status of the request.",
      { name: stringInput(128), prompt: stringInput(2_000) },
      ["name", "prompt"],
      async (ctx, args, signal) => {
        const name = textArg(args, "name", 128);
        const prompt = secrets.redactForBot(ctx.botId, textArg(args, "prompt", 2_000));
        let outcome: SecretInputOutcome;
        try {
          outcome = await onSecretRequest({ id: randomUUID(), name, prompt, context: ctx }, signal);
        } catch {
          throw new Conflict("The secure input request could not be completed.");
        }
        signal.throwIfAborted();
        assertSession(ctx);
        if (outcome.status === "cancelled") return { status: "cancelled" };
        if (outcome.save) {
          const { value, createdBy } = outcome.save;
          secrets.setSecret({ kind: "bot", id: ctx.botId }, name, value, createdBy);
        }
        return { status: "submitted", saved: !!outcome.save };
      },
    );

  if (onMessageBot)
    add(
      "message_bot",
      "Send a handoff message to a visible assistant.",
      { botId: stringInput(256), message: stringInput(20_000) },
      ["botId", "message"],
      async (ctx, args, signal) => {
        const botId = textArg(args, "botId", 256);
        const message = textArg(args, "message", 20_000);
        const target = store.managedBots.getManagedBot(botId);
        const sourceOwner = ctx.shared === false ? ctx.ownerId : undefined;
        if (
          !target ||
          target.archivedAt != null ||
          !visible(target, sourceOwner) ||
          !visible(store.presentation(botId), sourceOwner)
        )
          throw new NotFound("Assistant not found.");
        const credential = target.credentialId
          ? store.managedBots.getCredential(target.credentialId)
          : undefined;
        assertBotHandoffAllowed(target, credential, sourceOwner);
        await onMessageBot(
          { source: ctx, targetBotId: botId, message: secrets.redactForBot(ctx.botId, message) },
          signal,
        );
        return { status: "sent" };
      },
    );

  if (imageGeneration)
    add(
      "image_generate",
      "Generate an image and return a WildBots file reference.",
      { prompt: stringInput(20_000), size: stringInput(32), quality: stringInput(32) },
      ["prompt"],
      async (ctx, args, signal) => ({
        file: await generateImageTool({
          ...imageGeneration,
          botId: ctx.botId,
          prompt: secrets.redactForBot(ctx.botId, textArg(args, "prompt", 20_000)),
          size:
            args.size === undefined
              ? undefined
              : secrets.redactForBot(ctx.botId, textArg(args, "size", 32)),
          quality:
            args.quality === undefined
              ? undefined
              : secrets.redactForBot(ctx.botId, textArg(args, "quality", 32)),
          signal,
        }),
      }),
    );
  return tools;
}

function send(res: ServerResponse, status: number, body?: unknown) {
  if (res.writableEnded || res.destroyed) return;
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  if (body === undefined) res.end();
  else {
    const json = JSON.stringify(body);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(json);
  }
}

function rpcError(
  res: ServerResponse,
  id: RequestId | null,
  code: number,
  message: string,
  status = 200,
) {
  send(res, status, { jsonrpc: "2.0", id, error: { code, message } });
}

function unauthorized(res: ServerResponse) {
  if (res.writableEnded || res.destroyed) return;
  res.setHeader("WWW-Authenticate", "Bearer");
  send(res, 401);
}

async function readRpc(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxRequestBytes) {
      res.setHeader("Connection", "close");
      send(res, 413);
      return;
    }
    parts.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    rpcError(res, null, -32700, "Parse error", 400);
  }
}

export async function createWildbotsMcpServer(options: WildbotsMcpOptions) {
  const { store, secrets, extraToolProviders = [], sessionTtlMs = 30 * 60_000 } = options;
  if (!Number.isInteger(sessionTtlMs) || sessionTtlMs < 1 || sessionTtlMs > 2_147_483_647)
    throw new Error("Invalid WildBots MCP session lifetime.");
  const sessions = new Map<string, Session>();
  let address: string;
  let closing: Promise<void> | undefined;

  function assertSession(ctx: McpBotContext) {
    const bot = store.managedBots.getManagedBot(ctx.botId);
    const presentation = store.presentation(ctx.botId);
    if (
      !bot ||
      bot.archivedAt != null ||
      bot.shared !== ctx.shared ||
      (bot.ownerId || undefined) !== ctx.ownerId ||
      (presentation.shared !== undefined && presentation.shared !== ctx.shared) ||
      (presentation.ownerId !== undefined && presentation.ownerId !== ctx.ownerId)
    )
      throw new Conflict("This assistant's session is no longer available.");
  }
  const builtIns = builtInTools(options, assertSession);

  function authorizedSession(header: string | undefined): Session | undefined {
    const token = tokenPattern.exec(header ?? "");
    if (!token) return undefined;
    const session = sessions.get(token[1]);
    const matches = timingSafeEqual(digest(token[2]), session?.expected ?? missingDigest);
    if (!matches || !session) return undefined;
    if (Date.now() < session.expiresAt) return session;
    session.revoke();
  }

  function availableTools(ctx: McpBotContext) {
    const tools = new Map<string, { definition: McpToolDefinition; provider?: McpToolProvider }>();
    const add = (definition: McpToolDefinition, provider?: McpToolProvider) => {
      if (ctx.allowedTools && !ctx.allowedTools.includes(definition.name)) return;
      if (tools.has(definition.name) || (provider && builtIns.has(definition.name)))
        throw new Error("Duplicate WildBots MCP tool.");
      tools.set(definition.name, { definition, provider });
    };
    for (const { definition } of builtIns.values()) add(definition);
    for (const provider of extraToolProviders)
      for (const definition of provider.listTools(ctx)) add(definition, provider);
    return tools;
  }

  async function dispatch(req: IncomingMessage, res: ServerResponse) {
    if (req.url !== path) return send(res, 404);
    if (
      req.headers.host !== address ||
      (req.headers.origin !== undefined && req.headers.origin !== `http://${address}`)
    )
      return send(res, 403);
    const session = authorizedSession(req.headers.authorization);
    if (!session) return unauthorized(res);
    try {
      assertSession(session.context);
    } catch (error) {
      if (!(error instanceof Conflict)) throw error;
      session.revoke();
      return unauthorized(res);
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return send(res, 405);
    }
    if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json")
      return send(res, 415);
    const input = await readRpc(req, res);
    if (res.writableEnded) return;
    if (session.signal.aborted) return unauthorized(res);
    if (
      !object(input) ||
      input.jsonrpc !== "2.0" ||
      typeof input.method !== "string" ||
      (input.id !== undefined && typeof input.id !== "string" && typeof input.id !== "number")
    )
      return rpcError(res, null, -32600, "Invalid request", 400);
    const id = typeof input.id === "string" || typeof input.id === "number" ? input.id : undefined;
    const params = input.params;
    const protocol = req.headers["mcp-protocol-version"];
    if (protocol !== undefined && protocol !== session.protocolVersion)
      return rpcError(res, id ?? null, -32600, "Unsupported MCP protocol version", 400);
    if (id === undefined) {
      if (
        input.method === "notifications/cancelled" &&
        object(params) &&
        (typeof params.requestId === "string" || typeof params.requestId === "number")
      )
        session.calls.get(params.requestId)?.abort();
      return send(res, 202);
    }
    const reply = (result: unknown) => send(res, 200, { jsonrpc: "2.0", id, result });
    if (input.method === "initialize") {
      if (!object(params) || typeof params.protocolVersion !== "string")
        return rpcError(res, id, -32602, "Invalid initialization parameters");
      session.protocolVersion =
        protocolVersions.find((version) => version === params.protocolVersion) ??
        protocolVersions[0];
      return reply({
        protocolVersion: session.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "wildbots", version: "1.0.0" },
      });
    }
    if (input.method === "ping") return reply({});
    if (!session.protocolVersion)
      return rpcError(res, id, -32002, "MCP session is not initialized");

    if (input.method === "tools/list")
      return reply({
        tools: [...availableTools(session.context).values()].map(({ definition }) => definition),
      });
    if (input.method !== "tools/call") return rpcError(res, id, -32601, "Method not found");
    if (
      !object(params) ||
      typeof params.name !== "string" ||
      (params.arguments !== undefined && !object(params.arguments))
    )
      return rpcError(res, id, -32602, "Invalid tool call parameters");
    const tool = availableTools(session.context).get(params.name);
    if (!tool) return rpcError(res, id, -32602, "Tool not available");
    if (session.calls.has(id)) return rpcError(res, id, -32600, "Duplicate in-flight request ID");
    const controller = new AbortController();
    session.calls.set(id, controller);
    const signal = AbortSignal.any([session.signal, controller.signal]);
    const onCancel = addAbortListener(signal, () => {
      if (session.signal.aborted) unauthorized(res);
      else send(res, 202);
    });
    const { context } = session;
    const args = params.arguments ?? {};
    try {
      signal.throwIfAborted();
      assertSession(context);
      const result = tool.provider
        ? await tool.provider.callTool(context, params.name, args, signal)
        : textResult(await builtIns.get(params.name)!.call(context, args, signal));
      signal.throwIfAborted();
      assertSession(context);
      reply(result);
    } catch (error) {
      if (!signal.aborted)
        reply({
          ...textResult(
            error instanceof RuntimeRefusal
              ? secrets.redactForBot(context.botId, error.message)
              : "The tool could not complete the request.",
          ),
          isError: true,
        });
    } finally {
      onCancel[Symbol.dispose]();
      session.calls.delete(id);
    }
  }

  const server = createServer((req, res) => {
    void dispatch(req, res).catch(() => rpcError(res, null, -32603, "Internal error", 500));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Missing WildBots MCP address.");
  address = `127.0.0.1:${bound.port}`;

  return {
    createSessionSpec(botContext: McpBotContext): {
      spec: HarnessMcpServerSpec;
      revoke: () => void;
    } {
      if (closing) throw new Error("The WildBots MCP server is closed.");
      const context: McpBotContext = Object.freeze({
        ...botContext,
        allowedTools: botContext.allowedTools && Object.freeze([...botContext.allowedTools]),
      });
      assertSession(context);
      const id = randomBytes(12).toString("base64url");
      const secret = randomBytes(32).toString("base64url");
      const controller = new AbortController();
      const revoke = () => {
        sessions.delete(id);
        clearTimeout(timer);
        controller.abort();
      };
      const timer = setTimeout(revoke, sessionTtlMs).unref();
      sessions.set(id, {
        context,
        expected: digest(secret),
        signal: controller.signal,
        revoke,
        expiresAt: Date.now() + sessionTtlMs,
        calls: new Map(),
      });
      return {
        spec: {
          name: "wildbots",
          transport: "http",
          url: `http://${address}${path}`,
          headers: { Authorization: `Bearer ${id}.${secret}` },
        },
        revoke,
      };
    },
    close() {
      if (closing) return closing;
      closing = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      for (const session of sessions.values()) session.revoke();
      server.closeAllConnections();
      return closing;
    },
  };
}
