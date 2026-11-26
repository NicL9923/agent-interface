import { Conflict, InvalidInput, NotFound } from "../../shared/errors.js";
import type { ManagedBotRecord } from "../../shared/harness.js";
import type {
  ConnectionRequestResult,
  ConnectionRequestSettle,
  IntegrationCatalog,
  IntegrationCategory,
  IntegrationConnection,
  IntegrationFlow,
  IntegrationRequest,
  IntegrationStatus,
} from "../../shared/integrations.js";
import type { Store } from "../store.js";
import type { HarnessMcpServerSpec } from "./driver.js";

const MCP_PREFIX = "mcp:";
const KEY_PREFIX = "integration_key:";
const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const RESERVED_MCP_NAMES = new Set(["wildbots"]);
const BLOCKED_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
  "100.100.100.200",
]);

interface KeyConnectorSpec {
  id: string;
  keyName: string;
  name: string;
  category: IntegrationCategory;
  envVar: string;
  description: string;
  capabilities: string[];
}

const KEY_CONNECTORS: readonly KeyConnectorSpec[] = [
  {
    id: "key:openai",
    keyName: "openai",
    name: "OpenAI",
    category: "providers",
    envVar: "OPENAI_API_KEY",
    description: "Models, voice transcription, spoken replies, live Talk, and image generation.",
    capabilities: ["Models", "Voice", "Images"],
  },
  {
    id: "key:anthropic",
    keyName: "anthropic",
    name: "Anthropic",
    category: "providers",
    envVar: "ANTHROPIC_API_KEY",
    description: "Claude models via Anthropic API.",
    capabilities: ["Models"],
  },
  {
    id: "key:xai",
    keyName: "xai",
    name: "xAI Grok",
    category: "providers",
    envVar: "XAI_API_KEY",
    description: "Grok models and Grok live voice.",
    capabilities: ["Models", "Voice"],
  },
  {
    id: "key:openrouter",
    keyName: "openrouter",
    name: "OpenRouter",
    category: "providers",
    envVar: "OPENROUTER_API_KEY",
    description: "Multi-provider routing and automatic fallback models.",
    capabilities: ["Models", "Fallback"],
  },
  {
    id: "key:gemini",
    keyName: "gemini",
    name: "Google Gemini",
    category: "providers",
    envVar: "GEMINI_API_KEY",
    description: "Gemini and Antigravity models.",
    capabilities: ["Models"],
  },
  {
    id: "key:brave",
    keyName: "brave",
    name: "Brave Search",
    category: "providers",
    envVar: "BRAVE_API_KEY",
    description: "Web search API key for assistants.",
    capabilities: ["Web search"],
  },
  {
    id: "key:github",
    keyName: "github",
    name: "GitHub",
    category: "development",
    envVar: "GITHUB_TOKEN",
    description: "GitHub API access for repositories, issues, and pull requests.",
    capabilities: ["Repositories", "Pull requests"],
  },
];

interface StoredMcpServer {
  name: string;
  url: string;
  auth: "none" | "bearer";
  token?: string;
  createdAt: string;
  checkedAt?: string;
  lastStatus?: IntegrationStatus;
  lastDetail?: string;
}

export interface McpProbeResult {
  status: "connected" | "unavailable";
  detail: string;
}

export interface NativeIntegrationsHandler {
  handle(
    input: IntegrationRequest,
  ): Promise<IntegrationCatalog | IntegrationConnection | IntegrationFlow | { ok: true }>;
  settleConnectionRequest(input: ConnectionRequestSettle): Promise<ConnectionRequestResult>;
  mcpServersForBot(botId: string): HarnessMcpServerSpec[];
  envForBot(botId: string): Record<string, string>;
}

function validateMcpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new InvalidInput("Enter a valid http:// or https:// MCP server URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new InvalidInput("Custom MCP servers must use http:// or https://.");
  if (url.username || url.password)
    throw new InvalidInput(
      "Do not include credentials in the MCP server URL; use Access token authentication.",
    );
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host))
    throw new InvalidInput("That host cannot be used as a custom MCP server.");
  return url.href;
}

