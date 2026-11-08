import { experienceRequester, automationRequester } from "./helpers/runtime-fixtures.js";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import type { HermesUpgrades } from "../src/server/upgrades.js";
import type { GroupCatalog, GroupContext, GroupPage, GroupRoom, GroupState, RoutineOutput, RoutineResult } from "../src/shared/collaboration.js";
import type { HistoryPage, SearchHit, UsageSummary } from "../src/shared/discovery.js";
import type { ProfileMemory, RoutinePreview, RoutineRunReceipt } from "../src/shared/experience.js";
import type { AccountSnapshot } from "../src/shared/account-usage.js";
import type { IntegrationCatalog, IntegrationConnection, IntegrationFlow } from "../src/shared/integrations.js";
import type { Bot, Capabilities, Conversation, FileRef, Message, ModelCatalog, Preferences, Routine, Runtime, RuntimeEvent, RuntimeStatus, Skill, SubmissionReceipt, Tool, ToolCall } from "../src/shared/types.js";
import type { UpgradeStatus } from "../src/shared/upgrades.js";
import type { ProfileVault } from "../src/shared/vault.js";
import type { VoiceTranscript } from "../src/shared/voice.js";
import type { AutomationOverview as ProfileAutomationOverview, AutomationTask, EventSubscription, SkillContent, SkillDiff } from "../src/shared/automation.js";

