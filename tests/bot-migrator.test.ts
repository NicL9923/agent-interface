import { execFile } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { parseMigrationArgs } from "../scripts/migrate-bot.js";
import {
  migrateHermesBot,
  rollbackMigratedBot,
  type BotMigrationInput,
} from "../src/server/bot-migrator.js";
import { Store } from "../src/server/store.js";
import type { ManagedBotRecord } from "../src/shared/harness.js";
import { botFixture, conversationFixture, routineFixture } from "./helpers/runtime-fixtures.js";

const exec = promisify(execFile);
const botId = "assistant-one";
const ownerId = "owner-one";
const now = Date.parse("2026-11-23T12:00:00Z");
const hermesMessages = [
  { id: "hermes-user", role: "user", text: "Remember the inventory." },
  { id: "hermes-reply", role: "assistant", text: "Inventory saved." },
] as const;
const nativeMessages = [
  { id: "native-user", role: "user", text: "Add the new shipment." },
  { id: "native-reply", role: "assistant", text: "Added twelve boxes." },
  { id: "native-tool", role: "tool", text: "internal inventory tool trace" },
] as const;
const sourceBot = botFixture({
  id: botId,
  name: "Inventory",
  harness: "hermes",
  model: "old-model",
  shared: false,
  ownerId,
  instructions: "Keep an inventory.",
});
const sourceRoutines = [
  {
    ...routineFixture({ id: "morning", botId, name: "Morning report", prompt: "Report totals." }),
    timezone: "America/Chicago",
  },
  {
    ...routineFixture({ id: "weekly", botId, schedule: "every 7d", enabled: false }),
    timezone: "America/Chicago",
  },
];
const original: ManagedBotRecord = {
  id: botId,
  name: sourceBot.name,
  description: "",
  instructions: sourceBot.instructions!,
  harness: "hermes",
  model: sourceBot.model,
  provider: "old-provider",
  reasoning: "high",
  speed: "fast",
  ownerId,
  ownerOsUser: "wildbots",
  shared: false,
  credentialId: null,
  enabledTools: [],
  enabledSkills: [],
  enabledMcpServers: [],
  createdAt: now,
  updatedAt: now,
};

let dir: string;
let profile: string;
let rollbackDir: string;
let dbPath: string;
let store: Store;
let storeClosed: boolean;
const count = (table: string) =>
  store.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count;
const totalChanges = () => store.db.prepare("SELECT total_changes() AS count").get()?.count;
const nativeRoutines = () =>
  store.db
    .prepare(
      "SELECT name,kind,schedule_expr,timezone,prompt,enabled FROM native_routines WHERE bot_id=? ORDER BY name",
    )
    .all(botId);
const migrationArgs = () => [
  "--bot",
  botId,
  "--harness",
  "codex",
  "--model",
  "gpt-example",
  "--db",
  dbPath,
  "--hermes-profile-dir",
  profile,
  "--rollback-dir",
  rollbackDir,
  "--owner",
  ownerId,
];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wildbots-migration-"));
  profile = join(dir, "profile");
  rollbackDir = join(dir, "rollback");
  dbPath = join(dir, "wildbots.sqlite");
  store = new Store(dbPath);
  storeClosed = false;
  store.accounts.user({ id: ownerId, name: "Owner", email: "owner@example.test" });
  store.managedBots.upsertCredential({
    id: "openai-key",
    label: "OpenAI API",
    kind: "api_key",
    vendor: "openai",
    allowedHarnesses: ["codex"],
  });
  const skill = join(profile, "skills", "inventory");
  await mkdir(skill, { recursive: true });
  await Promise.all([
    writeFile(join(profile, "MEMORY.md"), "Inventory notes\n§\nKeep a backup.\n"),
    writeFile(join(profile, "USER.md"), "The user counts by the dozen.\n"),
    writeFile(join(profile, "config.yaml"), "timezone: America/Chicago\n"),
    writeFile(join(skill, "SKILL.md"), "---\nname: Inventory\n---\n# Count items\n"),
    writeFile(join(skill, "count.sh"), "#!/bin/sh\n"),
  ]);
});

afterEach(async () => {
  if (!storeClosed) store.close();
  await rm(dir, { recursive: true, force: true });
});

