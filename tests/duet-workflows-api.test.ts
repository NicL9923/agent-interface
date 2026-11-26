import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { createConfirmationMcpTools } from "../src/server/mcp/confirmation-tools.js";
import { createTaskMcpTools } from "../src/server/mcp/task-tools.js";
import { createWildbotsMcpServer } from "../src/server/mcp/wildbots-mcp.js";
import { checkInPrompt } from "../src/server/main-assistant.js";
import { memoryToolProvider } from "../src/server/native-harness.js";
import { buildBrainDumpPrompt } from "../src/shared/brain-dump.js";
import type { Bot, Routine, Runtime } from "../src/shared/types.js";
import { fakeRuntime, localLogin } from "./helpers/server.js";

const origin = "http://127.0.0.1:3000";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function setupApp() {
  const bots = new Map<string, Bot>([
    [
      "sage",
      {
        id: "sage",
        name: "Sage",
        description: "Personal assistant",
        model: "claude-opus-5-5",
        provider: "anthropic",
        harness: "claude",
        enabledMcpServers: ["gmail", "calendar"],
        enabledTools: ["chat_search"],
        enabledSkills: ["triage"],
        shared: false,
        activity: "idle",
      },
    ],
    [
      "ranch",
      {
        id: "ranch",
        name: "Ranch",
        description: "Household helper",
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        harness: "claude",
        enabledMcpServers: [],
        shared: true,
        activity: "idle",
      },
    ],
    [
      "kim-private",
      {
        id: "kim-private",
        name: "Kim Notes",
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        harness: "claude",
        shared: false,
        activity: "idle",
      },
    ],
  ]);
  const routines = new Map<string, Routine>();
  let routineSeq = 0;

  const runtime = fakeRuntime({
    status: async () => ({ connected: true }),
    capabilities: async () => new Proxy({}, { get: () => ({ supported: true }) }) as never,
    listBots: async () => [...bots.values()],
    botDetail: async (id) => {
      const bot = bots.get(id);
      if (!bot) throw new Error(`Missing bot ${id}`);
      return bot;
    },
    saveBot: async (input, id) => {
      const botId =
        id ??
        input.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
      const bot: Bot = {
        id: botId,
        name: input.name,
        description: input.description,
        instructions: input.instructions,
        model: input.model,
        provider: input.provider,
        harness: input.harness,
        enabledMcpServers: input.enabledMcpServers,
        enabledTools: input.enabledTools,
        enabledSkills: input.enabledSkills,
        shared: input.shared,
        activity: "idle",
      };
      bots.set(botId, bot);
      return bot;
    },
    conversation: async (botId) => ({
      botId,
      messages: [],
      activity: { state: "idle" },
      approvals: [],
      attention: [],
      files: [],
    }),
    routines: async (botId) =>
      [...routines.values()].filter((row) => !botId || row.botId === botId),
    routineDeliveries: async () => [],
    saveRoutine: async (input, id) => {
      const routineId = id ?? `routine-${++routineSeq}`;
      const saved: Routine = { ...input, id: routineId };
      routines.set(routineId, saved);
      return saved;
    },
    deleteRoutine: async (id) => {
      routines.delete(id);
    },
    delegationPolicy: async () => 2,
    close: async () => {},
  }) as Runtime;

  const created = await createApp(
    loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }),
    runtime,
    { background: false },
  );
  cleanups.push(() => created.app.close());

  const one = await localLogin(created.app, origin, "one");
  const two = await localLogin(created.app, origin, "two");
  created.store.savePresentation("sage", { shared: false, ownerId: "local-one" });
  created.store.savePresentation("ranch", { shared: true });
  created.store.savePresentation("kim-private", { shared: false, ownerId: "local-two" });

  return { ...created, one, two, bots, routines };
}

async function mcpInit(spec: { url?: string; headers?: Record<string, string> }) {
  const res = await fetch(spec.url!, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...spec.headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    }),
  });
  expect(res.status).toBe(200);
}

