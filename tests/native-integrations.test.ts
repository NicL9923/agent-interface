import { afterEach, describe, expect, it, vi } from "vitest";
import { Conflict, InvalidInput, NotFound } from "../src/shared/errors.js";
import type { ManagedBotRecord } from "../src/shared/harness.js";
import type {
  IntegrationCatalog,
  IntegrationConnection,
  IntegrationFlow,
} from "../src/shared/integrations.js";
import {
  createNativeIntegrationsHandler,
  type McpProbeResult,
} from "../src/server/harness/native-integrations.js";
import { Store } from "../src/server/store.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup(options: { env?: NodeJS.ProcessEnv } = {}) {
  const store = new Store(":memory:");
  store.managedBots.upsertCredential({
    id: "cred-1",
    label: "Test key",
    kind: "api_key",
    vendor: "openai",
    envVar: "OPENAI_API_KEY",
    allowedHarnesses: ["codex"],
  });
  const mkBot = (id: string, name: string): ManagedBotRecord => ({
    id,
    name,
    description: "",
    instructions: "",
    harness: "codex",
    model: "model-1",
    provider: "openai",
    reasoning: "",
    speed: "",
    ownerId: "one",
    ownerOsUser: "alice",
    shared: true,
    credentialId: "cred-1",
    enabledTools: [],
    enabledSkills: [],
    enabledMcpServers: ["wildbots"],
    createdAt: 1_790_000_000_000,
    updatedAt: 1_790_000_000_000,
  });
  store.managedBots.upsertManagedBot(mkBot("alpha", "Alpha"));
  store.managedBots.upsertManagedBot(mkBot("beta", "Beta"));
  const requireBot = (id: string) => {
    const bot = store.managedBots.getManagedBot(id);
    if (!bot || bot.archivedAt != null) throw new NotFound("Assistant not found.");
    return bot;
  };
  const probeMcp = vi.fn(
    async (_url: string, _token: string | undefined): Promise<McpProbeResult> => ({
      status: "connected",
      detail: "Reachable at https://mcp.example.test.",
    }),
  );
  const handler = createNativeIntegrationsHandler({
    store,
    requireBot,
    env: options.env ?? { OPENAI_API_KEY: "host-openai-key" },
    probeMcp,
    now: () => "2026-11-25T20:00:00.000Z",
  });
  cleanups.push(() => store.close());
  return { store, handler, probeMcp };
}

