import type { HarnessOption, RealtimeSessionInput, Runtime } from "../shared/types.js";
import type { ManagedBotRecord } from "../shared/harness.js";
import { isGrokTalkVoice } from "../shared/voice.js";
import type { Config } from "./config.js";
import { createDirectVoiceService, createGrokVoiceService } from "./direct-voice.js";
import type { FileSigner } from "./file-signer.js";
import type { HarnessDriver, HarnessDriverId, HarnessMcpServerSpec } from "./harness/driver.js";
import { createDefaultHarnessDrivers, type HarnessVoiceDelegate } from "./harness/index.js";
import { createNativeComputerService } from "./harness/native-computer.js";
import { createServerHarnessRuntime } from "./harness/wiring.js";
import { createComputerMcpTools } from "./mcp/computer-tools.js";
import { createConfirmationMcpTools } from "./mcp/confirmation-tools.js";
import { createMacMcpTools, type MacLinkRelay } from "./mcp/mac-tools.js";
import { createTaskMcpTools } from "./mcp/task-tools.js";
import { createVaultMcpTools } from "./mcp/vault-tools.js";
import { createWildbotsMcpServer, type McpToolProvider } from "./mcp/wildbots-mcp.js";
import { createMemoryMcpTools } from "./memory-learning.js";
import type { MemorySkillsRepository } from "./store-memory.js";
import type { Store } from "./store.js";

type WildbotsMcp = Awaited<ReturnType<typeof createWildbotsMcpServer>>;

/** The server's native runtime and what `createApp` and `index.ts` need beside it. */
export interface ServerRuntime {
  runtime: Runtime;
  /** For `/api/bootstrap`'s `harnesses`. */
  probeHarnesses: () => Promise<HarnessOption[]>;
  /** Hands the app's Mac link broker to the Mac tools, which the MCP server needed before the app existed. */
  attachMacs(relay: MacLinkRelay): void;
  /** Running queue rows nothing recovered at startup, for the start-up log. */
  sweptQueueItems: number;
  /** Closes the WildBots MCP server. The runtime closes with the app. */
  close(): Promise<void>;
}

/** The memory and skill tools, as the WildBots MCP server's provider for the calling session's bot. */
export function memoryToolProvider(
  memory: MemorySkillsRepository,
  ownerPersonalBots?: (ownerId: string) => string[],
): McpToolProvider {
  const tools = new Map(createMemoryMcpTools(memory).map((tool) => [tool.name, tool]));
  const definitions = [...tools.values()].map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
  const sharedReadDef = {
    name: "shared_memory_read",
    description:
      "Read active personal facts shared across your owner's other personal assistants (unavailable to shared household assistants).",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  };
  return {
    listTools: (ctx) =>
      ownerPersonalBots && ctx.shared === false && ctx.ownerId
        ? [...definitions, sharedReadDef]
        : definitions,
    callTool: (ctx, name, args) => {
      if (name === "shared_memory_read") {
        if (!ownerPersonalBots || ctx.shared !== false || !ctx.ownerId)
          return {
            content: [
              {
                type: "text",
                text: "Shared personal memory is only available to personal assistants.",
              },
            ],
            isError: true,
          };
        const text = memory.renderSharedOwnerMemoryMarkdown(
          ctx.ownerId,
          ctx.botId,
          ownerPersonalBots(ctx.ownerId),
        );
        return { content: [{ type: "text", text: text || "_No shared personal facts yet._" }] };
      }
      const tool = tools.get(name);
      if (!tool)
        return { content: [{ type: "text", text: "Unknown memory tool." }], isError: true };
      return tool.handler(args, { botId: ctx.botId });
    },
  };
}

/**
 * The WildBots MCP server for one bot. Exposes a stable logical fingerprint so warm harness
 * sessions are reused across turns; a bearer-token MCP session is minted only when a harness
 * session is actually opened, and revoked when that session is disposed.
 */
function wildbotsServer(mcp: WildbotsMcp, bot: ManagedBotRecord): HarnessMcpServerSpec {
  const ownerId = bot.ownerId || undefined;
  return {
    name: "wildbots",
    transport: "http",
    fingerprint: JSON.stringify({
      name: "wildbots",
      transport: "http",
      botId: bot.id,
      ownerId,
      shared: bot.shared,
    }),
    open: ({ sessionKey }) =>
      mcp.createSessionSpec({
        botId: bot.id,
        ownerId,
        shared: bot.shared,
        sessionKey,
      }),
  };
}

