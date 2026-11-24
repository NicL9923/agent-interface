import type { HarnessOption, Runtime } from "../shared/types.js";
import type { ManagedBotRecord } from "../shared/harness.js";
import type { Config } from "./config.js";
import type { HarnessDriver, HarnessDriverId, HarnessMcpServerSpec } from "./harness/driver.js";
import { createDefaultHarnessDrivers } from "./harness/index.js";
import { createCompositeRuntime, hermesOnlyForNew } from "./harness/wiring.js";
import type { FileSigner } from "./hermes-files.js";
import { createMacMcpTools, type MacLinkRelay } from "./mcp/mac-tools.js";
import { createWildbotsMcpServer, type McpToolProvider } from "./mcp/wildbots-mcp.js";
import { createMemoryMcpTools } from "./memory-learning.js";
import { createRuntimeRouter, hermesRuntimeId } from "./runtime-router.js";
import type { MemorySkillsRepository } from "./store-memory.js";
import type { Store } from "./store.js";

type WildbotsMcp = Awaited<ReturnType<typeof createWildbotsMcpServer>>;

/** The server's runtime and what `createApp` and `index.ts` need from the native harnesses beside it. */
export interface ServerRuntime {
  runtime: Runtime;
  /** For `/api/bootstrap`'s `harnesses`. Absent while native harnesses are off. */
  probeHarnesses?: () => Promise<HarnessOption[]>;
  /** Hands the app's Mac link broker to the Mac tools, which the MCP server needed before the app existed. */
  attachMacs(relay: MacLinkRelay): void;
  /** Running queue rows nothing recovered at startup, for the start-up log. */
  sweptQueueItems: number;
  /** Closes the WildBots MCP server. The runtime closes with the app. */
  close(): Promise<void>;
}

/** The memory and skill tools, as the WildBots MCP server's provider for the calling session's bot. */
export function memoryToolProvider(memory: MemorySkillsRepository): McpToolProvider {
  const tools = new Map(createMemoryMcpTools(memory).map((tool) => [tool.name, tool]));
  const definitions = [...tools.values()].map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
  return {
    listTools: () => definitions,
    callTool: (ctx, name, args) => {
      const tool = tools.get(name);
      if (!tool)
        return { content: [{ type: "text", text: "Unknown memory tool." }], isError: true };
      return tool.handler(args, { botId: ctx.botId });
    },
  };
}

/**
 * The WildBots MCP server for one bot. The runtime asks for the list on every roster detail read and needs only
 * its names, so a session, and its bearer token, is minted only when a harness first reads the address or headers.
 */
function wildbotsServer(mcp: WildbotsMcp, bot: ManagedBotRecord): HarnessMcpServerSpec {
  let minted: HarnessMcpServerSpec | undefined;
  const mint = () =>
    (minted ??= mcp.createSessionSpec({
      botId: bot.id,
      ownerId: bot.ownerId || undefined,
      shared: bot.shared,
    }).spec);
  return {
    name: "wildbots",
    transport: "http",
    get url() {
      return mint().url;
    },
    get headers() {
      return mint().headers;
    },
  };
}

/**
 * Composes the runtime the server runs on. Hermes stays the default. With native harnesses on
 * (`config.nativeHarness`), assistants created on a native harness run on `HarnessRuntime`, which attaches the
 * WildBots MCP server with the memory and Mac tools to each turn. With them off, a new assistant that asks for one
 * is refused instead of becoming a Hermes profile.
 */
export async function composeServerRuntime({
  config,
  store,
  hermes,
  files,
  drivers = createDefaultHarnessDrivers(),
}: {
  config: Pick<Config, "nativeHarness">;
  store: Store;
  hermes: Runtime;
  files: FileSigner;
  drivers?: Partial<Record<HarnessDriverId, HarnessDriver>>;
}): Promise<ServerRuntime> {
  if (!config.nativeHarness)
    return {
      runtime: createRuntimeRouter({
        runtimes: { [hermesRuntimeId]: hermes },
        defaultRuntime: hermesRuntimeId,
        runtimeForNew: hermesOnlyForNew,
      }),
      attachMacs: () => {},
      sweptQueueItems: 0,
      close: async () => {},
    };
  let macs: MacLinkRelay | undefined;
  const relay: MacLinkRelay = {
    invoke: async (request) => {
      if (!macs) throw new Error("Mac links are not ready yet.");
      return macs.invoke(request);
    },
  };
  const mcp = await createWildbotsMcpServer({
    store,
    secrets: store.secrets,
    extraToolProviders: [memoryToolProvider(store.memory), createMacMcpTools({ store, relay })],
  });
  try {
    const composite = createCompositeRuntime({
      store,
      hermes,
      drivers,
      workspaceRoot: config.nativeHarness.workspaceRoot,
      files,
      defaultMcpServers: (bot) => [wildbotsServer(mcp, bot)],
      startScheduler: true,
    });
    return {
      runtime: composite.runtime,
      probeHarnesses: composite.probeHarnesses,
      attachMacs: (broker) => {
        macs = broker;
      },
      sweptQueueItems: composite.sweptQueueItems,
      close: () => mcp.close(),
    };
  } catch (error) {
    await mcp.close();
    throw error;
  }
}