function migration(overrides: Partial<BotMigrationInput> = {}) {
  return migrateHermesBot({
    db: store.db,
    botId,
    harness: "codex",
    model: "gpt-example",
    bot: sourceBot,
    messages: hermesMessages,
    profileDir: profile,
    rollbackDir,
    readRoutines: async () => sourceRoutines,
    disableHermesRoutine() {
      throw new Error("Unexpected Hermes mutation");
    },
    ...overrides,
  });
}

describe("Hermes bot migration", () => {
  it("plans every import on a read-only database and never creates a rollback file", async () => {
    const changes = totalChanges();
    const readonly = new DatabaseSync(dbPath, { readOnly: true });
    const disable = vi.fn(() => {
      throw new Error("Dry run attempted a pause");
    });
    try {
      const result = await migration({ db: readonly, dryRun: true, disableHermesRoutine: disable });
      expect(result).toMatchObject({
        status: "dry_run",
        messageCount: 2,
        memoryEntries: 3,
        skills: 1,
        routineCount: 2,
        notImported: ["skills/inventory/count.sh"],
        policyErrors: [],
        routineErrors: [],
      });
      expect(totalChanges()).toBe(changes);
      expect(count("transcript_sync")).toBe(0);
      expect(count("bot_memory_revisions")).toBe(0);
      expect(count("bot_skill_revisions")).toBe(0);
      expect(store.managedBots.getManagedBot(botId)).toBeUndefined();
      expect(nativeRoutines()).toEqual([]);
      expect(disable).not.toHaveBeenCalled();
      await expect(readdir(rollbackDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      readonly.close();
    }
  });

  it("publishes history, memory, skills and schedules after recording every Hermes pause", async () => {
    const observer = new DatabaseSync(dbPath, { readOnly: true });
    const disable = vi.fn(async (_bot: string, routine: string) => {
      expect(observer.prepare("SELECT count(*) AS count FROM native_routines").get()?.count).toBe(
        0,
      );
      expect(observer.prepare("SELECT count(*) AS count FROM managed_bots").get()?.count).toBe(0);
      const [snapshotFile] = await readdir(rollbackDir);
      const snapshot = JSON.parse(await readFile(join(rollbackDir, snapshotFile), "utf8"));
      expect(
        snapshot.routines.find((row: { original: { id: string } }) => row.original.id === routine)
          .pause.state,
      ).toBe("attempting");
    });
    try {
      const result = await migration({ disableHermesRoutine: disable });
      expect(result.status).toBe("migrated");
      if (result.status !== "migrated") throw new Error(JSON.stringify(result));
      expect(result.pausedRoutines).toBe(2);
      expect(disable.mock.calls).toEqual([
        [botId, "morning"],
        [botId, "weekly"],
      ]);
      expect((await stat(result.snapshotPath)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(result.snapshotPath, "utf8"))).toMatchObject({
        originalBot: sourceBot,
        transcript: hermesMessages,
        memory: {
          imported: [
            "hermes-memory-001",
            "hermes-memory-002",
            "hermes-user-001",
            "skills/inventory",
          ],
          notImported: ["skills/inventory/count.sh"],
        },
        routines: sourceRoutines.map((routine) => ({
          original: routine,
          pause: { state: "confirmed" },
        })),
        receipt: { status: "migrated", harness: "codex", model: "gpt-example" },
      });
      expect(store.transcripts.syncState(botId)).toMatchObject({
        canonicalSource: "local",
        messageCount: 2,
      });
      expect(store.transcripts.listPage(botId, { limit: 10 }).messages).toMatchObject(
        hermesMessages,
      );
      expect(store.managedBots.runtimeIdForBot(botId)).toBe("harness");
      expect(store.managedBots.getManagedBot(botId)).toMatchObject({
        instructions: sourceBot.instructions,
        ownerId,
        shared: false,
        credentialId: "openai-key",
      });
      expect(
        store.db
          .prepare("SELECT kind,content FROM bot_memory_entries WHERE bot_id=? ORDER BY key")
          .all(botId),
      ).toEqual([
        { kind: "memory", content: "Inventory notes" },
        { kind: "memory", content: "Keep a backup." },
        { kind: "user", content: "The user counts by the dozen." },
      ]);
      expect(
        store.db.prepare("SELECT slug,body_markdown FROM bot_skills WHERE bot_id=?").get(botId),
      ).toEqual({
        slug: "inventory",
        body_markdown: "---\nname: Inventory\n---\n# Count items\n",
      });
      expect(nativeRoutines()).toEqual([
        {
          name: "Morning report",
          kind: "cron",
          schedule_expr: "0 7 * * *",
          timezone: "America/Chicago",
          prompt: "Report totals.",
          enabled: 1,
        },
        {
          name: "Routine",
          kind: "interval",
          schedule_expr: "604800000",
          timezone: "America/Chicago",
          prompt: "Report",
          enabled: 0,
        },
      ]);
    } finally {
      observer.close();
    }
  });

  it("refuses a shared subscription before reading source data or writing anything", async () => {
    store.managedBots.upsertCredential({
      id: "subscription",
      label: "Owner's login",
      kind: "subscription",
      vendor: "openai",
      ownerId,
      osUser: "wildbots",
      allowedHarnesses: ["codex"],
    });
    const changes = totalChanges();
    const disable = vi.fn();
    const readRoutines = vi.fn(async () => sourceRoutines);
    const invalid = {
      shared: true,
      credentialId: "subscription",
      disableHermesRoutine: disable,
      readRoutines,
    };
    await expect(migration(invalid)).rejects.toThrow("Use an API key credential for a shared bot.");
    expect(readRoutines).not.toHaveBeenCalled();
    expect(disable).not.toHaveBeenCalled();
    expect(totalChanges()).toBe(changes);
    await expect(readdir(rollbackDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(migration({ ...invalid, dryRun: true })).resolves.toMatchObject({
      status: "dry_run",
      messageCount: 2,
      routineCount: 2,
      policyErrors: ["Use an API key credential for a shared bot."],
    });
    expect(totalChanges()).toBe(changes);
  });

  it.each([
    [{ harness: "hermes" }, /Choose codex/],
    [{ model: "Inherited" }, /explicit native model/],
    [{ ownerId: "unknown" }, /owner who exists/],
    [{ credentialId: "missing" }, /credential that still exists/],
    [{ harness: "pi", credentialId: "openai-key" }, /supports the pi harness/],
  ])("refuses invalid configuration %j", async (configuration, reason) => {
    const changes = totalChanges();
    await expect(migration(configuration)).rejects.toThrow(reason);
    expect(totalChanges()).toBe(changes);
  });

  it("reports unsupported schedules in the plan and leaves the original routine alone", async () => {
    const disable = vi.fn();
    const readRoutines = async () => [
      { ...sourceRoutines[0], schedule: "when the warehouse opens" },
    ];
    const changes = totalChanges();
    await expect(
      migration({ readRoutines, disableHermesRoutine: disable, dryRun: true }),
    ).resolves.toMatchObject({
      routineErrors: [{ routineId: "morning", error: "Cron requires five fields." }],
    });
    await expect(migration({ readRoutines, disableHermesRoutine: disable })).rejects.toThrow(
      "morning: Cron requires five fields.",
    );
    expect(disable).not.toHaveBeenCalled();
    expect(totalChanges()).toBe(changes);
  });

  it("keeps native rows unpublished if a pause response fails and recovers uncertain pauses", async () => {
    const result = await migration({
      disableHermesRoutine(_bot, id) {
        if (id === "weekly") throw new Error("Hermes timed out");
      },
    });
    expect(result).toMatchObject({
      status: "needs_rollback",
      error: "Could not pause Hermes routine weekly: Hermes timed out",
    });
    if (result.status !== "needs_rollback") throw new Error(JSON.stringify(result));
    expect(store.managedBots.runtimeIdForBot(botId)).toBe("hermes");
    expect(store.transcripts.syncState(botId)).toBeUndefined();
    expect(nativeRoutines()).toEqual([]);
    expect(count("bot_memory_entries")).toBe(0);
    await expect(migration()).rejects.toThrow("already has a migration receipt");
    const resume = vi.fn();
    await expect(
      rollbackMigratedBot({
        db: store.db,
        snapshotPath: result.snapshotPath,
        reenableHermesRoutine: resume,
      }),
    ).resolves.toMatchObject({ status: "rolled_back", resumedRoutines: 1 });
    expect(resume.mock.calls).toEqual([[botId, "morning"]]);
    expect(JSON.parse(await readFile(result.snapshotPath, "utf8")).routines[1].pause).toEqual({
      state: "failed",
      error: "Hermes timed out",
    });
  });

  it("restores Hermes routing and history, backs up native turns and retries only failed resumes", async () => {
    store.managedBots.upsertManagedBot(original);
    const configured = store.managedBots.getManagedBot(botId);
    const alwaysEnabled = { ...sourceRoutines[1], enabled: true };
    const result = await migration({
      disableHermesRoutine() {},
      messages: undefined,
      readConversation: async () =>
        conversationFixture({
          botId,
          requestSessionId: "live",
          messages: [
            ...hermesMessages,
            { id: "live-inflight", role: "assistant", text: "Transient text" },
          ],
        }),
      readRoutines: async () => [sourceRoutines[0], alwaysEnabled],
    });
    if (result.status !== "migrated") throw new Error(JSON.stringify(result));
    store.transcripts.appendMessages(botId, nativeMessages, "harness");
    let fail = true;
    const resume = vi.fn((_bot: string, id: string) => {
      expect(nativeRoutines()).toHaveLength(0);
      expect(store.managedBots.runtimeIdForBot(botId)).toBe("hermes");
      expect(store.transcripts.syncState(botId)?.canonicalSource).toBe("hermes");
      if (fail && id === "weekly") throw new Error("Hermes is offline");
    });
    const input = {
      db: store.db,
      snapshotPath: result.snapshotPath,
      reenableHermesRoutine: resume,
    };
    await chmod(result.snapshotPath, 0o644);
    await expect(rollbackMigratedBot(input)).rejects.toThrow("owner-only file with mode 0600");
    expect(resume).not.toHaveBeenCalled();
    expect(store.transcripts.syncState(botId)?.canonicalSource).toBe("local");
    await chmod(result.snapshotPath, 0o600);
    const first = await rollbackMigratedBot(input);
    expect(first).toMatchObject({
      status: "needs_rollback",
      failures: [{ routineId: "weekly", error: "Hermes is offline" }],
    });
    expect(first.summary).toContain("Add the new shipment.");
    expect(first.summary).toContain("Added twelve boxes.");
    expect(first.summary).not.toContain("internal inventory tool trace");
    expect(first.summary).not.toContain("Transient text");
    expect(store.managedBots.getManagedBot(botId)).toEqual(configured);
    expect(store.transcripts.listPage(botId, { limit: 10 }).messages).toMatchObject(hermesMessages);
    fail = false;
    const final = await rollbackMigratedBot(input);
    expect(final).toMatchObject({
      status: "rolled_back",
      summary: first.summary,
      resumedRoutines: 2,
    });
    expect(await rollbackMigratedBot(input)).toEqual(final);
    expect(resume.mock.calls).toEqual([
      [botId, "morning"],
      [botId, "weekly"],
      [botId, "weekly"],
    ]);
    expect(JSON.parse(await readFile(result.snapshotPath, "utf8")).rollback.messages).toMatchObject(
      nativeMessages,
    );
  });
});

describe("migration CLI", () => {
  it("parses the two modes and rejects unknown flags, missing inputs and mixed modes", () => {
    expect(parseMigrationArgs([...migrationArgs(), "--dry-run", "--json"])).toMatchObject({
      action: "migrate",
      botId,
      harness: "codex",
      dryRun: true,
      db: dbPath,
      json: true,
    });
    expect(parseMigrationArgs(["--rollback", "before.json", "--db", dbPath])).toEqual({
      action: "rollback",
      db: dbPath,
      json: false,
      snapshotPath: "before.json",
    });
    expect(() => parseMigrationArgs(["--db", dbPath])).toThrow("Provide --bot.");
    expect(() =>
      parseMigrationArgs(["--rollback", "before.json", "--db", dbPath, "--shared"]),
    ).toThrow("--shared cannot be combined with --rollback.");
    expect(() => parseMigrationArgs(["--typo"])).toThrow(/Unknown option/);
  });

  it("runs the JSON dry-run, live migration and rollback through the CLI", async () => {
    store.close();
    storeClosed = true;
    const before = await readFile(dbPath);
    const requests: string[] = [];
    let enabled = true;
    const listRoute = `GET /api/cron/jobs?profile=${botId}`;
    const switchRoute = (action: "pause" | "resume") =>
      `POST /api/cron/jobs/morning/${action}?profile=${botId}`;
    const server = createServer((request, response) => {
      const route = `${request.method} ${request.url}`;
      requests.push(route);
      response.setHeader("content-type", "application/json");
      if (route === switchRoute("pause") || route === switchRoute("resume")) {
        enabled = route === switchRoute("resume");
        response.end(JSON.stringify({ job: { enabled, state: enabled ? "scheduled" : "paused" } }));
        return;
      }
      if (route !== listRoute) {
        response.writeHead(404).end();
        return;
      }
      response.end(
        JSON.stringify([
          {
            id: "morning",
            name: "Morning report",
            prompt: "Report totals.",
            enabled,
            schedule_display: "every day at 7am",
            schedule: { kind: "cron", expr: "0 7 * * *" },
          },
        ]),
      );
    });
    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const frame = Array.isArray(raw)
          ? Buffer.concat(raw)
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw)
            : raw;
        const { method, id } = JSON.parse(frame.toString("utf8"));
        const results = {
          "client.capabilities": {},
          "agent-interface.capabilities": {
            revision: "b9cb268deffc97946ec11645aa622a7353dd0591",
            durable_admission: true,
            durable_events: true,
            canonical_open: true,
            executor_epoch: "test",
          },
          "profiles.list": {
            profiles: [
              { name: botId, ui_meta: { agent_interface: { name: "Inventory", shared: false } } },
            ],
          },
          "profiles.describe": { toolsets: [], skills: [] },
          "agent-interface.open": {
            session_id: "live-one",
            canonical_stored_session_id: "stored-one",
            info: { running: false },
            messages: hermesMessages.map((row) => ({
              id: row.id,
              role: row.role,
              content: row.text,
            })),
          },
        };
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            ...(Object.hasOwn(results, method)
              ? { result: results[method as keyof typeof results] }
              : { error: { code: -32601, message: `Unexpected RPC ${method}` } }),
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const { port } = server.address() as AddressInfo;
      const root = fileURLToPath(new URL("../", import.meta.url));
      const run = async (args: string[]) => {
        const { stdout } = await exec(
          join(root, "node_modules", ".bin", "tsx"),
          [join(root, "scripts", "migrate-bot.ts"), ...args, "--json"],
          {
            cwd: dir,
            env: {
              ...process.env,
              HERMES_URL: `http://127.0.0.1:${port}`,
              HERMES_TOKEN: "fixture-token",
              HERMES_AUTH_MODE: "static",
              HERMES_QUALIFICATION_FILE: "",
              HERMES_TIMEZONE: "",
            },
            timeout: 8_000,
          },
        );
        return JSON.parse(stdout);
      };
      expect(await run([...migrationArgs(), "--dry-run"])).toMatchObject({
        status: "dry_run",
        messageCount: 2,
        memoryEntries: 3,
        skills: 1,
        routineCount: 1,
        policyErrors: [],
        routineErrors: [],
        notImported: ["skills/inventory/count.sh"],
        notImportedCount: 1,
      });
      expect(requests).toEqual([listRoute]);
      expect(await readFile(dbPath)).toEqual(before);
      await expect(readdir(rollbackDir)).rejects.toMatchObject({ code: "ENOENT" });

      const migrated = await run(migrationArgs());
      expect(migrated).toMatchObject({ status: "migrated", pausedRoutines: 1 });
      expect(enabled).toBe(false);
      const observer = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(
          observer.prepare("SELECT kind,schedule_expr,timezone FROM native_routines").get(),
        ).toEqual({
          kind: "cron",
          schedule_expr: "0 7 * * *",
          timezone: "America/Chicago",
        });
        expect(await run(["--rollback", migrated.snapshotPath, "--db", dbPath])).toMatchObject({
          status: "rolled_back",
          resumedRoutines: 1,
          summary: "No new native turns.",
        });
        expect(
          observer.prepare("SELECT canonical_source FROM transcript_sync WHERE bot_id=?").get(botId)
            ?.canonical_source,
        ).toBe("hermes");
        expect(
          observer.prepare("SELECT harness FROM managed_bots WHERE id=?").get(botId),
        ).toBeUndefined();
        expect(
          observer.prepare("SELECT id FROM native_routines WHERE bot_id=?").get(botId),
        ).toBeUndefined();
      } finally {
        observer.close();
      }
      expect(enabled).toBe(true);
      expect(requests).toEqual([
        listRoute,
        listRoute,
        switchRoute("pause"),
        listRoute,
        switchRoute("resume"),
      ]);
    } finally {
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      server.close();
      await once(server, "close");
    }
  });
});