describe("native integrations and custom MCP manager", () => {
  it("lists env-configured and vault-stored API keys without exposing secrets, and isolates per bot", async () => {
    const { store, handler } = setup();
    const initial = (await handler.handle({
      operation: "list",
      profile: "alpha",
    })) as IntegrationCatalog;
    expect(initial.profile).toBe("alpha");
    const openai = initial.connections.find((c) => c.id === "key:openai");
    const brave = initial.connections.find((c) => c.id === "key:brave");
    expect(openai).toMatchObject({
      status: "connected",
      owner: "Host environment",
      actions: { disconnect: false },
    });
    expect(brave).toMatchObject({
      status: "not_connected",
      actions: { connect: true, disconnect: false },
    });

    const secretKey = "brave-secret-token-canary";
    const connected = (await handler.handle({
      operation: "connect",
      profile: "alpha",
      id: "key:brave",
      fields: { api_key: secretKey },
    })) as IntegrationFlow;
    expect(connected).toMatchObject({
      kind: "connected",
      status: "approved",
      connectionId: "key:brave",
    });

    // Alpha sees Brave connected and gets BRAVE_API_KEY in envForBot; Beta does not.
    const afterAlpha = (await handler.handle({
      operation: "list",
      profile: "alpha",
    })) as IntegrationCatalog;
    expect(afterAlpha.connections.find((c) => c.id === "key:brave")).toMatchObject({
      status: "connected",
      owner: "WildBots vault",
      actions: { disconnect: true },
    });
    expect(JSON.stringify(afterAlpha)).not.toContain(secretKey);
    expect(handler.envForBot("alpha")).toEqual({ BRAVE_API_KEY: secretKey });
    expect(handler.envForBot("beta")).toEqual({});

    // Internal integration_key:* secrets are hidden from model-accessible listSecrets/getSecret.
    expect(await store.secrets.listSecrets({ botId: "alpha", shared: true })).not.toContain(
      "integration_key:brave",
    );
    expect(
      await store.secrets.getSecret({ botId: "alpha", shared: true }, "integration_key:brave"),
    ).toBeUndefined();

    // Disconnecting removes the stored secret.
    const disconnected = (await handler.handle({
      operation: "disconnect",
      profile: "alpha",
      id: "key:brave",
    })) as IntegrationConnection;
    expect(disconnected.status).toBe("not_connected");
    expect(handler.envForBot("alpha")).toEqual({});
  });

  it("adds, checks, attaches, and removes custom HTTP MCP servers with encrypted bearer tokens", async () => {
    const { store, handler, probeMcp } = setup();
    const bearerToken = "mcp-bearer-secret-canary-99";
    const flow = (await handler.handle({
      operation: "add_mcp",
      profile: "alpha",
      mcp: {
        name: "linear",
        url: "https://mcp.example.test/linear",
        auth: "bearer",
        token: bearerToken,
      },
    })) as IntegrationFlow;
    expect(flow).toMatchObject({
      kind: "connected",
      status: "approved",
      connectionId: "mcp:linear",
    });
    expect(probeMcp).toHaveBeenCalledWith("https://mcp.example.test/linear", bearerToken);

    // Automatically enabled on the bot and returned by mcpServersForBot.
    expect(store.managedBots.getManagedBot("alpha")?.enabledMcpServers).toContain("linear");
    expect(handler.mcpServersForBot("alpha")).toEqual([
      {
        name: "linear",
        transport: "http",
        url: "https://mcp.example.test/linear",
        headers: { Authorization: `Bearer ${bearerToken}` },
      },
    ]);
    expect(handler.mcpServersForBot("beta")).toEqual([]);

    // Catalog lists it without ever leaking the bearer token.
    const catalog = (await handler.handle({
      operation: "list",
      profile: "alpha",
    })) as IntegrationCatalog;
    const item = catalog.connections.find((c) => c.id === "mcp:linear");
    expect(item).toMatchObject({
      id: "mcp:linear",
      name: "linear",
      category: "custom",
      status: "connected",
      account: "https://mcp.example.test",
    });
    expect(JSON.stringify(catalog)).not.toContain(bearerToken);

    // Model secret_list/secret_get cannot read mcp:linear directly, and redactForBot redacts the bearer token.
    expect(
      await store.secrets.getSecret({ botId: "alpha", shared: true }, "mcp:linear"),
    ).toBeUndefined();
    expect(store.secrets.redactForBot("alpha", `Auth: ${bearerToken}`)).toBe("Auth: [REDACTED]");

    // Check refreshes probe status.
    probeMcp.mockResolvedValueOnce({ status: "unavailable", detail: "HTTP 503" });
    const checked = (await handler.handle({
      operation: "check",
      profile: "alpha",
      id: "mcp:linear",
    })) as IntegrationConnection;
    expect(checked).toMatchObject({ status: "unavailable", detail: "HTTP 503" });

    // Disconnect deletes the server and removes it from enabledMcpServers.
    expect(
      await handler.handle({ operation: "disconnect", profile: "alpha", id: "mcp:linear" }),
    ).toEqual({ ok: true });
    expect(handler.mcpServersForBot("alpha")).toEqual([]);
    expect(store.managedBots.getManagedBot("alpha")?.enabledMcpServers).not.toContain("linear");
  });

  it("refuses reserved MCP names, cloud metadata URLs, embedded URL credentials, oauth, and missing bearer tokens", async () => {
    const { handler } = setup();
    await expect(
      handler.handle({
        operation: "add_mcp",
        profile: "alpha",
        mcp: { name: "wildbots", url: "https://mcp.example.test", auth: "none" },
      }),
    ).rejects.toThrow(InvalidInput);

    for (const badUrl of [
      "file:///etc/passwd",
      "https://user:pass@mcp.example.test/mcp",
      "http://169.254.169.254/latest/meta-data",
      "http://metadata.google.internal/computeMetadata/v1/",
    ]) {
      await expect(
        handler.handle({
          operation: "add_mcp",
          profile: "alpha",
          mcp: { name: "bad", url: badUrl, auth: "none" },
        }),
      ).rejects.toThrow(InvalidInput);
    }

    await expect(
      handler.handle({
        operation: "add_mcp",
        profile: "alpha",
        mcp: { name: "oauthsrv", url: "https://mcp.example.test", auth: "oauth" },
      }),
    ).rejects.toThrow(Conflict);

    await expect(
      handler.handle({
        operation: "add_mcp",
        profile: "alpha",
        mcp: { name: "notok", url: "https://mcp.example.test", auth: "bearer", token: "   " },
      }),
    ).rejects.toThrow(InvalidInput);

    await expect(
      handler.handle({ operation: "check", profile: "alpha", id: "mcp:missing" }),
    ).rejects.toThrow(NotFound);

    expect(
      await handler.settleConnectionRequest({
        decision: "decline",
        profile: "alpha",
        requestId: "req-1",
        epoch: "e1",
        sessionId: "s1",
        connection: "key:brave",
      }),
    ).toEqual({ status: "expired" });
  });
});
