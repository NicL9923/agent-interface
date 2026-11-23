import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertBotHandoffAllowed } from "../src/server/credential-policy.js";
import { fileSigner } from "../src/server/hermes-files.js";
import {
  createWildbotsMcpServer,
  type McpToolResult,
  type SecretInputOutcome,
  type SecretInputRequest,
  type WildbotsMcpOptions,
} from "../src/server/mcp/wildbots-mcp.js";
import { redactSecrets, SecretRepository, type SecretScope } from "../src/server/store-secrets.js";
import { Store } from "../src/server/store.js";
import type { ManagedBotRecord } from "../src/shared/harness.js";
import type { FileRef } from "../src/shared/types.js";

const personal = { botId: "personal", ownerId: "alice", shared: false };
const shared = { botId: "shared", ownerId: "alice", shared: true };
const other = { botId: "other", ownerId: "bob", shared: false };
const botScope = (id: string): SecretScope => ({ kind: "bot", id });
const ownerScope = (id: string): SecretScope => ({ kind: "owner", id });
const household: SecretScope = { kind: "household", id: "" };

type Server = Awaited<ReturnType<typeof createWildbotsMcpServer>>;
type Session = ReturnType<Server["createSessionSpec"]>;
type RpcReply<T> = {
  jsonrpc: string;
  id: number;
  result: T;
  error?: { code: number; message: string };
};

let directory: string;
let store: Store;
let server: Server | undefined;
let secrets: SecretRepository;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function register(bot: typeof personal, configuration: Partial<ManagedBotRecord> = {}) {
  return store.managedBots.upsertManagedBot({
    id: bot.botId,
    name: bot.botId,
    description: "",
    instructions: "",
    harness: "hermes",
    model: "",
    provider: "",
    reasoning: "",
    speed: "",
    ownerId: bot.ownerId,
    ownerOsUser: "wildbots",
    shared: bot.shared,
    credentialId: null,
    enabledTools: [],
    enabledSkills: [],
    enabledMcpServers: [],
    ...configuration,
  });
}

beforeEach(async () => {
  vi.stubEnv("WILDBOTS_VAULT_KEY", undefined);
  directory = await mkdtemp(join(tmpdir(), "wildbots-mcp-"));
  store = new Store(join(directory, "app.sqlite"));
  secrets = new SecretRepository(store);
  for (const bot of [personal, shared, other]) register(bot);
});

afterEach(async () => {
  try {
    await server?.close();
  } finally {
    server = undefined;
    store.close();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.useRealTimers();
  }
});

async function listen(options: Partial<WildbotsMcpOptions> = {}) {
  return (server = await createWildbotsMcpServer({ store, secrets, ...options }));
}

function send(
  session: Session,
  body: unknown,
  headers: Record<string, string> = {},
  authorization = session.spec.headers?.Authorization,
) {
  return fetch(session.spec.url!, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(authorization && { Authorization: authorization }),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function rpc(method: string, params?: unknown, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

async function connect(session: Session) {
  const result = await send(
    session,
    rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    }),
  );
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "wildbots" },
    },
  });
  const ready = await send(
    session,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    {
      "MCP-Protocol-Version": "2025-06-18",
    },
  );
  expect(ready.status).toBe(202);
  expect(await ready.text()).toBe("");
  return session;
}

async function call(session: Session, name: string, args?: Record<string, unknown>) {
  const response = await send(session, rpc("tools/call", { name, arguments: args }));
  expect(response.status).toBe(200);
  return (await response.json()) as RpcReply<McpToolResult>;
}

