import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { botFixture, capabilitiesFixture, conversationFixture, experienceRequester } from "../tests/helpers/runtime-fixtures.js";
import type { Message, Runtime } from "../src/shared/types.js";
import { controlPort, port } from "./ports.js";

/**
 * The real app server for the browser suite: real routes, session handling, CSP, event stream and built client,
 * over a scripted assistant runtime so nothing leaves this machine. Another loopback port reports what the
 * browser told /api/csp-report, because the app only logs those, and resets the conversations between tests.
 */
if (!existsSync("dist/client/index.html")) throw new Error("Run `npm run build` first: the suite serves dist/client.");

const bots = [
  botFixture({ id: "ranch", name: "Ranch Hand", lastMessage: { text: "Fence check is done." } }),
  botFixture({ id: "trail", name: "Trail Cook" }),
];
const seedMessages = () => new Map<string, Message[]>([
  ["ranch", [{ id: "seed-1", role: "assistant", text: "Morning. The north fence is fixed.", createdAt: "2026-11-05T14:00:00Z" }]],
  ["trail", []],
]);
// Replaced between tests, so no test sees what another sent. A reply still pending from before holds its old thread.
let messages = seedMessages();
const watchers = new Map<string, Set<(kind?: "inflight") => void>>();
const notify = (botId: string) => { for (const changed of watchers.get(botId) ?? []) changed(); };

// Both assistants run on one ChatGPT account with a used-up session; the Ranch Hand falls back to OpenRouter.
const chatgpt = "c".repeat(32), openrouter = "b".repeat(32);
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const experienceRequest = experienceRequester({
  accounts: input => ({ accounts: [{ key: chatgpt, provider: "openai-codex", role: "main" as const },
    ...input.profile === "ranch" ? [{ key: openrouter, provider: "openrouter", role: "fallback" as const }] : []] }),
  account_usage: input => input.key === chatgpt
    ? { key: chatgpt, provider: "openai-codex", plan: "Pro", title: "Account limits", fetchedAt: new Date().toISOString(), details: ["Credits balance: $4.00"],
      windows: [{ label: "Session", usedPercent: 100, resetsAt: inHours(3.4), detail: null, scope: "account" as const },
        { label: "Weekly", usedPercent: 64, resetsAt: inHours(70), detail: null, scope: "account" as const }],
      unavailableReason: null, bankedResets: 2, identity: null }
    : { key: openrouter, provider: "openrouter", plan: null, title: "Account limits", fetchedAt: new Date().toISOString(), details: ["Credits balance: $12.40"],
      windows: [{ label: "API key quota", usedPercent: 22, resetsAt: null, detail: "$15.60 of $20.00 remaining", scope: "account" as const }],
      unavailableReason: null, bankedResets: 0, identity: null },
});

// Members the suite does not script fail at their name, as tests/helpers/server.ts does for the unit tests.
const unscripted = (name: string) => async (): Promise<never> => { throw new Error(`The e2e runtime double does not script ${name}.`); };
const runtime: Runtime = {
  saveBot: unscripted("saveBot"), deleteBot: unscripted("deleteBot"), stop: unscripted("stop"),
  generatePortrait: unscripted("generatePortrait"), steer: unscripted("steer"), answerRequest: unscripted("answerRequest"),
  approve: unscripted("approve"), upload: unscripted("upload"), download: unscripted("download"), tools: unscripted("tools"),
  setTools: unscripted("setTools"), skills: unscripted("skills"), setSkills: unscripted("setSkills"),
  saveRoutine: unscripted("saveRoutine"), deleteRoutine: unscripted("deleteRoutine"),
  status: async () => ({ connected: true, code: "ready" }),
  capabilities: async () => capabilitiesFixture({ chat: { supported: true }, durableEvents: { supported: true }, idempotency: { supported: true } }),
  listBots: async () => bots,
  experienceRequest,
  botDetail: async botId => bots.find(bot => bot.id === botId)!,
  conversation: async botId => conversationFixture({ botId, messages: [...messages.get(botId) ?? []] }),
  routines: async () => [],
  discoverEvents: async cursor => ({ cursor, events: [] }),
  lookupSubmission: async () => null,
  // The user's message lands at once. The reply lands a beat later, each announced the way Hermes announces it.
  submit: async input => {
    const thread = messages.get(input.botId)!, runId = randomUUID();
    thread.push({ id: randomUUID(), runId, role: "user", text: input.text, createdAt: new Date().toISOString(), sender: { id: input.senderId, name: input.senderId } });
    notify(input.botId);
    setTimeout(() => {
      thread.push({ id: randomUUID(), runId, role: "assistant", text: `Howdy, partner. You said: ${input.text}`, createdAt: new Date().toISOString() });
      notify(input.botId);
    }, 150);
    return { requestId: input.requestId, status: "accepted", runId };
  },
  watch(botId, changed) {
    const set = watchers.get(botId) ?? new Set();
    watchers.set(botId, set.add(changed));
    return () => { set.delete(changed); };
  },
  close: async () => {},
};

const violations: unknown[] = [];
const { app } = await createApp(
  loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:", HOST: "127.0.0.1", PORT: String(port), LOG_LEVEL: "warn" }),
  runtime,
  { background: false, logStream: { write(line) {
    try { const entry = JSON.parse(line); if (entry.csp) violations.push(entry.csp); } catch { /* Not a JSON log line. */ }
  } } },
);
await app.listen({ host: "127.0.0.1", port });

// GET reads the violations. DELETE starts the next test from a clean slate.
const control = createServer((req, res) => {
  if (req.method === "DELETE") { violations.length = 0; messages = seedMessages(); }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(violations));
});
control.listen(controlPort, "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => { control.close(); void app.close().then(() => process.exit(0)); });