/**
 * Composes the native WildBots runtime: `HarnessRuntime` with the WildBots MCP server (memory, skills,
 * secrets, Mac tools) and direct OpenAI / xAI Grok voice services.
 */
export async function composeServerRuntime({
  config,
  store,
  files,
  drivers = createDefaultHarnessDrivers(),
}: {
  config: Pick<Config, "nativeHarness" | "computerDesktop">;
  store: Store;
  files: FileSigner;
  drivers?: Partial<Record<HarnessDriverId, HarnessDriver>>;
}): Promise<ServerRuntime> {
  if (!config.nativeHarness)
    throw new Error("WILDBOTS_WORKSPACE_ROOT is required when running with an in-memory database.");
  let macs: MacLinkRelay | undefined;
  const relay: MacLinkRelay = {
    invoke: async (request) => {
      if (!macs) throw new Error("Mac links are not ready yet.");
      return macs.invoke(request);
    },
  };
  const computer = createNativeComputerService(config.computerDesktop);
  let deliverMessage:
    | ((input: { sourceBotId: string; targetBotId: string; message: string }) => Promise<void>)
    | undefined;
  const ownerPersonalBots = (ownerId: string) =>
    store.managedBots
      .listManagedBots()
      .filter((row) => row.archivedAt == null && row.shared === false && row.ownerId === ownerId)
      .map((row) => row.id);
  const extraToolProviders: McpToolProvider[] = [
    memoryToolProvider(store.memory, ownerPersonalBots),
    createTaskMcpTools(store.tasks),
    createConfirmationMcpTools(store.confirmations),
    createMacMcpTools({ store, relay }),
    createVaultMcpTools({
      secrets: store.secrets,
      browserBridge: computer.enabled ? computer.browserBridge : undefined,
    }),
    ...(computer.enabled ? [createComputerMcpTools({ backend: computer.backend })] : []),
  ];
  const mcp = await createWildbotsMcpServer({
    store,
    secrets: store.secrets,
    onMessageBot: async ({ source, targetBotId, message }) => {
      if (!deliverMessage) throw new Error("Assistant messaging is not ready yet.");
      await deliverMessage({ sourceBotId: source.botId, targetBotId, message });
    },
    extraToolProviders,
  });
  try {
    const directVoice = createDirectVoiceService();
    const grokVoice = createGrokVoiceService();
    const openAiDirect = directVoice.status().available;
    const grokAvailable = grokVoice.status().available;
    const mintRealtime = (input: RealtimeSessionInput) => {
      if (isGrokTalkVoice(input.voice)) return grokVoice.realtimeSession(input);
      return directVoice.realtimeSession(input);
    };
    const voice: HarnessVoiceDelegate = {
      liveVoice: async () =>
        openAiDirect || grokAvailable
          ? { supported: true }
          : { supported: false, reason: "Configure OPENAI_API_KEY or XAI_API_KEY for live voice." },
      ...(openAiDirect || grokAvailable ? { realtimeSession: mintRealtime } : {}),
      ...(openAiDirect
        ? {
            transcribeVoice: (botId, input) => directVoice.transcribeVoice(botId, input),
            synthesizeVoice: (botId, text, chosen) =>
              directVoice.synthesizeVoice(botId, text, chosen),
          }
        : {}),
    };
    const server = createServerHarnessRuntime({
      store,
      drivers,
      workspaceRoot: config.nativeHarness.workspaceRoot,
      files,
      defaultMcpServers: (bot) => [wildbotsServer(mcp, bot)],
      startScheduler: true,
      fallback: config.nativeHarness.fallback,
      voice,
      computer,
    });
    deliverMessage = server.harnessRuntime.deliverBotMessage;
    return {
      runtime: server.runtime,
      probeHarnesses: server.probeHarnesses,
      attachMacs: (broker) => {
        macs = broker;
      },
      sweptQueueItems: server.sweptQueueItems,
      close: async () => {
        await Promise.allSettled([computer.close(), mcp.close()]);
      },
    };
  } catch (error) {
    await Promise.allSettled([computer.close(), mcp.close()]);
    throw error;
  }
}