describe("WildBots loopback MCP", () => {
  it("rejects missing, malformed, incorrect, expired, and revoked session tokens", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const mcp = await listen({ sessionTtlMs: 60_000 });
    const session = mcp.createSessionSpec(personal);
    const authorization = session.spec.headers!.Authorization;
    const incorrect = authorization.slice(0, -1) + (authorization.endsWith("A") ? "B" : "A");
    expect(new URL(session.spec.url!).hostname).toBe("127.0.0.1");
    for (const token of ["", "Bearer malformed", incorrect]) {
      const response = await send(session, rpc("ping"), {}, token);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
    }
    expect((await send(session, rpc("ping"))).status).toBe(200);
    session.revoke();
    expect((await send(session, rpc("ping"))).status).toBe(401);

    const expiring = mcp.createSessionSpec(personal);
    vi.setSystemTime(Date.now() + 59_999);
    expect((await send(expiring, rpc("ping"))).status).toBe(200);
    vi.setSystemTime(Date.now() + 1);
    expect((await send(expiring, rpc("ping"))).status).toBe(401);
  });

  it("validates the request envelope, origin, and protocol version on the loopback endpoint", async () => {
    const session = (await listen()).createSessionSpec(shared);
    expect((await send(session, rpc("ping"), { Origin: "https://untrusted.example" })).status).toBe(
      403,
    );
    const get = await fetch(session.spec.url!, { headers: session.spec.headers });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const wrongType = await send(session, rpc("ping"), { "Content-Type": "text/plain" });
    expect(wrongType.status).toBe(415);
    const oversized = await send(session, " ".repeat(65_537));
    expect(oversized.status).toBe(413);
    const malformed = await send(session, "{");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ id: null, error: { code: -32700 } });
    const batch = await send(session, [rpc("ping")]);
    expect(batch.status).toBe(400);
    expect(await batch.json()).toMatchObject({ id: null, error: { code: -32600 } });
    expect(await (await send(session, rpc("tools/list"))).json()).toMatchObject({
      error: { message: "MCP session is not initialized" },
    });
    await connect(session);
    const badProtocol = await send(session, rpc("ping"), { "MCP-Protocol-Version": "2024-11-05" });
    expect(badProtocol.status).toBe(400);
    expect(await badProtocol.json()).toMatchObject({
      error: { message: "Unsupported MCP protocol version" },
    });
    expect(
      await (await send(session, rpc("tools/call", { name: "secret_list", arguments: [] }))).json(),
    ).toMatchObject({ error: { message: "Invalid tool call parameters" } });
  });

  it("lists and calls only enabled tools with the server-owned chat session context", async () => {
    const mcp = await listen({
      extraToolProviders: [
        {
          listTools: (ctx) =>
            ctx.shared
              ? []
              : [
                  {
                    name: "private_extension",
                    description: "Example extension",
                    inputSchema: { type: "object" },
                  },
                ],
          callTool(ctx, name, args) {
            if (name !== "private_extension") throw new Error("Unexpected call");
            return {
              content: [],
              structuredContent: { args, sessionKey: ctx.sessionKey, botId: ctx.botId },
            };
          },
        },
      ],
    });
    const allowedTools = ["chat_search", "private_extension"];
    const session = await connect(
      mcp.createSessionSpec({ ...personal, sessionKey: "session-a", allowedTools }),
    );
    allowedTools.push("secret_get");
    const list = await send(session, rpc("tools/list"));
    const { result } = (await list.json()) as RpcReply<{ tools: { name: string }[] }>;
    expect(result.tools.map(({ name }) => name)).toEqual(["chat_search", "private_extension"]);
    expect((await call(session, "secret_get", { name: "anything" })).error).toMatchObject({
      message: "Tool not available",
    });
    expect(
      (await call(session, "private_extension", { botId: other.botId })).result.structuredContent,
    ).toEqual({ args: { botId: other.botId }, botId: personal.botId, sessionKey: "session-a" });
    const sharedSession = await connect(mcp.createSessionSpec(shared));
    expect((await call(sharedSession, "private_extension")).error).toMatchObject({
      message: "Tool not available",
    });
  });

  it("cancels an extension call without revoking its session", async () => {
    const started = deferred<AbortSignal>();
    const finished = deferred<McpToolResult>();
    const session = await connect(
      (
        await listen({
          extraToolProviders: [
            {
              listTools: () => [
                { name: "wait", description: "Wait", inputSchema: { type: "object" } },
              ],
              callTool(_ctx, _name, _args, signal) {
                started.resolve(signal);
                return finished.promise;
              },
            },
          ],
        })
      ).createSessionSpec(personal),
    );
    const pending = send(session, rpc("tools/call", { name: "wait" }, 10));
    const signal = await started.promise;
    try {
      const cancel = await send(session, {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 10 },
      });
      expect(cancel.status).toBe(202);
      expect((await pending).status).toBe(202);
      expect(signal.aborted).toBe(true);
      expect((await send(session, rpc("ping"))).status).toBe(200);
    } finally {
      finished.resolve({ content: [] });
    }
  });

  it("stops serving an existing session after its bot is shared or changes owner", async () => {
    const mcp = await listen();
    const session = await connect(mcp.createSessionSpec(personal));
    const otherSession = await connect(mcp.createSessionSpec(other));
    register({ ...personal, shared: true });
    register({ ...other, ownerId: "charlie" });
    expect((await send(session, rpc("tools/list"))).status).toBe(401);
    expect((await send(otherSession, rpc("tools/list"))).status).toBe(401);
    expect(() => mcp.createSessionSpec(personal)).toThrow("session is no longer available");
  });

  it("searches only the session bot's transcript and redacts a matching secret", async () => {
    const value = "orchard-credential";
    const session = await connect((await listen()).createSessionSpec(personal));
    secrets.setSecret(ownerScope("alice"), "orchard_key", value, "alice");
    store.transcripts.appendMessages(
      personal.botId,
      [{ id: "mine", role: "assistant", text: "orchard details with " + value }],
      "harness",
    );
    store.transcripts.appendMessages(
      other.botId,
      [{ id: "theirs", role: "assistant", text: "orchard details with the other owner's note" }],
      "harness",
    );

    const { result } = await call(session, "chat_search", {
      query: "orchard",
      botId: other.botId,
      limit: 10,
    });
    expect(result.structuredContent).toMatchObject({
      hits: [
        { botId: personal.botId, messageId: "mine", snippet: "orchard details with [REDACTED]" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(value);
    const badLimit = await call(session, "chat_search", { query: "orchard", limit: 0 });
    expect(badLimit.result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Choose a search limit from 1 to 50." }],
    });
  });
});

describe("WildBots mini-vault", () => {
  it("stores AES-GCM ciphertext with a persistent local key and authenticates scope, name, and data", async () => {
    const value = "synthetic.*credential";
    const scope = botScope(personal.botId);
    const first = secrets.setSecret(scope, "key", value, "alice");
    const query = "SELECT ciphertext,iv,tag FROM bot_secrets WHERE name='key'";
    const initial = store.db.prepare(query).get() as {
      ciphertext: Uint8Array;
      iv: Uint8Array;
      tag: Uint8Array;
    };
    expect(Buffer.from(initial.ciphertext).toString()).not.toContain(value);
    expect(initial.iv.byteLength).toBe(12);
    expect(initial.tag.byteLength).toBe(16);
    expect((await stat(join(directory, "app.sqlite"))).mode & 0o777).toBe(0o600);

    const second = secrets.setSecret(scope, "key", value, "bob");
    const updated = store.db.prepare(query).get() as typeof initial;
    expect(updated.iv).not.toEqual(initial.iv);
    expect(updated.ciphertext).not.toEqual(initial.ciphertext);
    expect(second).toMatchObject({ id: first.id, createdBy: "alice", createdAt: first.createdAt });
    store.close();
    store = new Store(join(directory, "app.sqlite"));
    const reopened = new SecretRepository(store);
    expect(await reopened.getSecret(personal, "key")).toBe(value);

    store.db.exec("UPDATE bot_secrets SET name='swapped' WHERE name='key'");
    await expect(reopened.getSecret(personal, "swapped")).rejects.toThrow();
    store.db.exec("UPDATE bot_secrets SET name='key',tag=zeroblob(16) WHERE name='swapped'");
    await expect(reopened.getSecret(personal, "key")).rejects.toThrow();
  });

  it("uses the configured key without saving it and detects a different key on restart", async () => {
    const explicitStore = new Store(":memory:");
    try {
      vi.stubEnv("WILDBOTS_VAULT_KEY", "synthetic-configured-key");
      new SecretRepository(explicitStore).setSecret(household, "key", "synthetic-api-key", "alice");
      expect(
        explicitStore.db.prepare("SELECT value FROM metadata WHERE key='wildbots_vault_key'").get(),
      ).toBeUndefined();
      expect(await new SecretRepository(explicitStore).getSecret(shared, "key")).toBe(
        "synthetic-api-key",
      );
      expect(() => new SecretRepository(explicitStore, { key: "different" })).toThrow(
        "differs from the vault's original key",
      );
      expect(() => new SecretRepository(explicitStore, { key: " " })).toThrow("must not be empty");
    } finally {
      explicitStore.close();
    }
  });

  it("returns names without values and denies both shared and wrong-owner reads", async () => {
    const mcp = await listen();
    secrets.setSecret(botScope(personal.botId), "bot_key", "synthetic-bot-value", "alice");
    secrets.setSecret(ownerScope("alice"), "personal key", "synthetic-alice-value", "alice");
    secrets.setSecret(household, "house_key", "synthetic-house-value", "alice");
    const local = await connect(mcp.createSessionSpec(personal));
    const forShared = await connect(mcp.createSessionSpec(shared));
    const forOther = await connect(mcp.createSessionSpec(other));

    const list = await call(local, "secret_list");
    expect(list.result.structuredContent).toEqual({
      names: ["bot_key", "house_key", "personal key"],
    });
    expect(JSON.stringify(list)).not.toContain("synthetic");
    expect(
      (await call(local, "secret_get", { name: "personal key" })).result.structuredContent,
    ).toEqual({ value: "synthetic-alice-value" });
    for (const session of [forOther, forShared]) {
      expect((await call(session, "secret_list")).result.structuredContent).toEqual({
        names: ["house_key"],
      });
      for (const name of ["personal key", "bot_key"]) {
        expect((await call(session, "secret_get", { name })).result).toMatchObject({
          isError: true,
          content: [{ type: "text", text: "Secret not found." }],
        });
      }
      expect(
        (await call(session, "secret_get", { name: "house_key" })).result.structuredContent,
      ).toEqual({ value: "synthetic-house-value" });
    }
    expect(
      redactSecrets("abcde synthetic.*credential++ synthetic.*credential", [
        "abcde",
        "synthetic.*credential",
        "synthetic.*credential++",
      ]),
    ).toBe("abcde [REDACTED] [REDACTED]");
    expect(secrets.redactForBot(personal.botId, "seen synthetic-alice-value")).toBe(
      "seen [REDACTED]",
    );
    const quoted = 'synthetic "key"';
    secrets.setSecret(botScope(personal.botId), "quoted", quoted, "alice");
    expect(secrets.redactForBot(personal.botId, JSON.stringify({ value: quoted }))).toBe(
      '{"value":"[REDACTED]"}',
    );
  });

  it("passes authorized scopes to Headnet Vault and falls back to a local household secret", async () => {
    const scopes: SecretScope[] = [];
    const repository = new SecretRepository(store, {
      headnetVault: {
        async getSecret(name, scope) {
          scopes.push(scope);
          return name === "remote" && scope.kind === "owner" && scope.id === "alice"
            ? "remote-value"
            : undefined;
        },
        async listSecrets(scope) {
          scopes.push(scope);
          return scope.kind === "owner" && scope.id === "alice" ? ["remote"] : [];
        },
      },
    });
    repository.setSecret(household, "local", "local-value", "alice");
    expect(await repository.getSecret(personal, "remote")).toBe("remote-value");
    expect(scopes.splice(0)).toEqual([botScope(personal.botId), ownerScope("alice")]);
    expect(await repository.getSecret(personal, "local")).toBe("local-value");
    expect(scopes.splice(0)).toEqual([botScope(personal.botId), ownerScope("alice")]);
    expect(await repository.listSecrets(personal)).toEqual(["local", "remote"]);
    expect(scopes.splice(0)).toEqual([botScope(personal.botId), ownerScope("alice"), household]);
    expect(await repository.getSecret(shared, "remote")).toBeUndefined();
    expect(scopes.splice(0)).toEqual([botScope(shared.botId), household]);
    expect(await repository.listSecrets(shared)).toEqual(["local"]);
    expect(scopes).toEqual([botScope(shared.botId), household]);
    expect(repository.redactForBot(personal.botId, "used remote-value")).toBe("used [REDACTED]");
  });
});

describe("WildBots MCP callbacks", () => {
  it("publishes a secure input request and returns only status after a person optionally saves it", async () => {
    const card = deferred<SecretInputRequest>();
    const answer = deferred<SecretInputOutcome>();
    const received = "synthetic-new-credential";
    const session = await connect(
      (
        await listen({
          async onSecretRequest(request) {
            if (request.name === "do not save") return { status: "submitted" };
            if (request.name === "cancel") return { status: "cancelled" };
            if (request.name === "failed") throw new Error(received);
            card.resolve(request);
            return answer.promise;
          },
        })
      ).createSessionSpec({ ...personal, sessionKey: "card-session" }),
    );
    const arguments_ = { name: "new key", prompt: "Enter the key for the test service." };
    const pending = call(session, "secret_request", arguments_);
    const request = await card.promise;
    try {
      expect(request).toMatchObject({
        ...arguments_,
        context: { ...personal, sessionKey: "card-session" },
      });
      expect(await secrets.getSecret(personal, "new key")).toBeUndefined();
    } finally {
      answer.resolve({ status: "submitted", save: { value: received, createdBy: "alice" } });
    }
    const { result } = await pending;
    expect(result.structuredContent).toEqual({ status: "submitted", saved: true });
    expect(JSON.stringify(result)).not.toContain(received);
    expect(await secrets.getSecret(personal, "new key")).toBe(received);
    expect(await secrets.getSecret(shared, "new key")).toBeUndefined();
    const unsaved = await call(session, "secret_request", { ...arguments_, name: "do not save" });
    expect(unsaved.result.structuredContent).toEqual({ status: "submitted", saved: false });
    expect(await secrets.getSecret(personal, "do not save")).toBeUndefined();
    const cancelled = await call(session, "secret_request", { ...arguments_, name: "cancel" });
    expect(cancelled.result.structuredContent).toEqual({ status: "cancelled" });
    const failed = await call(session, "secret_request", { ...arguments_, name: "failed" });
    expect(failed.result.content).toEqual([
      { type: "text", text: "The secure input request could not be completed." },
    ]);
  });

  it("withdraws a pending secure card on revocation and discards a late answer", async () => {
    const card = deferred<AbortSignal>();
    const answer = deferred<SecretInputOutcome>();
    const session = await connect(
      (
        await listen({
          async onSecretRequest(_request, signal) {
            card.resolve(signal);
            return answer.promise;
          },
        })
      ).createSessionSpec(personal),
    );
    const pending = send(
      session,
      rpc("tools/call", {
        name: "secret_request",
        arguments: {
          name: "late",
          prompt: "Enter the key.",
        },
      }),
    );
    const signal = await card.promise;
    session.revoke();
    try {
      expect((await pending).status).toBe(401);
      expect(signal.aborted).toBe(true);
    } finally {
      answer.resolve({
        status: "submitted",
        save: { value: "synthetic-revoked-value", createdBy: "alice" },
      });
    }
    expect(await secrets.getSecret(personal, "late")).toBeUndefined();
  });

  it("delivers visible handoffs and blocks other members' private subscription bots", async () => {
    const credential = (ownerId: string) =>
      store.managedBots.upsertCredential({
        id: ownerId,
        label: ownerId,
        vendor: "openai",
        kind: "subscription",
        ownerId,
        allowedHarnesses: ["codex"],
        osUser: "wildbots",
      });
    const aliceCredential = credential("alice");
    const bobCredential = credential("bob");
    register(
      { ...personal, botId: "target" },
      { harness: "codex", credentialId: aliceCredential.id },
    );
    const bobTarget = register(other, { harness: "codex", credentialId: bobCredential.id });
    secrets.setSecret(ownerScope("alice"), "key", "synthetic-handoff-value", "alice");
    const sent: { targetBotId: string; message: string }[] = [];
    const mcp = await listen({
      async onMessageBot({ targetBotId, message }) {
        sent.push({ targetBotId, message });
      },
    });
    const session = await connect(mcp.createSessionSpec(personal));
    const sharedSession = await connect(mcp.createSessionSpec(shared));
    expect(
      (
        await call(session, "message_bot", {
          botId: "target",
          message: "hello synthetic-handoff-value",
        })
      ).result.structuredContent,
    ).toEqual({ status: "sent" });
    expect(
      (await call(session, "message_bot", { botId: other.botId, message: "hello" })).result,
    ).toMatchObject({ isError: true, content: [{ type: "text", text: "Assistant not found." }] });
    expect(
      (await call(sharedSession, "message_bot", { botId: "target", message: "hello" })).result,
    ).toMatchObject({ isError: true, content: [{ type: "text", text: "Assistant not found." }] });
    expect(() => assertBotHandoffAllowed(bobTarget, bobCredential, "alice")).toThrow(
      "Use a bot with an API key credential for handoffs between members' bots.",
    );
    expect(() => assertBotHandoffAllowed(bobTarget, undefined, "bob")).toThrow(
      "This assistant's credential is unavailable.",
    );
    expect(sent).toEqual([{ targetBotId: "target", message: "hello [REDACTED]" }]);
  });

  it("writes and signs images from base64 and same-origin URLs without forwarding API credentials", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      "base64",
    );
    const webp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
    const imageRequests: unknown[] = [];
    const downloads: unknown[] = [];
    const provider = createServer((req, res) => {
      if (req.url === "/generated.webp") {
        downloads.push(req.headers.authorization);
        return res.end(webp);
      }
      if (req.url !== "/v1/images/generations" || req.method !== "POST") {
        res.statusCode = 404;
        return res.end();
      }
      const parts: Buffer[] = [];
      req.on("data", (part: Buffer) => parts.push(part));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(parts).toString());
        imageRequests.push({ authorization: req.headers.authorization, body });
        const image =
          body.prompt === "use URL"
            ? { url: "http://" + req.headers.host + "/generated.webp" }
            : body.prompt === "incorrect bytes"
              ? { b64_json: Buffer.from("this is not an image").toString("base64") }
              : { b64_json: png.toString("base64") };
        res.end(JSON.stringify({ data: [image] }));
      });
    });
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    try {
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("No provider address");
      const files = fileSigner(store.fileKeys(), undefined);
      const outputDir = join(directory, "generated");
      const mcp = await listen({
        imageGeneration: {
          files,
          outputDir,
          baseUrl: "http://127.0.0.1:" + address.port + "/v1",
          apiKey: "synthetic-image-key",
        },
      });
      const session = await connect(mcp.createSessionSpec(personal));
      for (const [prompt, mime, bytes] of [
        ["one red pixel", "image/png", png],
        ["use URL", "image/webp", webp],
      ] as const) {
        const response = await call(session, "image_generate", {
          prompt,
          size: "1024x1024",
          quality: "high",
        });
        const file = response.result.structuredContent?.file as FileRef;
        const registered = files.fileValue(file.id);
        expect(file).toMatchObject({ mime, size: bytes.length, url: "/api/files/" + file.id });
        expect(registered).toMatchObject({
          botId: personal.botId,
          kind: "artifact",
          mime,
          path: join(outputDir, file.name),
        });
        expect(await readFile(registered.path)).toEqual(bytes);
        expect((await stat(registered.path)).mode & 0o777).toBe(0o600);
      }
      expect(downloads).toEqual([undefined]);
      expect(imageRequests[0]).toMatchObject({
        authorization: "Bearer synthetic-image-key",
        body: { prompt: "one red pixel", size: "1024x1024", quality: "high", n: 1 },
      });
      expect(
        (await call(session, "image_generate", { prompt: "incorrect bytes" })).result,
      ).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "The image provider did not return a usable image." }],
      });
    } finally {
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  });
});