async function mcpCall(
  spec: { url?: string; headers?: Record<string, string> },
  name: string,
  args: Record<string, unknown>,
) {
  const response = await fetch(spec.url!, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      ...spec.headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  return (await response.json()) as {
    result?: {
      content: { text: string }[];
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    error?: { code: number; message: string };
  };
}

describe("Tasks with human-only Done gate", () => {
  it("allows bots to create and propose ready_for_review, blocks bot Done, and allows human Done", async () => {
    const { app, store, one, two } = await setupApp();
    const mcp = await createWildbotsMcpServer({
      store,
      secrets: store.secrets,
      extraToolProviders: [createTaskMcpTools(store.tasks)],
    });
    cleanups.push(() => mcp.close());
    store.managedBots.upsertCredential({
      id: "cred-one",
      label: "Anthropic API",
      vendor: "anthropic",
      kind: "api_key",
      allowedHarnesses: ["claude-code"],
      envVar: "ANTHROPIC_API_KEY",
    });
    store.managedBots.upsertManagedBot({
      id: "sage",
      name: "Sage",
      description: "",
      instructions: "",
      harness: "claude-code",
      model: "claude-opus-5-5",
      provider: "anthropic",
      reasoning: "medium",
      speed: "normal",
      ownerId: "local-one",
      ownerOsUser: "nic",
      shared: false,
      credentialId: "cred-one",
      enabledTools: [],
      enabledSkills: [],
      enabledMcpServers: [],
    });

    const { spec } = mcp.createSessionSpec({ botId: "sage", ownerId: "local-one", shared: false });
    await mcpInit(spec);
    const created = await mcpCall(spec, "task_create", {
      title: "Compare solar quotes",
      notes: "3 vendors",
    });
    expect(created.result?.isError).toBeFalsy();
    const taskId = ((created.result?.structuredContent?.task ?? {}) as { id: string }).id;

    // Bot tries to mark Done directly -> refused!
    const botDone = await mcpCall(spec, "task_update", { taskId, status: "done" });
    expect(botDone.result?.isError).toBe(true);
    expect(botDone.result?.content[0]?.text).toContain(
      "Only a household member can mark a task done",
    );

    // Bot marks ready_for_review with summary -> succeeds
    const ready = await mcpCall(spec, "task_update", {
      taskId,
      status: "ready_for_review",
      summary: "Best bid is SunPeak at $18.4k.",
    });
    expect(ready.result?.isError).toBeFalsy();

    // Another household member cannot see or mutate owner's personal bot task
    const twoList = await app.inject({ method: "GET", url: "/api/tasks", headers: two });
    expect(twoList.statusCode).toBe(200);
    expect(twoList.json().tasks).toHaveLength(0);
    const twoPatch = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: two,
      payload: { status: "done" },
    });
    expect(twoPatch.statusCode).toBe(404);

    // Owner requests changes -> moves back to working and appends feedback
    const reqChanges = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: one,
      payload: { status: "working", feedback: "Include battery backup pricing" },
    });
    expect(reqChanges.statusCode).toBe(200);
    expect(reqChanges.json().task.status).toBe("working");
    expect(reqChanges.json().task.notes).toContain("Include battery backup pricing");

    // Owner marks done -> succeeds and records completedBy
    const done = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: one,
      payload: { status: "done" },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().task.status).toBe("done");
    expect(done.json().task.completedBy).toBe("user:local-one");

    // Owner can delete task
    const del = await app.inject({ method: "DELETE", url: `/api/tasks/${taskId}`, headers: one });
    expect(del.statusCode).toBe(200);
  });
});

