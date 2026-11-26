import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { rawDataText } from "../src/server/raw-data-text.js";
import { InvalidInput } from "../src/shared/errors.js";
import type { ComputerAttachment, ComputerStatus } from "../src/shared/computer.js";
import {
  assertSafeBrowserUrl,
  createNativeComputerService,
  type BrowserPageBridge,
} from "../src/server/harness/native-computer.js";
import { createNativeVaultHandler } from "../src/server/harness/native-vault.js";
import { createComputerMcpTools, ComputerLeaseLock } from "../src/server/mcp/computer-tools.js";
import { createVaultMcpTools, generateTotpCode } from "../src/server/mcp/vault-tools.js";
import { Store } from "../src/server/store.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const botCtx = {
  botId: "alpha",
  ownerId: "one",
  shared: false,
  scheduled: false,
  sessionKey: "alpha-chat",
};

describe("native shared computer service and vault browser tools", () => {
  it("blocks local, RFC1918, and cloud metadata URLs from browser navigation", () => {
    expect(assertSafeBrowserUrl("https://example.com/login")).toBe("https://example.com/login");
    for (const blocked of [
      "http://127.0.0.1:3000/api/health",
      "http://localhost:9222/json/list",
      "http://[::1]:3000/",
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/",
      "http://10.0.0.1/admin",
      "http://192.168.1.1/",
      "http://172.16.0.5/",
      "file:///etc/passwd",
    ]) {
      expect(() => assertSafeBrowserUrl(blocked)).toThrow(InvalidInput);
    }
  });

  it("bridges raw TCP RFB frames over connectComputerDisplay and tracks human vs bot control", async () => {
    // Fake Xtigervnc loopback TCP echo server.
    const tcp = createTcpServer((socket) => {
      socket.on("error", () => {});
      socket.write(Buffer.from("RFB 003.008\n"));
      socket.on("data", (chunk) => socket.write(chunk));
    });
    tcp.listen(0, "127.0.0.1");
    await once(tcp, "listening");
    const vncPort = (tcp.address() as AddressInfo).port;
    cleanups.push(() => new Promise<void>((resolve) => tcp.close(() => resolve())));

    // Fake Chrome DevTools Protocol HTTP + WebSocket server.
    const cdpCommands: { method: string; params: Record<string, unknown> }[] = [];
    const wss = new WebSocketServer({ noServer: true });
    const http = createHttpServer((req, res) => {
      const port = (http.address() as AddressInfo).port;
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/json/version") {
        res.end(JSON.stringify({ Browser: "FakeChrome/1.0" }));
      } else if (req.url === "/json/list") {
        res.end(
          JSON.stringify([
            {
              id: "page-1",
              type: "page",
              url: "https://shop.example.test/login",
              title: "Shop Login",
              webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-1`,
            },
          ]),
        );
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    http.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("message", (raw) => {
          const msg = JSON.parse(rawDataText(raw)) as {
            id: number;
            method: string;
            params?: Record<string, unknown>;
          };
          cdpCommands.push({ method: msg.method, params: msg.params ?? {} });
          if (msg.method === "Page.captureScreenshot") {
            ws.send(
              JSON.stringify({
                id: msg.id,
                result: {
                  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==",
                },
              }),
            );
          } else if (msg.method === "Runtime.evaluate") {
            const expr = typeof msg.params?.expression === "string" ? msg.params.expression : "";
            if (expr.includes("links")) {
              ws.send(
                JSON.stringify({
                  id: msg.id,
                  result: {
                    result: {
                      value: JSON.stringify({
                        url: "https://shop.example.test/login",
                        title: "Shop Login",
                        text: "Sign in",
                        links: [],
                        inputs: [],
                        buttons: [],
                      }),
                    },
                  },
                }),
              );
            } else {
              ws.send(
                JSON.stringify({
                  id: msg.id,
                  result: {
                    result: {
                      value: JSON.stringify({
                        url: "https://shop.example.test/login",
                        title: "Shop Login",
                      }),
                    },
                  },
                }),
              );
            }
          } else {
            ws.send(JSON.stringify({ id: msg.id, result: {} }));
          }
        });
      });
    });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const cdpPort = (http.address() as AddressInfo).port;
    cleanups.push(async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    });

    const computer = createNativeComputerService(
      {
        stateDirectory: "/tmp/fake-computer",
        vncPort,
        cdpPort,
        display: ":99",
        geometry: "1280x800",
      },
      { externalProcesses: true },
    );
    cleanups.push(() => computer.close());

    const status = (await computer.computerRequest({
      action: "status",
      actorId: "one",
      actorName: "Alice",
    })) as ComputerStatus;
    expect(status).toMatchObject({
      available: true,
      running: true,
      browserReady: true,
      control: { kind: "idle" },
    });

    const attachment = (await computer.computerRequest({
      action: "observe",
      actorId: "one",
      actorName: "Alice",
    })) as ComputerAttachment;
    expect(attachment.path).toBe("/api/display/ws");
    expect(attachment.viewerId).toMatch(/^[A-Za-z0-9_-]{16,200}$/);

    // Verify RFB TCP bridge receives handshake and echoes binary frames.
    const bridge = computer.connectComputerDisplay(attachment);
    const received: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      bridge.on("error", reject);
      bridge.on("message", (data: Buffer) => {
        received.push(Buffer.from(data));
        if (received.length === 1) bridge.send(Buffer.from("RFB 003.008\n"), { binary: true });
        if (received.length === 2) resolve();
      });
    });
    expect(received.map((b) => b.toString("utf8"))).toEqual(["RFB 003.008\n", "RFB 003.008\n"]);
    bridge.terminate();

    // Bot tools work via CDP while idle.
    const tools = createComputerMcpTools({
      backend: computer.backend,
      lock: new ComputerLeaseLock(),
    });
    const shot = await tools.callTool(botCtx, "computer_screenshot", {});
    expect(shot.isError).toBeUndefined();
    expect(shot.content.some((c) => c.type === "image")).toBe(true);

    const click = await tools.callTool(botCtx, "computer_click", { x: 100, y: 200 });
    expect(click.isError).toBeUndefined();
    expect(cdpCommands.some((c) => c.method === "Input.dispatchMouseEvent")).toBe(true);

    // Human takes control -> bot input is refused until human releases control!
    const taken = (await computer.computerRequest({
      action: "take",
      actorId: "one",
      actorName: "Alice",
      viewerId: attachment.viewerId,
    })) as ComputerStatus;
    expect(taken.control).toEqual({ kind: "human", name: "Alice", mine: true });

    const blockedClick = await tools.callTool(botCtx, "computer_click", { x: 10, y: 10 });
    expect(blockedClick.isError).toBe(true);
    expect(JSON.stringify(blockedClick)).toContain("Alice currently has control");

    const released = (await computer.computerRequest({
      action: "release",
      actorId: "one",
      actorName: "Alice",
      viewerId: attachment.viewerId,
    })) as ComputerStatus;
    expect(released.control).toEqual({ kind: "idle" });

    const snap = await tools.callTool(botCtx, "browser_snapshot", {});
    expect(snap.isError).toBeUndefined();
    expect(snap.structuredContent).toMatchObject({
      ok: true,
      value: { url: "https://shop.example.test/login", title: "Shop Login" },
    });
  });

  it("fills saved vault logins and TOTP codes only on matching origins and never exposes secrets to the model", async () => {
    const store = new Store(":memory:");
    cleanups.push(() => store.close());
    store.managedBots.upsertCredential({
      id: "cred-1",
      label: "Test",
      kind: "api_key",
      vendor: "openai",
      envVar: "OPENAI_API_KEY",
      allowedHarnesses: ["codex"],
    });
    const mkBot = (id: string) =>
      store.managedBots.upsertManagedBot({
        id,
        name: id,
        description: "",
        instructions: "",
        harness: "codex",
        model: "m1",
        provider: "openai",
        reasoning: "",
        speed: "",
        ownerId: "one",
        ownerOsUser: "alice",
        shared: false,
        credentialId: "cred-1",
        enabledTools: [],
        enabledSkills: [],
        enabledMcpServers: [],
        createdAt: 1,
        updatedAt: 1,
      });
    mkBot("alpha");
    mkBot("beta");
    const vaultHandler = createNativeVaultHandler(store, (id) =>
      store.managedBots.getManagedBot(id)!,
    );

    const secretPassword = "ultra-secret-login-pw-777";
    const rfc6238Seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // "12345678901234567890"
    const { id: loginId } = (await vaultHandler({
      operation: "add_login",
      profile: "alpha",
      actor: "one",
      login: {
        label: "Bank",
        origin: "https://bank.example.test",
        identifierType: "email",
        identifier: "alice@example.test",
        password: secretPassword,
        otpSecret: rfc6238Seed,
      },
    })) as { id: string };

    // Confirm RFC 6238 test vector for T=59s (counter=1 -> 287082 for SHA-1 6 digits).
    expect(generateTotpCode(rfc6238Seed, 59_000)).toBe("287082");

    // Raw login:* secrets are never readable via secret_list / secret_get.
    expect(
      await store.secrets.listSecrets({ botId: "alpha", ownerId: "one", shared: false }),
    ).toEqual([]);
    expect(
      await store.secrets.getSecret(
        { botId: "alpha", ownerId: "one", shared: false },
        `login:${loginId}`,
      ),
    ).toBeUndefined();
    expect(store.secrets.redactForBot("alpha", `leaked ${secretPassword}`)).toBe(
      "leaked [REDACTED]",
    );

    let activeOrigin = "https://phishing.example.test";
    const filledCalls: { identifier?: string; password?: string; code?: string }[] = [];
    const bridge: BrowserPageBridge = {
      async currentOrigin() {
        return { origin: activeOrigin, url: `${activeOrigin}/login` };
      },
      async fillLoginFields({ expectedOrigins, identifier, password, submit }) {
        if (!expectedOrigins.includes(activeOrigin)) {
          throw new Error(`Origin mismatch: on ${activeOrigin}, expected ${expectedOrigins[0]}`);
        }
        filledCalls.push({ identifier, password });
        return {
          origin: activeOrigin,
          filledUsername: true,
          filledPassword: true,
          submitted: Boolean(submit),
        };
      },
      async fillTotpField({ expectedOrigins, code, submit }) {
        if (!expectedOrigins.includes(activeOrigin)) {
          throw new Error(`Origin mismatch: on ${activeOrigin}`);
        }
        filledCalls.push({ code });
        return { origin: activeOrigin, filledCode: true, submitted: Boolean(submit) };
      },
    };

    const tools = createVaultMcpTools({
      secrets: store.secrets,
      browserBridge: bridge,
      now: () => 59_000,
    });

    // Listing logins never returns password or otpSecret.
    const listed = await tools.callTool(botCtx, "vault_list_logins", {});
    expect(listed.isError).toBeUndefined();
    expect(listed.structuredContent).toEqual({
      ok: true,
      value: {
        logins: [
          {
            id: loginId,
            label: "Bank",
            origin: "https://bank.example.test",
            identifier: "alice@example.test",
            identifierType: "email",
            hasOtp: true,
          },
        ],
      },
    });
    expect(JSON.stringify(listed)).not.toContain(secretPassword);
    expect(JSON.stringify(listed)).not.toContain(rfc6238Seed);

    // Another bot cannot use alpha's login.
    const wrongBot = await tools.callTool({ ...botCtx, botId: "beta" }, "vault_login_fill", {
      login_id: loginId,
    });
    expect(wrongBot.isError).toBe(true);
    expect(filledCalls).toHaveLength(0);

    // Mismatched browser origin is refused without filling!
    const phishing = await tools.callTool(botCtx, "vault_login_fill", { login_id: loginId });
    expect(phishing.isError).toBe(true);
    expect(JSON.stringify(phishing)).toContain("Origin mismatch");
    expect(filledCalls).toHaveLength(0);

    // Matching origin fills cleanly and never echoes the password back to the model.
    activeOrigin = "https://bank.example.test";
    const okFill = await tools.callTool(botCtx, "vault_login_fill", {
      login_id: loginId,
      submit: true,
    });
    expect(okFill.isError).toBeUndefined();
    expect(okFill.structuredContent).toEqual({
      ok: true,
      value: {
        loginId,
        label: "Bank",
        origin: "https://bank.example.test",
        filledUsername: true,
        filledPassword: true,
        submitted: true,
      },
    });
    expect(JSON.stringify(okFill)).not.toContain(secretPassword);
    expect(filledCalls[0]).toEqual({ identifier: "alice@example.test", password: secretPassword });

    // TOTP fill computes code on matching origin and never exposes the seed.
    const okTotp = await tools.callTool(botCtx, "vault_totp_fill", { login_id: loginId });
    expect(okTotp.isError).toBeUndefined();
    expect(JSON.stringify(okTotp)).not.toContain(rfc6238Seed);
    expect(JSON.stringify(okTotp)).not.toContain("287082");
    expect(filledCalls[1]).toEqual({ code: "287082" });
  });
});
