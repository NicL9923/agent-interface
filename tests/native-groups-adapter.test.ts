import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Conflict, InvalidInput, NotFound } from "../src/shared/errors.js";
import type { ManagedBotRecord } from "../src/shared/harness.js";
import type {
  GroupCatalog,
  GroupMember,
  GroupPage,
  GroupRoom,
  GroupState,
} from "../src/shared/collaboration.js";
import { createNativeGroupAdapter } from "../src/server/harness/native-groups.js";
import { Store } from "../src/server/store.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup(
  executeTurn: (
    bot: ManagedBotRecord,
    prompt: string,
    signal: AbortSignal,
    roomId: string,
  ) => Promise<string> = async (bot) => `Reply from ${bot.name}`,
) {
  let clock = 1_790_000_000_000;
  const store = new Store(":memory:");
  store.user({ id: "one", email: "one@example.test", name: "Alice" });
  store.user({ id: "two", email: "two@example.test", name: "Bob" });
  store.managedBots.upsertCredential({
    id: "cred-1",
    label: "Test key",
    kind: "api_key",
    vendor: "openai",
    envVar: "TEST_API_KEY",
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
    enabledMcpServers: [],
    createdAt: clock,
    updatedAt: clock,
  });
  store.managedBots.upsertManagedBot(mkBot("alpha", "Alpha"));
  store.managedBots.upsertManagedBot(mkBot("beta", "Beta"));
  store.managedBots.upsertManagedBot(mkBot("gamma", "Gamma"));
  const adapter = createNativeGroupAdapter({ store, executeTurn, now: () => clock });
  cleanups.push(() => {
    adapter.close();
    store.close();
  });
  return {
    store,
    adapter,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const members: GroupMember[] = [
  { member_id: "alpha", profile: "alpha", handle: "alpha", display_name: "Alpha" },
  { member_id: "beta", profile: "beta", handle: "beta", display_name: "Beta" },
];

async function waitUntil(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

describe("native group adapter", () => {
  it("lists, creates idempotently, and refuses rooms with fewer than two assistants", async () => {
    const { adapter } = setup();
    expect(await adapter.handle({ operation: "list" })).toEqual({
      supported: true,
      canSend: true,
      settings: true,
      routineDelivery: true,
      rooms: [],
    });

    await expect(
      adapter.handle({
        operation: "create",
        roomId: "solo",
        name: "Solo",
        members: [members[0]],
        actorId: "one",
      }),
    ).rejects.toThrow(InvalidInput);

    const created = (await adapter.handle({
      operation: "create",
      roomId: "team-sync",
      name: "Team sync",
      members,
      actorId: "one",
    })) as { room: GroupRoom };
    expect(created.room).toMatchObject({
      room_id: "team-sync",
      name: "Team sync",
      latest_seq: 0,
    });
    expect(created.room.members.map((m) => m.display_name)).toEqual(["Alpha", "Beta"]);

    // Repeating create with the same roomId returns the existing room.
    const duplicate = await adapter.handle({
      operation: "create",
      roomId: "team-sync",
      name: "Ignored rename",
      members,
      actorId: "one",
    });
    expect(duplicate).toEqual(created);

    const catalog = (await adapter.handle({ operation: "list" })) as GroupCatalog;
    expect(catalog.rooms).toHaveLength(1);
    expect(catalog.rooms[0].room_id).toBe("team-sync");
  });

  it("sends new topics and thread replies, deduplicates by requestId, and emits GroupEvent wire format", async () => {
    const turns: { botId: string; prompt: string; roomId: string }[] = [];
    const { adapter, advance } = setup(async (bot, prompt, _signal, roomId) => {
      turns.push({ botId: bot.id, prompt, roomId });
      return `Ack from ${bot.name}`;
    });
    await adapter.handle({
      operation: "create",
      roomId: "r1",
      name: "Sync",
      members,
      actorId: "one",
    });

    const req1 = randomUUID();
    const sent = (await adapter.handle({
      operation: "send",
      roomId: "r1",
      requestId: req1,
      threadId: randomUUID(), // fresh client UUID for a new topic
      text: "Kick off the review",
      actorId: "one",
      actorName: "Alice",
    })) as { accepted: true; event: GroupPage["events"][number] };
    expect(sent.accepted).toBe(true);
    expect(sent.event).toMatchObject({
      seq: 1,
      kind: "message.user",
      created_at: 1_790_000_000,
      actor: { kind: "user", id: "one", display_name: "Alice" },
      sender: { id: "one", name: "Alice" },
      payload: { text: "Kick off the review", thread_id: sent.event.event_id },
    });

    // Wait for lead bot (alpha) to reply.
    await waitUntil(async () => {
      const page = (await adapter.handle({
        operation: "log",
        roomId: "r1",
        since: 0,
      })) as GroupPage;
      return page.events.length >= 2;
    }, "alpha reply");

    // Retrying with the same requestId returns the original event without triggering another turn.
    const retry = await adapter.handle({
      operation: "send",
      roomId: "r1",
      requestId: req1,
      threadId: randomUUID(),
      text: "Kick off the review",
      actorId: "one",
      actorName: "Alice",
    });
    expect(retry).toEqual(sent);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.roomId).toBe("r1");

    // Reply inside the existing thread using root event_id as threadId.
    advance(5_000);
    const reply = (await adapter.handle({
      operation: "send",
      roomId: "r1",
      requestId: randomUUID(),
      threadId: sent.event.event_id,
      text: "Follow up on thread",
      actorId: "two",
      actorName: "Bob",
    })) as { accepted: true; event: GroupPage["events"][number] };
    expect(reply.event.payload.thread_id).toBe(sent.event.event_id);

    await waitUntil(async () => {
      const page = (await adapter.handle({
        operation: "log",
        roomId: "r1",
        since: 0,
      })) as GroupPage;
      return page.events.length >= 4;
    }, "second alpha reply");

    const fullLog = (await adapter.handle({
      operation: "log",
      roomId: "r1",
      since: 0,
    })) as GroupPage;
    expect(fullLog.events.map((e) => [e.seq, e.kind, e.payload.thread_id])).toEqual([
      [1, "message.user", sent.event.event_id],
      [2, "message.member", sent.event.event_id],
      [3, "message.user", sent.event.event_id],
      [4, "message.member", sent.event.event_id],
    ]);
    expect(fullLog.events[1]).toMatchObject({
      kind: "message.member",
      actor: { kind: "member", id: "alpha", display_name: "Alpha" },
      payload: { text: "Ack from Alpha", member_id: "alpha", thread_id: sent.event.event_id },
    });
    expect(fullLog.cursor).toBe(4);
    expect(fullLog.latest_seq).toBe(4);
    expect(fullLog.has_more).toBe(false);

    // Cursor pagination returns only newer events.
    const incremental = (await adapter.handle({
      operation: "log",
      roomId: "r1",
      since: 2,
    })) as GroupPage;
    expect(incremental.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(incremental.cursor).toBe(4);
  });

  it("updates context, routes to everyone or a new lead, and injects shared notes into prompts", async () => {
    const seen: { botId: string; prompt: string }[] = [];
    const { adapter } = setup(async (bot, prompt) => {
      seen.push({ botId: bot.id, prompt });
      return `Done by ${bot.id}`;
    });
    await adapter.handle({
      operation: "create",
      roomId: "r2",
      name: "Ops",
      members,
      actorId: "one",
    });

    // Rejects a lead outside the room.
    await expect(
      adapter.handle({
        operation: "context",
        roomId: "r2",
        requestId: randomUUID(),
        purpose: "Bad lead",
        notes: "",
        routing: "lead",
        leadMemberId: "gamma",
      }),
    ).rejects.toThrow(InvalidInput);

    // Switch to everyone routing + shared notes.
    const updated = (await adapter.handle({
      operation: "context",
      roomId: "r2",
      requestId: randomUUID(),
      purpose: "Coordinate deploys",
      notes: "Always check backups first.",
      routing: "everyone",
      leadMemberId: "",
    })) as { context: GroupState["context"]; event: GroupPage["events"][number] };
    expect(updated.context).toEqual({
      purpose: "Coordinate deploys",
      notes: "Always check backups first.",
      routing: "everyone",
      lead_member_id: "",
    });
    expect(updated.event.kind).toBe("room.notice");

    await adapter.handle({
      operation: "send",
      roomId: "r2",
      requestId: randomUUID(),
      threadId: randomUUID(),
      text: "Check status",
      actorId: "one",
    });
    await waitUntil(async () => seen.length >= 2, "both bots to reply under everyone routing");
    expect(seen.map((s) => s.botId).sort()).toEqual(["alpha", "beta"]);
    expect(seen[0].prompt).toContain("# Shared room notes\nAlways check backups first.");

    // Switch back to lead routing with beta as lead.
    seen.length = 0;
    await adapter.handle({
      operation: "context",
      roomId: "r2",
      requestId: randomUUID(),
      purpose: "Coordinate deploys",
      notes: "",
      routing: "lead",
      leadMemberId: "beta",
    });
    const state = (await adapter.handle({ operation: "state", roomId: "r2" })) as GroupState;
    expect(state.context).toEqual({
      purpose: "Coordinate deploys",
      notes: "",
      routing: "lead",
      lead_member_id: "beta",
    });

    await adapter.handle({
      operation: "send",
      roomId: "r2",
      requestId: randomUUID(),
      threadId: randomUUID(),
      text: "Who is on call?",
      actorId: "one",
    });
    await waitUntil(async () => seen.length >= 1, "beta lead reply");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(seen.map((s) => s.botId)).toEqual(["beta"]);
    expect(seen[0].prompt).not.toContain("# Shared room notes");
  });

  it("reports live member activity while running, cancels on stop, and refuses approve or unknown rooms", async () => {
    let release!: () => void;
    const aborted = vi.fn();
    const { adapter } = setup(async (_bot, _prompt, signal) => {
      signal.addEventListener("abort", aborted);
      await new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener("abort", () => resolve());
      });
      return "stopped";
    });
    await adapter.handle({
      operation: "create",
      roomId: "r3",
      name: "Live",
      members,
      actorId: "one",
    });

    expect(
      await adapter.handle({ operation: "stop", roomId: "r3", requestId: randomUUID() }),
    ).toEqual({ cancelled: 0 });

    await adapter.handle({
      operation: "send",
      roomId: "r3",
      requestId: randomUUID(),
      threadId: randomUUID(),
      text: "Long task",
      actorId: "one",
    });
    await waitUntil(async () => {
      const state = (await adapter.handle({ operation: "state", roomId: "r3" })) as GroupState;
      return Boolean(state.driver_status?.running);
    }, "running state");

    const busy = (await adapter.handle({ operation: "state", roomId: "r3" })) as GroupState;
    expect(busy.driver_status).toMatchObject({
      running: true,
      working: true,
      blocked: false,
      member_activity: [{ member_id: "alpha", status: "running", round_index: 0 }],
    });

    expect(
      await adapter.handle({ operation: "stop", roomId: "r3", requestId: randomUUID() }),
    ).toEqual({ cancelled: 1 });
    expect(aborted).toHaveBeenCalledOnce();
    release();

    await waitUntil(async () => {
      const state = (await adapter.handle({ operation: "state", roomId: "r3" })) as GroupState;
      return !state.driver_status?.running;
    }, "idle state after stop");

    await expect(
      adapter.handle({
        operation: "approve",
        roomId: "r3",
        taskId: "t1",
        memberId: "alpha",
        generation: 1,
        choice: "once",
        requestId: randomUUID(),
      }),
    ).rejects.toThrow(Conflict);

    await expect(adapter.handle({ operation: "state", roomId: "missing" })).rejects.toThrow(
      NotFound,
    );
  });

  it("notifies watch listeners on messages, turn lifecycle, context updates, stop, and routines", async () => {
    let release!: () => void;
    const { adapter } = setup(async (_bot, _prompt, signal) => {
      await new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener("abort", () => resolve());
      });
      return "Done";
    });
    await adapter.handle({
      operation: "create",
      roomId: "r-watch",
      name: "Watch Room",
      members,
      actorId: "one",
    });

    const events: string[] = [];
    let runningAtLastEvent = false;
    const unwatch = adapter.watch("r-watch", () => {
      events.push("changed");
    });
    // Verify context update triggers watch.
    await adapter.handle({
      operation: "context",
      roomId: "r-watch",
      requestId: randomUUID(),
      purpose: "Watch test",
      notes: "Notes",
      routing: "lead",
      leadMemberId: "alpha",
    });
    expect(events).toHaveLength(1);

    // Send starts a discussion (message + turn_started), then finishing clears running before notifying.
    await adapter.handle({
      operation: "send",
      roomId: "r-watch",
      requestId: randomUUID(),
      threadId: randomUUID(),
      text: "Hello watchers",
      actorId: "one",
    });
    await waitUntil(async () => events.length >= 3, "message and turn_started notifications");
    const stateCheckUnsub = adapter.watch("r-watch", () => {
      void adapter.handle({ operation: "state", roomId: "r-watch" }).then((state) => {
        runningAtLastEvent = Boolean((state as GroupState).driver_status?.running);
      });
    });
    const beforeFinish = events.length;
    release();
    await waitUntil(async () => events.length >= beforeFinish + 2, "bot reply and round_finished");
    await waitUntil(async () => runningAtLastEvent === false, "running cleared at round_finished");
    stateCheckUnsub();

    // Routine delivery notifies watchers too.
    const beforeRoutine = events.length;
    adapter.deliverRoutine("r-watch", {
      routineId: "rt-1",
      routineName: "Daily check",
      text: "All green",
    });
    expect(events.length).toBeGreaterThan(beforeRoutine);

    // Unsubscribe stops further notifications and is idempotent.
    unwatch();
    unwatch();
    const afterUnsub = events.length;
    await adapter.handle({
      operation: "context",
      roomId: "r-watch",
      requestId: randomUUID(),
      purpose: "Quiet update",
      notes: "",
      routing: "lead",
      leadMemberId: "alpha",
    });
    expect(events.length).toBe(afterUnsub);
  });
});