describe("MCP action confirmations for external side effects", () => {
  it("blocks action_confirm until a human approves or declines via API and enforces privacy", async () => {
    const { app, store, one, two } = await setupApp();
    const mcp = await createWildbotsMcpServer({
      store,
      secrets: store.secrets,
      extraToolProviders: [createConfirmationMcpTools(store.confirmations, { timeoutMs: 5_000 })],
    });
    cleanups.push(() => mcp.close());
    store.managedBots.upsertCredential({
      id: "cred-one",
      label: "Anthropic API",
      vendor: "anthropic",
      kind: "api_key",
      allowedHarnesses: ["claude-code"],
      envVar: "ANTHROPIC_API_KEY",
    });
    store.managedBots.upsertManagedBot({
      id: "sage",
      name: "Sage",
      description: "",
      instructions: "",
      harness: "claude-code",
      model: "claude-opus-5-5",
      provider: "anthropic",
      reasoning: "medium",
      speed: "normal",
      ownerId: "local-one",
      ownerOsUser: "nic",
      shared: false,
      credentialId: "cred-one",
      enabledTools: [],
      enabledSkills: [],
      enabledMcpServers: [],
    });

    const { spec } = mcp.createSessionSpec({ botId: "sage", ownerId: "local-one", shared: false });
    await mcpInit(spec);
    const pendingCall = mcpCall(spec, "action_confirm", {
      kind: "send_email",
      title: "Send invoice follow-up",
      summary: "Email ACME billing about overdue invoice #402.",
      target: "billing@acme.example",
      fields: [
        { label: "To", value: "billing@acme.example" },
        { label: "Subject", value: "Invoice #402 follow-up" },
      ],
    });

    // Wait briefly for the confirmation row to be created
    let pendingId = "";
    for (let attempt = 0; attempt < 20; attempt++) {
      const res = await app.inject({ method: "GET", url: "/api/confirmations", headers: one });
      const list = res.json().confirmations as { id: string }[];
      if (list.length) {
        pendingId = list[0].id;
        break;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(pendingId).toBeTruthy();

    // Another member sees nothing and gets 404 when trying to decide
    const twoList = await app.inject({ method: "GET", url: "/api/confirmations", headers: two });
    expect(twoList.json().confirmations).toHaveLength(0);
    const twoDecide = await app.inject({
      method: "POST",
      url: `/api/bots/sage/confirmations/${pendingId}`,
      headers: two,
      payload: { decision: "approved" },
    });
    expect(twoDecide.statusCode).toBe(404);

    // Owner approves -> resolves the waiting MCP tool call immediately
    const approve = await app.inject({
      method: "POST",
      url: `/api/bots/sage/confirmations/${pendingId}`,
      headers: one,
      payload: { decision: "approved", note: "Send it" },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().confirmation.status).toBe("approved");

    const toolResult = await pendingCall;
    expect(toolResult.result?.structuredContent).toMatchObject({
      id: pendingId,
      status: "approved",
      decidedBy: "local-one",
      note: "Send it",
    });

    // Double decision is refused with 409
    const again = await app.inject({
      method: "POST",
      url: `/api/bots/sage/confirmations/${pendingId}`,
      headers: one,
      payload: { decision: "declined" },
    });
    expect(again.statusCode).toBe(409);
  });
});

describe("Card-emitting check-ins, Morning Brief & inline Today triage", () => {
  it("schedules Morning Brief, upgrades checkInPrompt, and enriches Today additively", async () => {
    const { app, store, one, routines } = await setupApp();
    expect(
      checkInPrompt({ marker: "[m]", member: "Nic", timezone: "America/Chicago", everyHours: 2 }),
    ).toContain("agent-ui");

    // Cannot turn on Morning Brief without a Main Assistant
    const noMain = await app.inject({
      method: "PUT",
      url: "/api/preferences/morning-brief",
      headers: one,
      payload: { enabled: true, timeOfDay: "07:30", timezone: "America/Chicago" },
    });
    expect(noMain.statusCode).toBe(409);

    // Pick Main Assistant
    const setMain = await app.inject({
      method: "PUT",
      url: "/api/preferences/main",
      headers: one,
      payload: { botId: "sage" },
    });
    expect(setMain.statusCode).toBe(200);

    // Rejects invalid timeOfDay
    const badTime = await app.inject({
      method: "PUT",
      url: "/api/preferences/morning-brief",
      headers: one,
      payload: { enabled: true, timeOfDay: "25:99", timezone: "America/Chicago" },
    });
    expect(badTime.statusCode).toBe(400);

    // Enables Morning Brief -> creates daily cron routine on Main Assistant
    const enabled = await app.inject({
      method: "PUT",
      url: "/api/preferences/morning-brief",
      headers: one,
      payload: { enabled: true, timeOfDay: "07:15", timezone: "America/Chicago" },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().morningBrief).toEqual({
      enabled: true,
      timeOfDay: "07:15",
      timezone: "America/Chicago",
    });
    const briefRoutine = [...routines.values()].find((r) => r.name === "Morning brief");
    expect(briefRoutine?.schedule).toBe("15 7 * * *");
    expect(briefRoutine?.botId).toBe("sage");

    // Seed morning brief transcript message + pending task + confirmation + learning proposal
    const emailFence = [
      "Good morning! Two items need attention.",
      "```agent-ui",
      JSON.stringify({
        version: 1,
        cards: [
          {
            id: "draft-1",
            type: "email",
            title: "Reply to Sarah",
            to: ["sarah@example.test"],
            subject: "Thursday dinner",
            body: "Sounds great, see you at 6!",
          },
        ],
      }),
      "```",
    ].join("\n");
    store.transcripts.appendMessages(
      "sage",
      [
        {
          id: "brief-msg-1",
          role: "assistant",
          text: emailFence,
          origin: { kind: "scheduled", visibility: "conversation", title: "Morning brief" },
          createdAt: "2026-11-26T13:15:00.000Z",
        },
      ],
      "harness",
    );
    store.tasks.create({
      botId: "sage",
      title: "Review dentist bill",
      status: "ready_for_review",
      createdBy: "bot:sage",
    });
    store.confirmations.createPending({
      botId: "sage",
      kind: "send_email",
      title: "Send RSVP",
      summary: "Confirm attendance",
    });
    store.memory.proposeMemoryEdit(
      "sage",
      { op: "add", kind: "user", key: "coffee", content: "Prefers oat cortado." },
      { origin: "learning", reason: "Mentioned in chat" },
    );

    const today = await app.inject({ method: "GET", url: "/api/today", headers: one });
    expect(today.statusCode).toBe(200);
    const body = today.json();
    expect(body.morningBrief?.messageId).toBe("brief-msg-1");
    expect(body.morningBrief?.cards).toHaveLength(1);
    expect(body.tasks).toHaveLength(1);
    expect(body.confirmations).toHaveLength(1);
    expect(body.learningProposals).toHaveLength(1);

    // Disabling Morning Brief removes the managed routine
    const disabled = await app.inject({
      method: "PUT",
      url: "/api/preferences/morning-brief",
      headers: one,
      payload: { enabled: false, timeOfDay: "07:15", timezone: "America/Chicago" },
    });
    expect(disabled.statusCode).toBe(200);
    expect([...routines.values()].filter((r) => r.name === "Morning brief")).toHaveLength(0);
  });
});

describe("Cross-assistant Deliverables library", () => {
  it("extracts inline views, reply cards, and files across visible bots while hiding private ones", async () => {
    const { app, store, one, two } = await setupApp();
    const viewText = [
      "Here is a calculator:",
      "```wildbots-html",
      JSON.stringify({
        version: 1,
        title: "Feed Calculator",
        html: "<!doctype html><html><body><p>Calc</p></body></html>",
      }),
      "```",
    ].join("\n");
    store.transcripts.appendMessages(
      "ranch",
      [
        {
          id: "ranch-view-1",
          role: "assistant",
          text: viewText,
          createdAt: "2026-11-26T10:00:00.000Z",
        },
      ],
      "harness",
    );
    store.transcripts.appendMessages(
      "sage",
      [
        {
          id: "sage-file-1",
          role: "assistant",
          text: "Budget attached.",
          files: [{ id: "file1.sig", name: "budget.csv", mime: "text/csv", size: 512 }],
          createdAt: "2026-11-26T11:00:00.000Z",
        },
      ],
      "harness",
    );

    const oneAll = await app.inject({ method: "GET", url: "/api/deliverables", headers: one });
    expect(oneAll.statusCode).toBe(200);
    expect(oneAll.json().items.map((item: { title: string }) => item.title)).toEqual([
      "budget.csv",
      "Feed Calculator",
    ]);

    const oneViews = await app.inject({
      method: "GET",
      url: "/api/deliverables?kind=view",
      headers: one,
    });
    expect(oneViews.json().items).toHaveLength(1);
    expect(oneViews.json().items[0].title).toBe("Feed Calculator");

    // Member two sees Ranch's view, NEVER Sage's private file
    const twoAll = await app.inject({ method: "GET", url: "/api/deliverables", headers: two });
    expect(twoAll.statusCode).toBe(200);
    expect(twoAll.json().items.map((item: { title: string }) => item.title)).toEqual([
      "Feed Calculator",
    ]);
  });
});

describe("Shared personal memory, Topic Channels & Brain Dump", () => {
  it("creates topic channels under Main Assistant and shares personal user facts only across owner's personal bots", async () => {
    const { app, store, one, two } = await setupApp();
    // Cannot create channel before setting Main Assistant
    const noMain = await app.inject({
      method: "POST",
      url: "/api/channels",
      headers: one,
      payload: { topic: "Finances" },
    });
    expect(noMain.statusCode).toBe(409);

    await app.inject({
      method: "PUT",
      url: "/api/preferences/main",
      headers: one,
      payload: { botId: "sage" },
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/channels",
      headers: one,
      payload: { topic: "Finances", description: "Taxes and budget" },
    });
    expect(created.statusCode).toBe(200);
    const channelBotId = created.json().channel.botId as string;
    expect(created.json().channel.name).toBe("#Finances");
    expect(created.json().bot.shared).toBe(false);
    expect(created.json().bot.ownerId).toBe("local-one");
    expect(created.json().bot.enabledMcpServers).toEqual(["gmail", "calendar"]);

    // Another member cannot see the channel
    const twoChannels = await app.inject({ method: "GET", url: "/api/channels", headers: two });
    expect(twoChannels.json().channels).toHaveLength(0);

    // Add an active personal `user` fact on Sage -> visible to owner's Finances channel, NOT to shared Ranch
    store.memory.updateSettings("sage", { autoApply: true });
    store.memory.proposeMemoryEdit(
      "sage",
      { op: "add", kind: "user", key: "tax_cpa", content: "CPA is Jane Doe." },
      { origin: "bot", reason: "User stated" },
    );
    const sharedMd = store.memory.renderSharedOwnerMemoryMarkdown("local-one", channelBotId, [
      "sage",
      channelBotId,
    ]);
    expect(sharedMd).toContain("CPA is Jane Doe.");

    // Turning off personal memory sharing on Sage stops sharing its facts
    const toggle = await app.inject({
      method: "PUT",
      url: "/api/bots/sage/learning/settings",
      headers: one,
      payload: { autoApply: true, sharePersonalMemory: false },
    });
    expect(toggle.statusCode).toBe(200);
    expect(toggle.json().sharePersonalMemory).toBe(false);
    expect(
      store.memory.renderSharedOwnerMemoryMarkdown("local-one", channelBotId, [
        "sage",
        channelBotId,
      ]),
    ).toBe("");

    // MCP shared_memory_read is hidden from shared bots
    const provider = memoryToolProvider(store.memory, () => ["sage", channelBotId]);
    expect(
      provider
        .listTools({ botId: "ranch", shared: true })
        .some((t) => t.name === "shared_memory_read"),
    ).toBe(false);
    expect(
      provider
        .listTools({ botId: channelBotId, shared: false, ownerId: "local-one" })
        .some((t) => t.name === "shared_memory_read"),
    ).toBe(true);

    // Brain dump prompt builds cleanly
    const prompt = buildBrainDumpPrompt("Pay water bill and email Sarah");
    expect(prompt).toContain("[Brain dump triage]");
    expect(prompt).toContain("task_create");
    expect(prompt).toContain("Pay water bill and email Sarah");
  });
});