// The iOS app decodes these responses. Every optional field the app reads is populated, so a
// renamed or retyped field changes a committed fixture and the Swift decoding test sees it.
const directory = fileURLToPath(new URL("../ios/AgentInterfaceTests/Contract/", import.meta.url));
const instruction = "If the API change is intended, run `UPDATE_CONTRACT=1 npx vitest run tests/native-contract.test.ts`, commit the fixtures, update the Swift types and ios/AgentInterfaceTests/ContractFixtureTests.swift, then run the iOS contract tests on the Mac mini: `bash .agents/tools/validate-ios.sh SIMULATOR_UUID test -only-testing:AgentInterfaceTests/ContractFixtureTests`.";
const now = "2026-10-01T12:00:00.000Z";
const origin = "http://127.0.0.1:3000";
const at = (time: string) => `2026-10-01T${time}:00.000Z`;
// Request IDs this test chooses stay readable; any other UUID is server-generated and normalized.
const ids = { submission: "3f1c2a4e-8b7d-4c6e-9a5f-1d2e3c4b5a69", run: "7d9e0f1a-2b3c-4d5e-8f60-718293a4b5c6", group: "c0ffee00-1234-4abc-8def-0123456789ab", groupMessage: "5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9", groupStop: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", groupContext: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e", operation: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d", control: "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f", device: "6c5b4a39-2817-4f6e-9d5c-4b3a29180f7e" };
const ourIds = new Set(Object.values(ids));

const generated = { id: "plan.signature", name: "dinner-plan.pdf", mime: "application/pdf", size: 18432, url: "/api/files/plan.signature" } satisfies FileRef;
const attached = { id: "pantry.signature", name: "pantry.txt", mime: "text/plain", size: 120, url: "/api/files/pantry.signature" } satisfies FileRef;
const portrait = { id: "portrait.signature", name: "portrait.png", mime: "image/png", size: 52000, url: "/api/files/portrait.signature" } satisfies FileRef;
const bots = [
  { id: "household", name: "Household", description: "Plans meals and errands", instructions: "Be concise.", model: "claude-sonnet", provider: "anthropic", enabledMcpServers: ["calendar"], shared: true,
    avatar: { mode: "geometric", shape: "pebble", color: "#00BCA6", eyes: "oval", accessory: "glasses", eyeWidth: 1.1, eyeHeight: 0.9, eyeSpacing: 1.2 },
    enabledTools: ["terminal", "web"], enabledSkills: ["meal-planning"], sessionId: "session-household", activity: "working" },
  { id: "garden", name: "Garden", model: "gpt-mini", provider: "openai", shared: false, ownerId: "local-one",
    avatar: { mode: "mascot", family: "fox", color: "#FF9800", eyes: "round", accessory: "hat", eyeWidth: 1, eyeHeight: 1, eyeSpacing: 1 }, activity: "waiting" },
  // Archive's Hermes profile is offline, so its reads fail and report it as unavailable.
  { id: "archive", name: "Archive", model: "claude-haiku", shared: true, avatar: { mode: "portrait", src: portrait.url, origin: "generated" }, activity: "done" },
] satisfies Bot[];
// Household runs on ChatGPT and falls back to OpenRouter; Garden shares the ChatGPT account and falls back to a
// custom endpoint that reports nothing. Every field the app reads is set somewhere.
const accountKeys = { chatgpt: "c".repeat(32), openrouter: "b".repeat(32), custom: "d".repeat(32) };
const accountRows: Record<string, { key: string; provider: string; role: "main" | "fallback" }[]> = {
  household: [{ key: accountKeys.chatgpt, provider: "openai-codex", role: "main" }, { key: accountKeys.openrouter, provider: "openrouter", role: "fallback" }],
  garden: [{ key: accountKeys.chatgpt, provider: "openai-codex", role: "main" }, { key: accountKeys.custom, provider: "custom", role: "fallback" }],
};
const accountSnapshots: Record<string, AccountSnapshot> = {
  [accountKeys.chatgpt]: { key: accountKeys.chatgpt, provider: "openai-codex", plan: "Pro", title: "Account limits", fetchedAt: at("11:59"),
    windows: [{ label: "Session", usedPercent: 100, resetsAt: at("14:00"), detail: null, scope: "account" }, { label: "Weekly", usedPercent: 62.5, resetsAt: "2026-10-04T09:00:00.000Z", detail: null, scope: "account" }],
    details: ["Credits balance: $4.00"], unavailableReason: null, bankedResets: 2, identity: "e".repeat(32) },
  [accountKeys.openrouter]: { key: accountKeys.openrouter, provider: "openrouter", plan: null, title: "Account limits", fetchedAt: at("11:59"),
    windows: [{ label: "API key quota", usedPercent: 25, resetsAt: null, detail: "$15.00 of $20.00 remaining", scope: "account" }, { label: "Opus week", usedPercent: null, resetsAt: null, detail: null, scope: "model" }],
    details: ["Credits balance: $12.00"], unavailableReason: null, bankedResets: 0, identity: null },
  [accountKeys.custom]: { key: accountKeys.custom, provider: "custom", plan: null, title: "Account limits", fetchedAt: at("11:59"), windows: [], details: [],
    unavailableReason: "This provider does not report plan limits or credits to Hermes.", bankedResets: 0, identity: null },
};
const supported = { supported: true };
const capabilities = { chat: supported, steering: supported, approvals: supported, uploads: supported, generatedFiles: supported, botConfiguration: supported, tools: supported,
  skills: supported, routines: supported, durableEvents: supported, idempotency: supported, stop: supported, portraitGeneration: supported, avatarMetadata: supported,
  liveVoice: { supported: false, reason: "The WildBots voice plugin is not linked into Hermes." },
  imageGeneration: { supported: false, reason: "The connected Hermes profile has no image provider." } } satisfies Capabilities;
const status = { connected: true, code: "ready", version: "0.9.4", detail: "Connected to Hermes on the household VPS.", address: "wss://hermes.example.test/agent-ui",
  retryAt: at("12:05"), lastConnectedAt: at("11:58") } satisfies RuntimeStatus;
const cards = { version: 1, cards: [{ id: "groceries", type: "checklist", title: "Groceries", items: [{ id: "milk", text: "Milk" }, { id: "basil", text: "Basil" }] }] };
const searchCall = { id: "call-search", name: "web_search", arguments: "{\"query\":\"easy dinners\"}", status: "completed", result: "{\"ok\":true,\"url\":\"https://recipes.example.test\"}",
  startedAt: at("11:01"), completedAt: at("11:02") } satisfies ToolCall;
const calendarCall = { id: "call-calendar", name: "calendar_read", arguments: "{}", status: "failed", error: "Calendar access expired.", startedAt: at("11:03"), completedAt: at("11:03") } satisfies ToolCall;
const messages = [
  { id: "message-user", runId: "run-dinner", role: "user", text: "Plan five dinners", createdAt: at("11:00"), files: [attached] },
  { id: "message-tool", runId: "run-dinner", role: "tool", text: "", toolName: "web_search", toolCall: searchCall },
  { id: "message-assistant", runId: "run-dinner", role: "assistant", text: "Here are five dinners.\n\n```agent-ui\n" + JSON.stringify(cards) + "\n```", createdAt: at("11:05"),
    reasoning: "Balanced the week around the pantry list.", files: [generated] },
  { id: "message-steer", runId: "run-dinner", role: "user", text: "Keep it vegetarian", createdAt: at("11:06"), steered: true },
] satisfies Message[];
const conversation = {
  attention: [
    { id: "clarify-store", kind: "clarify", title: "Which store?", detail: "Choose where to shop this week.", questions: [{ id: "store", prompt: "Which store should I use?", options: ["Market", "Co-op"] },
      { id: "extras", prompt: "Anything else?", options: ["Basil (Recommended)", "Bread"], multiple: true, recommended: 0 }] },
    { id: "secure-login", kind: "secure", title: "Save the grocery login", detail: "Hermes asks to save a login.", secure: { epoch: "epoch-1", sessionId: "session-household", method: "vault.save_login", origin: "https://grocer.example.test", site: "Grocer" } },
    { id: "secure-code", kind: "secure", title: "Enter the code", detail: "Hermes needs a sign-in code.", secure: { epoch: "epoch-1", sessionId: "session-household", method: "vault.code", site: "Grocer", hint: "Sent to the family phone" } },
    { id: "secure-unlock", kind: "secure", title: "Unlock Bitwarden", detail: "Hermes needs the vault unlocked.", secure: { epoch: "epoch-1", sessionId: "session-household", method: "vault.unlock_prompt", backend: "bitwarden", displayName: "Bitwarden" } },
    { id: "secure-secret", kind: "secure", title: "Add an API key", detail: "Hermes needs a key.", secure: { epoch: "epoch-1", sessionId: "session-household", method: "secret", envVar: "GROCER_API_KEY", prompt: "Grocer API key" } },
  ],
  botId: "household", sessionId: "session-household", messages,
  activity: { state: "working", detail: "Comparing recipes", runId: "run-dinner", updatedAt: at("11:59") },
  approvals: [{ id: "approval-order", title: "Place grocery order", detail: "Order 12 items from Grocer.", status: "pending", expiresAt: at("13:00"),
    choices: ["once", "session", "always", "deny"], patterns: ["grocery order"], command: "grocer order --items 12" }],
  files: [generated], toolCalls: [searchCall, calendarCall],
} satisfies Conversation;
const gardenConversation = { botId: "garden", messages: [], activity: { state: "waiting" }, approvals: [], files: [] } satisfies Conversation;
const receipt = { requestId: ids.submission, status: "accepted", runId: "run-dinner", messageId: "message-user", message: "Hermes accepted the message." } satisfies SubmissionReceipt;
const models = { provider: "anthropic", model: "claude-sonnet", providers: [{ id: "anthropic", name: "Anthropic", aliases: ["claude"], authenticated: true, warning: "Usage is billed to the household account.",
  models: [{ id: "claude-sonnet", name: "Claude Sonnet", available: true }, { id: "claude-opus", name: "Claude Opus", available: false }] }] } satisfies ModelCatalog;
const tools = [{ id: "terminal", name: "Terminal", description: "Run shell commands.", enabled: true }, { id: "web", name: "Web", description: "Search the web.", enabled: true }] satisfies Tool[];
const skills = [{ id: "meal-planning", name: "Meal planning", description: "Plan balanced meals.", enabled: true, required: true }] satisfies Skill[];
const routines = [
  { id: "routine-morning", botId: "household", name: "Morning brief", prompt: "Prepare a morning brief.", schedule: "0 7 * * *", enabled: true, recipientIds: ["local-one"], roomIds: ["room-dinner"],
    nextRunAt: "2026-10-02T07:00:00.000Z", lastRunAt: at("07:00"), lastStatus: "ok", lastError: "The weather source timed out.", lastDeliveryError: "One device was offline." },
  { id: "routine-garden", botId: "garden", name: "Watering reminder", prompt: "Remind me to water.", schedule: "0 18 * * *", enabled: false },
] satisfies Routine[];
const routineResults = [{ id: "result-1", title: "Dinner ideas for the week", startedAt: at("07:00"), preview: "Five dinners and a grocery list.", previewOnly: false }] satisfies RoutineResult[];
const routineOutput = { messages: [{ id: "result-message", role: "assistant", text: "Five dinners and a grocery list.", createdAt: at("07:02") }], previewOnly: false } satisfies RoutineOutput;
const memory = { botId: "household", profile: "household", scope: "profile", owner: "Hermes", notice: "Hermes owns this memory.", documents: [
  { target: "memory", label: "Assistant memory", revision: "a".repeat(64), enabled: true, entries: [{ id: "b".repeat(64), text: "The household prefers vegetarian dinners." }], charLimit: 2200, charCount: 41 },
  { target: "user", label: "About you", revision: "c".repeat(64), enabled: false, entries: [], charLimit: 1375, charCount: 0 },
] } satisfies ProfileMemory;
const preview = { botId: "household", schedule: "0 7 * * *", timezone: "America/Chicago", nextRuns: ["2026-10-02T12:00:00.000Z", "2026-10-03T12:00:00.000Z"], kind: "cron" } satisfies RoutinePreview;
const runReceipt = { requestId: ids.run, routineId: "routine-morning", botId: "household", status: "completed", message: "The trial finished.", startedAt: at("11:30"), finishedAt: at("11:31"),
  executionId: "execution-1", ownerStatus: "succeeded" } satisfies RoutineRunReceipt;
const automationTask = { id: "task-fence", title: "Check the north gate", body: "Inspect the latch before opening the pasture.", status: "blocked", priority: 5,
  assignee: "garden", owner: "household", dependencies: ["task-supplies"], blockedReason: "Waiting for supplies." } satisfies AutomationTask;
const eventSubscription = { id: "gate-event", description: "Gate alert", events: ["gate.open", "gate.closed"], routineId: "routine-morning", enabled: false,
  url: "https://hermes.example.test/webhook/gate-event", secretSet: true, revision: "b".repeat(64) } satisfies EventSubscription;
const profileAutomation = { botId: "household", owner: "Hermes", goals: { supported: true,
  goal: { title: "Maintain the pasture", status: "paused", turnsUsed: 4, maxTurns: 20, pausedReason: "Waiting for your approval." },
  resume: { requestId: ids.run, status: "accepted", runId: "run-goal" } },
  tasks: { supported: true, items: [automationTask] }, triggers: { supported: true, items: [eventSubscription], platformEnabled: false },
  skills: { supported: true, installed: [{ name: "ranch/fences", description: "Fence inspection", locked: true }, { name: "ranch/gates", description: "Gate checks", locked: false }],
    pending: [{ id: "deadbeef", summary: "Add gate check", origin: "agent", revision: "c".repeat(64) }], approvalRequired: true, lockSupported: true },
} satisfies ProfileAutomationOverview;
const skillContent = { name: "ranch/fences", content: "# Fence inspection\n\nCheck the north gate.", truncated: false } satisfies SkillContent;
// The detail revision hashes the displayed diff, so it deliberately differs from the list revision.
const skillDiff = { id: "deadbeef", diff: "--- SKILL.md\n+++ SKILL.md\n+Check the north gate.\n", revision: "d".repeat(64), truncated: false } satisfies SkillDiff;
const hits = [{ botId: "household", botName: "Household", sessionId: "session-household", title: "Dinner planning", snippet: "Five easy dinners", updatedAt: at("11:05") }] satisfies SearchHit[];
const history = { botId: "household", sessionId: "session-household", offset: 0, hasMore: true,
  // Hermes reports the app sender; the server turns it into a household sender.
  messages: [Object.assign(structuredClone(messages[0]), { app_sender_id: "local-two" }), messages[2]] } satisfies HistoryPage;
const usage = { botId: "household", days: 30, sessions: 12, inputTokens: 48000, outputTokens: 9100, actualCost: 1.25, estimatedCost: 1.4, partial: false, notice: "Costs come from provider billing." } satisfies UsageSummary;
const room = { room_id: "room-dinner", name: "Dinner team", latest_seq: 2, members: [
  { member_id: "household", profile: "household", handle: "household", display_name: "Household", target: { kind: "local", profile: "household" } },
  { member_id: "garden", profile: "garden", handle: "garden", display_name: "Garden", target: { kind: "local", profile: "garden" } },
] } satisfies GroupRoom;
const groups = { supported: true, canSend: true, reason: "Hosted group chats run on the household VPS.", rooms: [room], settings: true, routineDelivery: true } satisfies GroupCatalog;
const groupContext = { purpose: "Plan the week's dinners.", notes: "No mushrooms.\nBudget is $120.", routing: "lead", lead_member_id: "garden" } satisfies GroupContext;
const approval = { request_id: "approval-request-1", description: "Order groceries", command: "grocer order --items 12" };
const groupState = { room, driver_status: { running: true, working: true, blocked: true, pending_actions: [{ kind: "approval", task_id: "task-1", member_id: "household", execution_generation: 1, ...approval, approval }],
  member_activity: [{ member_id: "garden", status: "running", thread_id: "thread-1", round_index: 1, started_at: 1790852410.25, tool: "web_search", progress_at: 1790852415.5 },
    { member_id: "household", status: "queued", thread_id: "thread-1", round_index: 1 }], max_rounds: 3 }, context: groupContext } satisfies GroupState;
const groupPage = { cursor: 1, latest_seq: 2, has_more: false, events: [{ event_id: "group-event-1", seq: 1, kind: "message", created_at: 1790852400.5, actor: { kind: "human", id: "local-one" },
  payload: { text: "Plan dinners together", thread_id: "thread-1", member_id: "household" } }] } satisfies GroupPage;
const vault = { botId: "household", profile: "household", scope: "profile", owner: "Hermes", notice: "Hermes stores these logins for this profile.",
  items: [{ id: "login-grocer", kind: "login", label: "Grocer", origin: "https://grocer.example.test", createdAt: at("09:00"), identifier: "o***@example.test", identifierType: "email", hasOtp: true, backend: "local", canRemove: true }],
  sources: [
    { name: "local", displayName: "This profile", enabled: true, needsUnlock: false, unlocked: true, installed: true, canToggle: false, canUnlock: false, canLock: false },
    { name: "bitwarden", displayName: "Bitwarden", enabled: true, needsUnlock: true, unlocked: false, installed: true, canToggle: true, canUnlock: true, canLock: false },
  ] } satisfies ProfileVault;
const connection = { id: "google-calendar", name: "Google Calendar", category: "productivity", owner: "Hermes", profile: "household", account: "one@example.test", status: "connected",
  detail: "Reads the family calendar.", checkedAt: at("11:00"), capabilities: ["calendar.read"], botIds: ["household"], actions: { connect: true, check: true, disconnect: true },
  permissions: [{ id: "calendar.read", name: "Read calendars", granted: true }, { id: "calendar.write", name: "Change events", granted: false }, { id: "contacts", name: "Contacts", granted: null }],
  setup: [{ key: "calendar", label: "Calendar", kind: "text", required: true, defaultValue: "primary", options: [{ value: "primary", label: "Primary" }] }, { key: "token", label: "Token", kind: "secret", required: false }],
} satisfies IntegrationConnection;
const integrations = { profile: "household", canManage: false, connections: [connection] } satisfies IntegrationCatalog;
const flow = { kind: "redirect", status: "pending", flowId: "flow_a1b2c3d4e5f6g7h8i9j0", url: "https://accounts.example.test/o/oauth2/auth?state=fixture", userCode: "WXYZ-1234",
  message: "Finish signing in with Google.", expiresAt: at("12:10"), callbackInput: true } satisfies IntegrationFlow;
const transcript = { text: " Add basil to the list. ", provider: "whisper" } satisfies VoiceTranscript;
const upgrade = { available: true, phase: "ready", message: "Hermes 0.9.5 passed qualification.", canCheck: true, canInstall: true, canRetry: false, canCancel: true, canRestartService: false,
  current: { revision: "1".repeat(40), version: "0.9.4", notesUrl: "https://hermes.example.test/releases/0.9.4" },
  candidate: { revision: "2".repeat(40), version: "0.9.5", notesUrl: "https://hermes.example.test/releases/0.9.5" },
  checks: [{ id: "integration", label: "Real integration", status: "passed", detail: "All add-on checks passed." }],
  controlRequestId: ids.control, controlAction: "cancel", operationId: ids.operation, error: "previous_attempt_failed", checkedAt: at("11:45"), updatedAt: at("11:46"), busyBots: ["Household"] } satisfies UpgradeStatus;
const event = { id: "event-dinner", botId: "household", runId: "run-dinner", routineId: "routine-morning", kind: "completed", title: "Dinner plan ready", body: "Five dinners and a grocery list.",
  occurredAt: at("11:05"), files: [generated] } satisfies RuntimeEvent;
const preferences = { presentation: "advanced", theme: "dark", favorites: ["household"], modelFavorites: [{ provider: "anthropic", model: "claude-sonnet" }], defaultBotId: "household",
  sections: [{ id: "home", name: "Home", botIds: ["household", "garden"] }], followBots: ["household"], startPage: "today",
  notifications: { timezone: "America/Chicago", quietStart: "22:00", quietEnd: "07:00", batchMinutes: 15 } } satisfies Preferences;

const offline = () => Object.assign(new Error("The Archive Hermes profile is offline"), { statusCode: 503 });
const runtime = {
  status: async () => status,
  reconnect: async () => status,
  capabilities: async () => capabilities,
  listBots: async () => structuredClone(bots),
  saveBot: async (_input, id) => structuredClone(bots.find(bot => bot.id === id) ?? bots[0]),
  deleteBot: async () => {},
  stop: async () => {},
  generatePortrait: async () => portrait,
  setAvatar: async () => {},
  conversation: async botId => {
    if (botId === "household") return structuredClone(conversation);
    if (botId === "garden") return structuredClone(gardenConversation);
    throw offline();
  },
  submit: async () => receipt,
  steer: async () => receipt,
  lookupSubmission: async () => receipt,
  answerRequest: async () => {},
  approve: async () => {},
  upload: async (_botId, input) => ({ id: "upload.signature", name: input.name, mime: input.mime, size: input.data.length, url: "/api/files/upload.signature" }),
  download: async () => ({ body: new Blob(["file"]).stream(), name: "file.txt", mime: "text/plain" }),
  tools: async () => tools,
  setTools: async () => {},
  skills: async () => skills,
  setSkills: async () => {},
  routines: async () => structuredClone(routines),
  saveRoutine: async (input, id) => ({ ...routines[0], ...input, id: id ?? "routine-new" }),
  deleteRoutine: async () => {},
  setRoutineEnabled: async () => {},
  routineResults: async (_botId, routineId) => routineId === "routine-morning" ? routineResults : [],
  routineOutput: async () => routineOutput,
  discoverEvents: async cursor => ({ cursor, events: [] }),
  modelOptions: async () => models,
  transcribeVoice: async () => transcript,
  experienceRequest: experienceRequester({
    search: input => { if (input.profile === "archive") throw offline(); return input.profile === "household" ? hits : []; },
    history: () => history,
    usage: input => { if (input.profile === "archive") throw offline(); return input.profile === "household" ? usage : { ...usage, botId: input.profile, sessions: 0, inputTokens: 0, outputTokens: 0, actualCost: null, estimatedCost: null, partial: true }; },
    routine_results: () => routineResults, routine_output: () => routineOutput,
    memory: () => memory, save_memory: () => memory, delete_memory: () => memory,
    preview: () => preview, run: input => ({ ...runReceipt, requestId: input.requestId }),
    run_receipt: input => ({ ...runReceipt, requestId: input.requestId }),
    accounts: input => { if (input.profile === "archive") throw offline(); return { accounts: accountRows[input.profile] ?? [] }; },
    account_usage: input => accountSnapshots[input.key],
    account_reset: () => ({ status: "reset", message: "Reset redeemed.", availableCount: 1, windowsReset: 2 }),
  }),
  automationRequest: automationRequester({
    overview: () => structuredClone(profileAutomation), goal_set: () => structuredClone(profileAutomation),
    goal_pause: () => structuredClone(profileAutomation), goal_clear: () => structuredClone(profileAutomation),
    goal_resume: input => ({ ...structuredClone(profileAutomation), goals: { ...structuredClone(profileAutomation.goals), resume: { requestId: input.requestId, status: "accepted", runId: "run-goal" } } }),
    task_create: () => structuredClone(automationTask), task_get: () => structuredClone(automationTask),
    task_update: () => structuredClone(automationTask), task_action: () => structuredClone(automationTask), task_dependency: () => structuredClone(automationTask),
    trigger_create: () => ({ subscription: structuredClone(eventSubscription), secret: "one-time-contract-fixture" }),
    trigger_update: () => ({ subscription: structuredClone(eventSubscription) }), trigger_toggle: () => ({ subscription: structuredClone(eventSubscription) }),
    trigger_delete: () => ({ ok: true }), skill_content: () => skillContent, skill_diff: () => skillDiff,
    skill_decide: () => ({ ok: true }), skill_policy: () => ({ ok: true }),
    skill_lock: input => ({ ok: true, name: input.name, locked: input.locked }),
    approval_settings: () => ({ allowlist: ["grocery order", "recursive delete"], mode: "manual" }),
    approval_allowlist_remove: () => ({ ok: true, allowlist: ["grocery order"], mode: "manual" }),
  }),
  groupRequest: async input => {
    switch (input.operation) {
      case "list": return groups;
      case "state": return groupState;
      case "log": return groupPage;
      case "create": return { room: { room_id: input.roomId, name: input.name, members: input.members, latest_seq: 0 } };
      case "send": return { accepted: true };
      case "stop": return { cancelled: 1 };
      case "approve": return { approved: true };
      case "context": return { context: { ...groupContext, purpose: input.purpose, notes: input.notes, routing: input.routing, lead_member_id: input.leadMemberId },
        event: { event_id: input.requestId, seq: 3, kind: "room.context_set", created_at: 1790852420, actor: { kind: "system", id: "room-control" }, payload: {} } };
    }
  },
  vaultRequest: async input => {
    switch (input.operation) {
      case "overview": return vault;
      case "add_login": return { id: "login-new" };
      case "remove_login": return { removed: true };
      case "answer": return { status: "ok" };
      case "source": case "unlock": case "lock": return { ok: true };
    }
  },
  integrationRequest: async input => {
    switch (input.operation) {
      case "list": return integrations;
      case "check": case "add_mcp": return connection;
      case "cancel": return { ...flow, status: "cancelled" };
      default: return flow;
    }
  },
  // The shared desktop as Hermes reports it; the server adds this person's terminal access.
  computerRequest: async () => ({ available: true, running: true, browserReady: true, label: "Household computer",
    control: { kind: "bot", name: "garden" }, terminal: { available: false, target: "" } }),
  close: async () => {},
} satisfies Runtime;
const upgrades: Pick<HermesUpgrades, "status" | "maintenance" | "revisionDate"> = { status: async () => upgrade, maintenance: () => false, revisionDate: () => undefined };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Replaces values that differ per run. The frozen clock already fixes server timestamps. */
function normalize(value: unknown, seen = new Map<string, string>()): unknown {
  if (Array.isArray(value)) return value.map(item => normalize(item, seen));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, ["token", "csrfToken", "formKey"].includes(key) && typeof item === "string" ? `normalized-${key}` : normalize(item, seen)]));
  if (typeof value === "string" && uuid.test(value) && !ourIds.has(value)) {
    if (!seen.has(value)) seen.set(value, `00000000-0000-4000-8000-${String(seen.size + 1).padStart(12, "0")}`);
    return seen.get(value);
  }
  return value;
}
function multipart(field: string, name: string, mime: string, body: string) {
  const boundary = "AgentInterfaceContract";
  return { headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n${body}\r\n--${boundary}--\r\n` };
}

afterEach(() => { vi.useRealTimers(); });

it("keeps the server responses the iOS app decodes in sync with the committed contract fixtures", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(now) });
  const config = loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" });
  config.apns = { teamId: "TEAM123456", keyId: "KEY1234567", topic: "dev.agentinterface.ios", privateKeyFile: "unused-by-contract-test", environment: "sandbox" };
  config.nativeApp = { latestBuild: 12, updateUrl: "https://testflight.apple.com/join/CONTRACT" };
  const tlsDirectory = mkdtempSync(join(tmpdir(), "contract-direct-"));
  config.directRoutes = { kinds: ["lan", "tailnet"], port: 0, stateDirectory: tlsDirectory };
  const { app, store, directRoutes } = await createApp(config, runtime, { background: false, sendApns: async () => {}, upgrades: upgrades as HermesUpgrades,
    directAddresses: () => [{ kind: "tailnet", address: "127.0.0.2" }, { kind: "lan", address: "127.0.0.1" }] });
  await directRoutes!.start(3_600_000);
  const fixtures = new Map<string, { request: string; response: unknown }>();
  try {
    const signIn = async (member: "one" | "two") => {
      const state = randomBytes(32).toString("base64url"), codeVerifier = randomBytes(32).toString("base64url");
      const query = new URLSearchParams({ state, code_challenge: createHash("sha256").update(codeVerifier).digest("base64url"), code_challenge_method: "S256" });
      const started = await app.inject(`/native/sign-in?${query}`);
      const completed = await app.inject({ method: "POST", url: "/api/auth/native/complete", headers: { origin, cookie: `native_flow=${started.cookies[0].value}` }, payload: { member } });
      const code = new URL(completed.json().callback).searchParams.get("code");
      return app.inject({ method: "POST", url: "/api/auth/native/exchange", payload: { code, state, codeVerifier } });
    };
    const exchange = await signIn("one");
    await signIn("two");
    const authorization = `Bearer ${exchange.json().token}`;
    const record = async (name: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = {}) => {
      expect(fixtures.has(name), `duplicate fixture ${name}`).toBe(false);
      const response = await app.inject({ method, url, payload: payload as string | object | undefined, headers: { authorization, ...headers } });
      expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(200);
      fixtures.set(name, { request: `${method} ${url}`, response: response.json() });
      return response.json();
    };
    const auth = await app.inject("/api/auth/config");
    fixtures.set("auth-config", { request: "GET /api/auth/config", response: auth.json() });
    fixtures.set("auth-native-exchange", { request: "POST /api/auth/native/exchange", response: exchange.json() });
    store.user({ id: "local-one", email: "one@localhost.invalid", name: "Local member one", picture: "https://lh3.googleusercontent.com/a/contract-fixture" });

    await record("preferences", "PATCH", "/api/preferences", preferences);
    await record("bot-avatar", "PUT", "/api/bots/household/avatar", bots[0].avatar);
    await record("bot-update", "PATCH", "/api/bots/household", { confirmModel: true, name: "Household", description: "Plans meals and errands", instructions: "Be concise.", model: "claude-sonnet",
      provider: "anthropic", enabledMcpServers: ["calendar"], shared: true });
    await record("bot-portrait", "POST", "/api/bots/household/portrait", { prompt: "A friendly kitchen helper" });
    const upload = multipart("file", "pantry.txt", "text/plain", "Rice, beans, basil");
    await record("bot-upload", "POST", "/api/bots/household/uploads", upload.payload, upload.headers);
    await record("connection-retry", "POST", "/api/connection/retry", {});
    await record("bootstrap", "GET", "/api/bootstrap?roster=lean");
    await record("models", "GET", "/api/models?botId=household");
    await record("bot-tools", "GET", "/api/bots/household/tools");
    await record("bot-skills", "GET", "/api/bots/household/skills");
    await record("bot-starters", "GET", "/api/bots/household/starters");

    await record("message-submit", "POST", "/api/bots/household/messages", { requestId: ids.submission, text: "Plan five dinners", attachments: [attached] });
    await record("submission", "GET", `/api/submissions/${ids.submission}`);
    await record("bot-draft-save", "PUT", "/api/bots/household/draft", { text: "Add basil", attachments: [attached], baseRevision: 1 });
    await record("bot-draft", "GET", "/api/bots/household/draft");
    const conflict = await app.inject({ method: "PUT", url: "/api/bots/household/draft", payload: { text: "Edited on an old copy", attachments: [], baseRevision: 0 }, headers: { authorization } });
    expect(conflict.statusCode).toBe(409);
    fixtures.set("bot-draft-conflict", { request: "PUT /api/bots/household/draft", response: conflict.json() });
    await record("bot-read-position", "PUT", "/api/bots/household/read-position", { messageId: "message-assistant", scrollTop: 240.5 });
    await record("bot-presence", "PUT", "/api/bots/household/presence", { client: "8F0C2F6E-1D7A-4D35-9B53-3C1E6E2F9A10", state: "active" });
    await record("conversation", "GET", "/api/bots/household/conversation");
    await record("bot-files", "GET", "/api/bots/household/files?before=message-assistant");
    const card = "/api/bots/household/messages/message-assistant/cards/groceries/state";
    await record("card-state-save", "PUT", card, { checkedIds: ["milk"], notes: {} });
    await record("card-state", "GET", card);
    const audio = multipart("audio", "voice.m4a", "audio/mp4", "fixture audio");
    await record("voice-transcript", "POST", "/api/bots/household/voice/transcribe", audio.payload, audio.headers);

    await record("routine-save", "PUT", "/api/routines/routine-morning", { botId: "household", name: "Morning brief", prompt: "Prepare a morning brief.", schedule: "0 7 * * *", enabled: true,
      recipientIds: ["local-one", "local-two"], roomIds: ["room-dinner"] });
    await record("routines", "GET", "/api/routines");
    await record("routine-templates", "GET", "/api/routines/templates");
    await record("routine-preview", "POST", "/api/routines/preview", { botId: "household", schedule: "0 7 * * *" });
    await record("routine-run", "POST", "/api/routines/routine-morning/run", { requestId: ids.run });
    await record("routine-run-receipt", "GET", `/api/routines/routine-morning/runs/${ids.run}`);
    await record("routine-results", "GET", "/api/bots/household/routines/routine-morning/results");
    await record("routine-output", "GET", "/api/bots/household/routines/routine-morning/results/result-1");

    store.recordEvents([event], "cursor-1");
    const today = await record("today", "GET", "/api/today");
    await record("today-seen", "PUT", "/api/today/seen", { seenAt: today.generatedAt, frontier: today.frontier });
    await record("memory", "GET", "/api/bots/household/memory");
    await record("memory-save", "PATCH", "/api/bots/household/memory/memory", { revision: "a".repeat(64), entries: [{ id: "b".repeat(64), text: "The household prefers vegetarian dinners." }] });

    await record("bot-automation", "GET", "/api/bots/household/automation");
    await record("bot-goal-resume", "POST", "/api/bots/household/automation/goal/resume", { requestId: ids.run });
    await record("bot-task", "POST", "/api/bots/household/automation/tasks", { requestId: ids.submission, title: automationTask.title,
      body: automationTask.body, priority: automationTask.priority, assignee: "garden", dependencies: automationTask.dependencies });
    await record("bot-trigger-create", "POST", "/api/bots/household/automation/triggers", { id: eventSubscription.id,
      description: eventSubscription.description, events: eventSubscription.events, routineId: eventSubscription.routineId });
    await record("bot-skill-diff", "GET", "/api/bots/household/automation/skills/pending/deadbeef");
    await record("bot-skill-content", "GET", "/api/bots/household/automation/skills/content?name=ranch%2Ffences");
    await record("bot-skill-lock", "PUT", "/api/bots/household/automation/skills/lock", { name: "ranch/fences", locked: false });
    await record("approval-settings", "GET", "/api/bots/household/approval-settings");
    await record("approval-settings-remove", "DELETE", "/api/bots/household/approval-settings/allowlist", { pattern: "recursive delete" });

    await record("search", "GET", "/api/search?q=dinner");
    await record("history", "GET", "/api/bots/household/history/session-household?offset=0");
    await record("saved-session", "POST", "/api/saved", { botId: "household", kind: "session", sessionId: "session-household", messageId: "message-assistant", offset: 0, title: "Five dinners" });
    await record("saved-routine", "POST", "/api/saved", { botId: "household", kind: "routine", routineId: "routine-morning", resultId: "result-1", title: "Dinner ideas" });
    await record("saved", "GET", "/api/saved");
    await record("automations", "GET", "/api/automations");
    await record("usage-accounts", "GET", "/api/usage/accounts");
    await record("usage-reset", "POST", `/api/usage/accounts/${accountKeys.chatgpt}/reset`, { confirmed: true, requestId: ids.operation, force: false });

    await record("groups", "GET", "/api/groups");
    await record("group-create", "POST", "/api/groups", { requestId: ids.group, name: "Dinner team", botIds: ["household", "garden"] });
    await record("group-state", "GET", "/api/groups/room-dinner");
    await record("group-log", "GET", "/api/groups/room-dinner/log?since=0");
    await record("group-log-state", "GET", "/api/groups/room-dinner/log?since=0&state=1");
    await record("group-message", "POST", "/api/groups/room-dinner/messages", { requestId: ids.groupMessage, threadId: "thread-1", text: "Plan dinners together" });
    await record("group-stop", "POST", "/api/groups/room-dinner/stop", { requestId: ids.groupStop });
    await record("group-context", "POST", "/api/groups/room-dinner/context", { requestId: ids.groupContext, purpose: "Plan the week's dinners.", notes: "No mushrooms.", leadMemberId: "garden" });
    await record("group-approve", "POST", "/api/groups/room-dinner/approve", { taskId: "task-1", memberId: "household", generation: 1, choice: "once", requestId: "approval-request-1" });

    await record("vault", "GET", "/api/bots/household/vault");
    await record("vault-login-add", "POST", "/api/bots/household/vault/logins", { label: "Grocer", origin: "https://grocer.example.test", identifierType: "email", identifier: "one@example.test", password: "fixture-password" });
    await record("vault-login-remove", "DELETE", "/api/bots/household/vault/logins/login-grocer");
    await record("vault-secure-answer", "POST", "/api/bots/household/secure-requests/secure-code", { epoch: "epoch-1", sessionId: "session-household", method: "vault.code", value: "123456" });

    await record("integrations", "GET", "/api/integrations?profile=household");
    await record("integration-connect", "POST", "/api/integrations/google-calendar/connect", { profile: "household", fields: { calendar: "primary" } });
    await record("integration-check", "POST", "/api/integrations/google-calendar/check", { profile: "household" });
    await record("integration-flow", "GET", `/api/integrations/flows/${flow.flowId}?profile=household`);
    await record("integration-callback", "POST", `/api/integrations/flows/${flow.flowId}/callback`, { profile: "household", callbackUrl: "http://127.0.0.1:3000/integrations/google/callback?state=fixture&code=fixture" });
    await record("integration-flow-cancel", "DELETE", `/api/integrations/flows/${flow.flowId}?profile=household`);
    await record("integration-mcp", "POST", "/api/integrations/mcp", { profile: "household", name: "recipes", url: "https://mcp.example.test/recipes", auth: "bearer", token: "fixture-token" });

    await record("upgrade", "GET", "/api/hermes/upgrade");
    await record("push-config", "GET", "/api/native/push/config");
    // Listeners take any free port and make a new key each run, so both are normalized.
    await record("native-routes", "GET", "/api/native/routes");
    for (const route of (fixtures.get("native-routes")!.response as { routes: { url: string; certificateSha256: string }[] }).routes) {
      route.url = route.url.replace(/:\d+$/, route.url.includes("127.0.0.1") ? ":3443" : ":3444");
      route.certificateSha256 = "q1Ue7mHzv1bS0n9yKXGJmWjv2sQxRZbL0dYc3Hc8V2E";
    }
    await record("computer", "GET", "/api/computer");
    // The terminal names this host's account and machine, which differ wherever the test runs.
    const computer = fixtures.get("computer")!.response as { terminal: { target: string } };
    if (computer.terminal.target) computer.terminal.target = "normalized-target";
    // The aggregate shows a run this person sent to and an assistant they follow, waiting first.
    store.participate("run-dinner", "local-one");
    store.savePreferences("local-one", { ...preferences, followBots: ["garden"] });
    await record("live-activity-register", "PUT", "/api/native/live-activity", { deviceId: "8F0C2F6E-1D7A-4D35-9B53-3C1E6E2F9A10", token: "ab".repeat(32), botIds: ["household"] });
    await record("live-activity", "GET", "/api/native/live-activity");
  } finally {
    await app.close();
    rmSync(tlsDirectory, { recursive: true, force: true });
  }

  const files = new Map([...fixtures].map(([name, fixture]) => [`${name}.json`, JSON.stringify(normalize(fixture), null, 2) + "\n"]));
  const committed = existsSync(directory) ? readdirSync(directory).filter(file => file.endsWith(".json")) : [];
  if (process.env.UPDATE_CONTRACT === "1") {
    mkdirSync(directory, { recursive: true });
    for (const file of committed.filter(file => !files.has(file))) rmSync(join(directory, file));
    for (const [file, text] of files) writeFileSync(join(directory, file), text);
    return;
  }
  const problems = [...committed.filter(file => !files.has(file)).map(file => `${file} is no longer generated`),
    ...[...files.keys()].filter(file => !committed.includes(file)).map(file => `${file} is missing`)];
  for (const [file, text] of files) {
    if (!committed.includes(file)) continue;
    const expected = JSON.parse(readFileSync(join(directory, file), "utf8"));
    if (isDeepStrictEqual(expected, JSON.parse(text))) continue;
    problems.push(`${file} changed`);
    expect.soft(JSON.parse(text), `${file} changed. ${instruction}`).toEqual(expected);
  }
  expect(problems, `The iOS contract fixtures are out of date. ${instruction}`).toEqual([]);
});