async function defaultProbeMcp(url: string, token: string | undefined): Promise<McpProbeResult> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "wildbots", version: "1.0.0" },
        },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 401 || response.status === 403)
      return {
        status: "unavailable",
        detail: `MCP server rejected credentials (HTTP ${response.status}).`,
      };
    if (response.ok || response.status === 405 || response.status === 400)
      return { status: "connected", detail: `Reachable at ${new URL(url).origin}.` };
    return { status: "unavailable", detail: `MCP server responded with HTTP ${response.status}.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not reach MCP server.";
    return { status: "unavailable", detail: `Could not reach MCP server: ${message}` };
  }
}

function parseStoredMcp(raw: string): StoredMcpServer | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredMcpServer>;
    if (
      !parsed ||
      typeof parsed.name !== "string" ||
      typeof parsed.url !== "string" ||
      (parsed.auth !== "none" && parsed.auth !== "bearer")
    )
      return undefined;
    return {
      name: parsed.name,
      url: parsed.url,
      auth: parsed.auth,
      ...(typeof parsed.token === "string" && parsed.token ? { token: parsed.token } : {}),
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
      ...(typeof parsed.checkedAt === "string" ? { checkedAt: parsed.checkedAt } : {}),
      ...(parsed.lastStatus ? { lastStatus: parsed.lastStatus } : {}),
      ...(typeof parsed.lastDetail === "string" ? { lastDetail: parsed.lastDetail } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Native Integrations & Custom MCP Manager backed by SQLite encrypted `store.secrets`.
 * Serves `/api/integrations*` and exposes enabled custom MCP servers & per-bot API keys to `HarnessRuntime`.
 */
export function createNativeIntegrationsHandler({
  store,
  requireBot,
  env = process.env,
  probeMcp = defaultProbeMcp,
  now = () => new Date().toISOString(),
}: {
  store: Store;
  requireBot: (id: string) => ManagedBotRecord;
  env?: NodeJS.ProcessEnv;
  probeMcp?: (url: string, token: string | undefined) => Promise<McpProbeResult>;
  now?: () => string;
}): NativeIntegrationsHandler {
  const keyMap = new Map(KEY_CONNECTORS.map((spec) => [spec.id, spec]));

  function readBotKeySecret(botId: string, keyName: string): string | undefined {
    const row = store.secrets
      .listScopeSecrets({ kind: "bot", id: botId }, `${KEY_PREFIX}${keyName}`)
      .find((entry) => entry.name === `${KEY_PREFIX}${keyName}`);
    return row?.value;
  }

  function listStoredMcp(botId: string): StoredMcpServer[] {
    const rows = store.secrets.listScopeSecrets({ kind: "bot", id: botId }, MCP_PREFIX);
    const servers: StoredMcpServer[] = [];
    for (const row of rows) {
      const parsed = parseStoredMcp(row.value);
      if (parsed) servers.push(parsed);
    }
    return servers;
  }

  function readStoredMcp(botId: string, name: string): StoredMcpServer | undefined {
    const row = store.secrets
      .listScopeSecrets({ kind: "bot", id: botId }, `${MCP_PREFIX}${name}`)
      .find((entry) => entry.name === `${MCP_PREFIX}${name}`);
    return row ? parseStoredMcp(row.value) : undefined;
  }

  function toKeyConnection(
    bot: ManagedBotRecord,
    spec: KeyConnectorSpec,
    checkedAt?: string,
  ): IntegrationConnection {
    const stored = readBotKeySecret(bot.id, spec.keyName);
    const envValue = Object.hasOwn(env, spec.envVar) ? env[spec.envVar]?.trim() : "";
    const hasStored = Boolean(stored?.trim());
    const hasEnv = Boolean(envValue);
    const connected = hasStored || hasEnv;
    return {
      id: spec.id,
      name: spec.name,
      category: spec.category,
      owner: hasStored ? "WildBots vault" : hasEnv ? "Host environment" : "WildBots",
      profile: bot.id,
      status: connected ? "connected" : "not_connected",
      detail: hasStored
        ? `${spec.description} Encrypted key saved for ${bot.name}.`
        : hasEnv
          ? `${spec.description} Configured via ${spec.envVar} on this host.`
          : `${spec.description} Add an API key to enable for ${bot.name}.`,
      ...(checkedAt ? { checkedAt } : {}),
      uses: spec.envVar,
      permissions: [],
      actions: {
        connect: true,
        check: true,
        disconnect: hasStored,
      },
      setup: [
        {
          key: "api_key",
          label: `${spec.name} API key`,
          kind: "secret",
          required: true,
        },
      ],
      capabilities: spec.capabilities,
      botIds: [bot.id],
    };
  }

  function toMcpConnection(bot: ManagedBotRecord, server: StoredMcpServer): IntegrationConnection {
    const enabled = bot.enabledMcpServers.includes(server.name);
    let origin = server.url;
    try {
      origin = new URL(server.url).origin;
    } catch {
      /* Keep raw string. */
    }
    const status: IntegrationStatus =
      server.lastStatus ?? (enabled ? "configured" : "not_connected");
    return {
      id: `${MCP_PREFIX}${server.name}`,
      name: server.name,
      category: "custom",
      owner: "WildBots",
      profile: bot.id,
      account: origin,
      status,
      detail:
        server.lastDetail ??
        (server.auth === "bearer"
          ? `Custom HTTP MCP server (${origin}) with encrypted bearer token.`
          : `Custom HTTP MCP server (${origin}).`),
      ...(server.checkedAt ? { checkedAt: server.checkedAt } : {}),
      uses: `MCP · ${server.url}`,
      permissions: [],
      actions: {
        connect: true,
        check: true,
        disconnect: true,
      },
      setup: [
        {
          key: "url",
          label: "Server address",
          kind: "url",
          required: true,
          defaultValue: server.url,
        },
        ...(server.auth === "bearer"
          ? [
              {
                key: "token",
                label: "Access token",
                kind: "secret" as const,
                required: false,
              },
            ]
          : []),
      ],
      capabilities: ["Custom MCP tools"],
      botIds: [bot.id],
    };
  }

  function appleConnection(bot: ManagedBotRecord): IntegrationConnection {
    return {
      id: "apple",
      name: "Apple Calendar & Reminders",
      category: "devices",
      owner: "Your iPhone",
      profile: bot.id,
      status: "connected",
      detail:
        "Choose calendars and reminders in the WildBots iPhone app to review a snapshot and add it to a draft.",
      permissions: [],
      actions: { connect: false, check: false, disconnect: false },
      setup: [],
      capabilities: ["Calendars", "Reminders"],
      botIds: [bot.id],
    };
  }

  function enableMcpOnBot(bot: ManagedBotRecord, name: string) {
    if (bot.enabledMcpServers.includes(name)) return;
    store.managedBots.upsertManagedBot({
      ...bot,
      enabledMcpServers: [...bot.enabledMcpServers, name],
      updatedAt: Date.now(),
    });
  }

  function disableMcpOnBot(bot: ManagedBotRecord, name: string) {
    if (!bot.enabledMcpServers.includes(name)) return;
    store.managedBots.upsertManagedBot({
      ...bot,
      enabledMcpServers: bot.enabledMcpServers.filter((entry) => entry !== name),
      updatedAt: Date.now(),
    });
  }

  function resolveBot(profile: string): ManagedBotRecord {
    try {
      return requireBot(profile);
    } catch (error) {
      if (profile === "default") {
        const first = store.managedBots.listManagedBots().find((bot) => bot.archivedAt == null);
        if (first) return first;
      }
      throw error;
    }
  }

  async function handle(
    input: IntegrationRequest,
  ): Promise<IntegrationCatalog | IntegrationConnection | IntegrationFlow | { ok: true }> {
    const bot = resolveBot(input.profile);
    const scope = { kind: "bot" as const, id: bot.id };
    switch (input.operation) {
      case "list": {
        const connections: IntegrationConnection[] = [
          ...KEY_CONNECTORS.map((spec) => toKeyConnection(bot, spec)),
          appleConnection(bot),
          ...listStoredMcp(bot.id).map((server) => toMcpConnection(bot, server)),
        ];
        return {
          profile: bot.id,
          canManage: true,
          connections,
        } satisfies IntegrationCatalog;
      }
      case "add_mcp": {
        const mcp = input.mcp;
        if (!mcp) throw new InvalidInput("Provide custom MCP connection details.");
        const name = mcp.name.trim();
        if (!MCP_NAME_PATTERN.test(name) || RESERVED_MCP_NAMES.has(name.toLowerCase()))
          throw new InvalidInput(
            "Choose a custom MCP name with letters, numbers, underscores, or hyphens (not 'wildbots').",
          );
        if (mcp.auth === "oauth")
          throw new Conflict(
            "Browser OAuth sign-in for custom MCP servers is not yet supported natively. Use No sign-in or Access token.",
          );
        const url = validateMcpUrl(mcp.url);
        const token = mcp.auth === "bearer" ? mcp.token?.trim() : undefined;
        if (mcp.auth === "bearer" && !token)
          throw new InvalidInput("Enter an access token for bearer authentication.");
        const probe = await probeMcp(url, token);
        const checkedAt = now();
        const record: StoredMcpServer = {
          name,
          url,
          auth: mcp.auth,
          ...(token ? { token } : {}),
          createdAt: checkedAt,
          checkedAt,
          lastStatus: probe.status,
          lastDetail: probe.detail,
        };
        store.secrets.setSecret(
          scope,
          `${MCP_PREFIX}${name}`,
          JSON.stringify(record),
          "integrations",
        );
        enableMcpOnBot(bot, name);
        return {
          kind: "connected",
          status: "approved",
          connectionId: `${MCP_PREFIX}${name}`,
          message:
            probe.status === "connected"
              ? `Connected ${name} (${new URL(url).origin}).`
              : `Saved ${name}, but the check reported: ${probe.detail}`,
        } satisfies IntegrationFlow;
      }
      case "check": {
        const id = input.id ?? "";
        const checkedAt = now();
        const keySpec = keyMap.get(id);
        if (keySpec) return toKeyConnection(bot, keySpec, checkedAt);
        if (id.startsWith(MCP_PREFIX)) {
          const name = id.slice(MCP_PREFIX.length);
          const stored = readStoredMcp(bot.id, name);
          if (!stored) throw new NotFound("Custom MCP connection not found.");
          const probe = await probeMcp(stored.url, stored.token);
          const updated: StoredMcpServer = {
            ...stored,
            checkedAt,
            lastStatus: probe.status,
            lastDetail: probe.detail,
          };
          store.secrets.setSecret(
            scope,
            `${MCP_PREFIX}${name}`,
            JSON.stringify(updated),
            "integrations",
          );
          return toMcpConnection(bot, updated);
        }
        if (id === "apple") return appleConnection(bot);
        throw new NotFound("Integration not found.");
      }
      case "connect": {
        const id = input.id ?? "";
        const keySpec = keyMap.get(id);
        if (keySpec) {
          const apiKey = input.fields?.api_key?.trim();
          if (!apiKey) throw new InvalidInput(`Enter a ${keySpec.name} API key.`);
          store.secrets.setSecret(scope, `${KEY_PREFIX}${keySpec.keyName}`, apiKey, "integrations");
          return {
            kind: "connected",
            status: "approved",
            connectionId: keySpec.id,
            message: `${keySpec.name} API key saved in ${bot.name}'s encrypted vault.`,
          } satisfies IntegrationFlow;
        }
        if (id.startsWith(MCP_PREFIX)) {
          const name = id.slice(MCP_PREFIX.length);
          const existing = readStoredMcp(bot.id, name);
          if (!existing) throw new NotFound("Custom MCP connection not found.");
          const url = input.fields?.url?.trim() ? validateMcpUrl(input.fields.url) : existing.url;
          const token = input.fields?.token?.trim() ? input.fields.token.trim() : existing.token;
          const probe = await probeMcp(url, token);
          const checkedAt = now();
          const updated: StoredMcpServer = {
            ...existing,
            url,
            ...(token ? { token, auth: "bearer" as const } : {}),
            checkedAt,
            lastStatus: probe.status,
            lastDetail: probe.detail,
          };
          store.secrets.setSecret(
            scope,
            `${MCP_PREFIX}${name}`,
            JSON.stringify(updated),
            "integrations",
          );
          enableMcpOnBot(bot, name);
          return {
            kind: "connected",
            status: "approved",
            connectionId: id,
            message:
              probe.status === "connected"
                ? `Reconnected ${name}.`
                : `Updated ${name}, but the check reported: ${probe.detail}`,
          } satisfies IntegrationFlow;
        }
        throw new NotFound("Integration not found.");
      }
      case "disconnect": {
        const id = input.id ?? "";
        const keySpec = keyMap.get(id);
        if (keySpec) {
          store.secrets.deleteSecret(scope, `${KEY_PREFIX}${keySpec.keyName}`);
          return toKeyConnection(bot, keySpec, now());
        }
        if (id.startsWith(MCP_PREFIX)) {
          const name = id.slice(MCP_PREFIX.length);
          store.secrets.deleteSecret(scope, `${MCP_PREFIX}${name}`);
          disableMcpOnBot(bot, name);
          return { ok: true };
        }
        throw new NotFound("Integration not found.");
      }
      case "flow":
      case "cancel":
      case "callback":
        return {
          kind: "instructions",
          status: "expired",
          message: "No active browser sign-in flow was found for this assistant.",
        } satisfies IntegrationFlow;
    }
  }

  async function settleConnectionRequest(
    _input: ConnectionRequestSettle,
  ): Promise<ConnectionRequestResult> {
    return { status: "expired" };
  }

  function mcpServersForBot(botId: string): HarnessMcpServerSpec[] {
    return listStoredMcp(botId).map((server) => ({
      name: server.name,
      transport: "http",
      url: server.url,
      ...(server.auth === "bearer" && server.token
        ? { headers: { Authorization: `Bearer ${server.token}` } }
        : {}),
    }));
  }

  function envForBot(botId: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const spec of KEY_CONNECTORS) {
      const value = readBotKeySecret(botId, spec.keyName);
      if (value?.trim()) result[spec.envVar] = value.trim();
    }
    return result;
  }

  return { handle, settleConnectionRequest, mcpServersForBot, envForBot };
}
