import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDirectVoiceService, DIRECT_VOICE_UNCONFIGURED } from "../src/server/direct-voice.js";
import {
  GroupCoordinator,
  NativeGroupRepository,
  parseMentions,
  type GroupRoomEvent,
  type GroupTurnInput,
  type NativeGroupRoomInput,
} from "../src/server/group-coordinator.js";
import { ManagedBotRepository } from "../src/server/store-bots.js";
import { StoreDatabase } from "../src/server/store-database.js";
import { Conflict, InvalidInput, NotFound } from "../src/shared/errors.js";
import type { CredentialRecord, ManagedBotRecord } from "../src/shared/harness.js";
import type { RealtimeSessionInput } from "../src/shared/types.js";

const KEY = "sk-test-household-key-1234";

type Recorded = { method: string; url: string; headers: IncomingMessage["headers"]; body: Buffer };
type Handler = (request: Recorded, response: ServerResponse) => void;

/** A loopback OpenAI. A route the test did not configure is recorded and fails the test. */
class FakeOpenAI {
  server!: Server;
  requests: Recorded[] = [];
  unexpected: string[] = [];
  routes = new Map<string, Handler>();
  get baseUrl() {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async start() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const recorded = {
          method: req.method!,
          url: req.url!,
          headers: req.headers,
          body: Buffer.concat(chunks),
        };
        this.requests.push(recorded);
        const handler = this.routes.get(`${req.method} ${req.url}`);
        if (!handler) {
          this.unexpected.push(`${req.method} ${req.url}`);
          res.writeHead(404).end();
          return;
        }
        handler(recorded, res);
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
  }
  async stop() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const json = (status: number, value: unknown) => (_: Recorded, res: ServerResponse) =>
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));

const session: RealtimeSessionInput = {
  voice: "cedar",
  instructions: "You are the speaking voice of Scout.",
  tools: [
    {
      type: "function",
      name: "ask_assistant",
      description: "Send the request on.",
      parameters: { type: "object", properties: {} },
    },
  ],
};

const refusal = (statusCode: number, message: string | RegExp) =>
  expect.objectContaining({
    statusCode,
    message: typeof message === "string" ? message : expect.stringMatching(message),
  });

describe("direct OpenAI voice", () => {
  const openai = new FakeOpenAI();
  beforeEach(async () => {
    openai.requests = [];
    openai.unexpected = [];
    openai.routes.clear();
    await openai.start();
  });
  afterEach(async () => {
    await openai.stop();
    expect(openai.unexpected).toEqual([]);
  });
  const service = (options: Parameters<typeof createDirectVoiceService>[0] = {}) =>
    createDirectVoiceService({ apiKey: KEY, baseUrl: `${openai.baseUrl}/`, ...options });

  it("reports unavailable without a key and refuses every call before contacting OpenAI", async () => {
    const voice = createDirectVoiceService({
      env: { OPENAI_API_KEY: "  " },
      baseUrl: openai.baseUrl,
    });
    expect(voice.status()).toEqual({ available: false, reason: DIRECT_VOICE_UNCONFIGURED });
    await expect(voice.realtimeSession(session)).rejects.toEqual(
      refusal(409, DIRECT_VOICE_UNCONFIGURED),
    );
    await expect(
      voice.transcribeVoice("scout", { mime: "audio/webm", data: Buffer.from("a") }),
    ).rejects.toEqual(refusal(409, DIRECT_VOICE_UNCONFIGURED));
    await expect(voice.synthesizeVoice("scout", "Hello")).rejects.toEqual(
      refusal(409, DIRECT_VOICE_UNCONFIGURED),
    );
    expect(openai.requests).toEqual([]);
  });

  it("reads the key from OPENAI_API_KEY and reports available without contacting OpenAI", () => {
    const voice = createDirectVoiceService({
      env: { OPENAI_API_KEY: KEY },
      baseUrl: openai.baseUrl,
    });
    expect(voice.status()).toEqual({ available: true });
    expect(JSON.stringify(voice.status())).not.toContain(KEY);
    expect(openai.requests).toEqual([]);
  });

  it("mints a Realtime client secret with the session and returns a Talk session", async () => {
    openai.routes.set(
      "POST /v1/realtime/client_secrets",
      json(200, { value: "ek_browser_secret", expires_at: 1_900_000_000 }),
    );
    const talk = await service({ secretTtlSeconds: 300 }).realtimeSession(session);
    expect(talk).toEqual({
      clientSecret: "ek_browser_secret",
      expiresAt: 1_900_000_000,
      model: "gpt-realtime-2.1",
      voice: "cedar",
    });
    const [request] = openai.requests;
    expect(request!.headers.authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(request!.body.toString()) as Record<string, any>;
    expect(body.expires_after).toEqual({ anchor: "created_at", seconds: 300 });
    expect(body.session).toMatchObject({
      type: "realtime",
      model: "gpt-realtime-2.1",
      instructions: session.instructions,
      audio: { output: { voice: "cedar" } },
      tools: session.tools,
    });
  });

  it("accepts a secret nested under client_secret and refuses an unreadable one", async () => {
    let answer: unknown = { client_secret: { value: "ek_nested_secret", expires_at: 42 } };
    openai.routes.set("POST /v1/realtime/client_secrets", (r, res) => json(200, answer)(r, res));
    await expect(service().realtimeSession(session)).resolves.toMatchObject({
      clientSecret: "ek_nested_secret",
      expiresAt: 42,
    });
    answer = { value: "has space secret", expires_at: 42 };
    await expect(service().realtimeSession(session)).rejects.toEqual(
      refusal(502, "OpenAI returned an unreadable voice session."),
    );
  });

  it("refuses a session request it would not send", async () => {
    const voice = service();
    await expect(voice.realtimeSession({ ...session, voice: "nova" as never })).rejects.toEqual(
      refusal(400, "Choose one of the supported voices."),
    );
    await expect(voice.realtimeSession({ ...session, instructions: " " })).rejects.toEqual(
      refusal(400, /Voice instructions must be/),
    );
    const tool = session.tools[0]!;
    await expect(
      voice.realtimeSession({ ...session, tools: [{ ...tool, name: "bad name" }] }),
    ).rejects.toEqual(refusal(400, /named function/));
    await expect(
      voice.realtimeSession({ ...session, tools: Array.from({ length: 5 }, () => tool) }),
    ).rejects.toEqual(refusal(400, /at most 4/));
    expect(openai.requests).toEqual([]);
  });

  it("maps OpenAI failures to fixed sentences that never carry the key or the response body", async () => {
    let status = 500;
    openai.routes.set("POST /v1/realtime/client_secrets", (_, res) =>
      res
        .writeHead(status, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY} raw-body` } })),
    );
    for (const [upstream, expected] of [
      [500, refusal(502, "OpenAI could not handle the voice request (HTTP 500).")],
      [401, refusal(502, "OpenAI refused the configured API key. Check OPENAI_API_KEY.")],
      [429, refusal(503, "OpenAI is limiting voice requests right now. Try again shortly.")],
    ] as const) {
      status = upstream;
      const error = (await service()
        .realtimeSession(session)
        .catch((caught: unknown) => caught)) as Error;
      expect(error).toEqual(expected);
      expect(JSON.stringify([error.message, Object.entries(error)])).not.toMatch(
        new RegExp(`${KEY}|raw-body`),
      );
    }
  });

  it("gives up on an OpenAI request that does not answer in time", async () => {
    openai.routes.set("POST /v1/realtime/client_secrets", () => undefined);
    await expect(service({ timeoutMs: 50 }).realtimeSession(session)).rejects.toEqual(
      refusal(504, "OpenAI did not answer the voice request in time. Try again."),
    );
  });

  it("transcribes a recording as multipart with the configured model", async () => {
    openai.routes.set(
      "POST /v1/audio/transcriptions",
      json(200, { text: "  Turn on the porch light. " }),
    );
    const audio = Buffer.from("OggS-fake-audio-bytes");
    await expect(
      service({ sttModel: "whisper-1" }).transcribeVoice("scout", {
        mime: "audio/ogg; codecs=opus",
        data: audio,
      }),
    ).resolves.toEqual({ text: "Turn on the porch light.", provider: "openai" });
    const [request] = openai.requests;
    expect(request!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(request!.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    const body = request!.body.toString("latin1");
    expect(body).toMatch(/name="model"\r\n\r\nwhisper-1\r\n/);
    expect(body).toContain('filename="recording.ogg"');
    expect(body).toContain("Content-Type: audio/ogg");
    expect(body).toContain(audio.toString("latin1"));
  });

  it("refuses an unsupported or empty recording and an invalid transcript", async () => {
    const voice = service();
    await expect(
      voice.transcribeVoice("scout", { mime: "image/png", data: Buffer.from("x") }),
    ).rejects.toEqual(refusal(415, /Choose a WebM/));
    await expect(
      voice.transcribeVoice("scout", { mime: "audio/webm", data: Buffer.alloc(0) }),
    ).rejects.toEqual(refusal(400, "This audio recording is empty."));
    expect(openai.requests).toEqual([]);
    openai.routes.set("POST /v1/audio/transcriptions", json(200, { transcript: "wrong field" }));
    await expect(
      voice.transcribeVoice("scout", { mime: "audio/webm", data: Buffer.from("x") }),
    ).rejects.toEqual(refusal(502, "OpenAI returned an invalid transcript."));
  });

  it("synthesizes speech as MP3 with the chosen voice", async () => {
    const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x44, 1, 2, 3]);
    openai.routes.set("POST /v1/audio/speech", (_, res) =>
      res.writeHead(200, { "Content-Type": "audio/mpeg" }).end(mp3),
    );
    const result = await service({ ttsModel: "tts-1" }).synthesizeVoice(
      "scout",
      " Hello there ",
      "sage",
    );
    expect(result).toEqual({ data: mp3, mime: "audio/mpeg", provider: "openai" });
    expect(JSON.parse(openai.requests[0]!.body.toString())).toEqual({
      model: "tts-1",
      input: "Hello there",
      voice: "sage",
      response_format: "mp3",
    });
  });

  it("refuses empty speech text, an unknown voice, and an empty audio reply", async () => {
    const voice = service();
    await expect(voice.synthesizeVoice("scout", "  ")).rejects.toEqual(refusal(400, /with text/));
    await expect(voice.synthesizeVoice("scout", "Hi", "onyx" as never)).rejects.toEqual(
      refusal(400, "Choose one of the supported voices."),
    );
    expect(openai.requests).toEqual([]);
    openai.routes.set("POST /v1/audio/speech", (_, res) => res.writeHead(200).end());
    await expect(voice.synthesizeVoice("scout", "Hi")).rejects.toEqual(
      refusal(502, "OpenAI did not return a supported audio reply under 8 MB."),
    );
    expect(JSON.parse(openai.requests[0]!.body.toString()).voice).toBe("marin");
  });
});

const householdKey: CredentialRecord = {
  id: "household-key",
  label: "Household key",
  vendor: "openai",
  kind: "api_key",
  allowedHarnesses: ["codex", "claude-code"],
  envVar: "OPENAI_API_KEY",
  createdAt: 1,
  updatedAt: 1,
};
const aliceSubscription: CredentialRecord = {
  id: "alice-plan",
  label: "Alice's plan",
  vendor: "anthropic",
  kind: "subscription",
  ownerId: "alice",
  allowedHarnesses: ["claude-code"],
  osUser: "alice",
  createdAt: 1,
  updatedAt: 1,
};
const bot = (
  id: string,
  name: string,
  fields: Partial<ManagedBotRecord> = {},
): ManagedBotRecord => ({
  id,
  name,
  description: "",
  instructions: "",
  harness: "codex",
  model: "m",
  provider: "openai",
  reasoning: "medium",
  speed: "normal",
  ownerId: "alice",
  ownerOsUser: "alice",
  shared: true,
  credentialId: householdKey.id,
  enabledTools: [],
  enabledSkills: [],
  enabledMcpServers: [],
  createdAt: 1,
  updatedAt: 1,
  ...fields,
});

describe("native group chats", () => {
  let database: StoreDatabase;
  let groups: NativeGroupRepository;
  beforeEach(() => {
    database = new StoreDatabase(":memory:");
    const bots = new ManagedBotRepository(database);
    bots.upsertCredential(householdKey);
    bots.upsertCredential(aliceSubscription);
    bots.upsertManagedBot(bot("scout", "Scout"));
    bots.upsertManagedBot(bot("sage", "Research Sage"));
    bots.upsertManagedBot(bot("ranger", "Ranger"));
    bots.upsertManagedBot(
      bot("alice-claude", "Alice Claude", {
        harness: "claude-code",
        shared: false,
        credentialId: aliceSubscription.id,
      }),
    );
    bots.upsertManagedBot(bot("alice-key", "Alice Key", { shared: false }));
    groups = new NativeGroupRepository(database, bots);
  });
  afterEach(() => database.close());

  const household = (fields: { maxRounds?: number; memberBotIds?: string[] } = {}) =>
    groups.createRoom({
      id: "porch",
      name: " Porch ",
      leadBotId: "scout",
      memberBotIds: ["scout", "sage", "ranger"],
      createdBy: "bob",
      ...fields,
    });

  it("creates, lists, updates and archives rooms", () => {
    const room = household();
    expect(room).toMatchObject({
      name: "Porch",
      leadBotId: "scout",
      maxRounds: 4,
      createdBy: "bob",
    });
    const personal = groups.createRoom({
      id: "alice-desk",
      name: "Desk",
      leadBotId: "alice-key",
      memberBotIds: ["alice-key", "alice-claude"],
      createdBy: "alice",
    });
    expect(groups.listRooms("bob").map((r) => r.id)).toEqual(["porch"]);
    expect(groups.listRooms("alice").map((r) => r.id)).toEqual(["porch", "alice-desk"]);

    const updated = groups.updateRoom("porch", {
      name: "Front porch",
      maxRounds: 2,
      leadBotId: "sage",
    });
    expect(updated).toMatchObject({ name: "Front porch", maxRounds: 2, leadBotId: "sage" });
    expect(groups.removeMember("porch", "ranger").memberBotIds).toEqual(["scout", "sage"]);
    expect(groups.addMember("porch", "ranger").memberBotIds).toEqual(["scout", "sage", "ranger"]);
    expect(() => groups.removeMember("porch", "sage")).toThrow(
      new InvalidInput("Choose another lead before removing this assistant."),
    );

    expect(groups.archiveRoom(personal.id)).toBe(true);
    expect(groups.archiveRoom(personal.id)).toBe(false);
    expect(groups.listRooms().map((r) => r.id)).toEqual(["porch"]);
    expect(() => groups.updateRoom(personal.id, { name: "Back" })).toThrow(NotFound);
  });

  it("refuses rooms with a bad lead, member list, turn limit or unseen assistant", () => {
    const base = {
      name: "Room",
      leadBotId: "scout",
      memberBotIds: ["scout", "sage"],
      createdBy: "bob",
    };
    for (const [input, message] of [
      [{ leadBotId: "ranger" }, /Choose a lead/],
      [{ memberBotIds: ["scout"] }, /Choose 2 to 12 different/],
      [{ memberBotIds: ["scout", "scout"] }, /Choose 2 to 12 different/],
      [{ maxRounds: 0 }, /Allow 1 to 12/],
      [{ maxRounds: 13 }, /Allow 1 to 12/],
      [{ name: "  " }, /Name the group chat/],
      // Bob cannot see Alice's personal assistant, so he cannot put it in a room.
      [{ memberBotIds: ["scout", "alice-key"] }, /still exist/],
      [{ memberBotIds: ["scout", "missing"] }, /still exist/],
    ] as [Partial<NativeGroupRoomInput>, RegExp][])
      expect(() => groups.createRoom({ ...base, ...input })).toThrow(message);
    expect(groups.listRooms()).toEqual([]);
  });

  it("refuses a subscription-backed personal bot in a household room", () => {
    const message = "Use a bot with an API key credential in a group chat with other members.";
    // Alice's own subscription bot next to a shared assistant: the room is the household's.
    expect(() =>
      groups.createRoom({
        name: "Kitchen",
        leadBotId: "scout",
        memberBotIds: ["scout", "alice-claude"],
        createdBy: "alice",
      }),
    ).toThrow(new Conflict(message));
    const room = groups.createRoom({
      name: "Kitchen",
      leadBotId: "scout",
      memberBotIds: ["scout", "alice-key"],
      createdBy: "alice",
    });
    expect(() => groups.addMember(room.id, "alice-claude")).toThrow(new Conflict(message));
    expect(groups.getRoom(room.id)!.memberBotIds).toEqual(["scout", "alice-key"]);
    // Among only Alice's own personal bots, her subscription may answer.
    expect(
      groups.createRoom({
        name: "Desk",
        leadBotId: "alice-claude",
        memberBotIds: ["alice-claude", "alice-key"],
        createdBy: "alice",
      }).memberBotIds,
    ).toEqual(["alice-claude", "alice-key"]);
  });

  it("parses @id and @name mentions but not e-mail addresses", () => {
    const members = [
      { id: "scout", name: "Scout" },
      { id: "sage", name: "Research Sage" },
    ];
    expect(parseMentions("@ResearchSage then @SCOUT, and @sage again", members)).toEqual([
      "sage",
      "scout",
    ]);
    expect(parseMentions("mail bob@scout.example or @nobody", members)).toEqual([]);
  });

  /** An executor that answers from a script per bot and records every turn it was given. */
  const scripted = (replies: Record<string, (turn: GroupTurnInput) => string>) => {
    const turns: GroupTurnInput[] = [];
    const executeTurn = async (turn: GroupTurnInput) => {
      turns.push(turn);
      const reply = replies[turn.bot.id];
      if (!reply) throw new Error(`unexpected turn for ${turn.bot.id}`);
      return { text: reply(turn) };
    };
    return { turns, executeTurn };
  };
  const person = { userId: "bob", userName: "Bob" };

  it("routes a message to the bots it names, or to the lead when it names none", async () => {
    household();
    const fake = scripted({ scout: () => "Scout here.", sage: () => "Sage here." });
    const coordinator = new GroupCoordinator({ repository: groups, executeTurn: fake.executeTurn });

    const plain = coordinator.sendHumanMessage("porch", { ...person, text: "Anyone around?" });
    expect(plain.message.mentions).toEqual([]);
    expect(await plain.round).toMatchObject({ reason: "settled", turns: 1 });
    expect(fake.turns.map((t) => t.bot.id)).toEqual(["scout"]);

    fake.turns.length = 0;
    const named = coordinator.sendHumanMessage("porch", {
      ...person,
      text: "@ResearchSage and @scout?",
    });
    expect(named.message.mentions).toEqual(["sage", "scout"]);
    const result = await named.round;
    expect(result.replies.map((m) => [m.senderId, m.round])).toEqual([
      ["sage", 1],
      ["scout", 2],
    ]);
    expect(fake.turns.map((t) => t.bot.id)).toEqual(["sage", "scout"]);
    // The second turn reads the first one's reply.
    expect(fake.turns[1]!.transcript.map((m) => m.text)).toEqual([
      "Anyone around?",
      "Scout here.",
      "@ResearchSage and @scout?",
      "Sage here.",
    ]);
    expect(fake.turns[1]!.prompt).toContain("🤖 Research Sage: Sage here.");
    expect(fake.turns[1]!.prompt).toContain("Bob: @ResearchSage and @scout?");
  });

  it("hands off between bots by mention and stops at the room's turn limit", async () => {
    household({ maxRounds: 3 });
    const fake = scripted({
      scout: () => "@scout here. Over to you @sage",
      sage: () => "Back to you @scout",
    });
    const events: GroupRoomEvent[] = [];
    const coordinator = new GroupCoordinator({ repository: groups, executeTurn: fake.executeTurn });
    const unsubscribe = coordinator.subscribe("porch", (event) => events.push(event));
    const result = await coordinator.sendHumanMessage("porch", { ...person, text: "Debate it" })
      .round;
    unsubscribe();

    // Three turns exactly: the cap is the behavior that ends bot-to-bot ping-pong.
    expect(fake.turns.map((t) => t.bot.id)).toEqual(["scout", "sage", "scout"]);
    expect(result).toMatchObject({ reason: "max_rounds", turns: 3 });
    expect(fake.turns[1]!.trigger.senderId).toBe("scout");
    const saved = groups.listMessages("porch");
    expect(saved.map((m) => [m.senderKind, m.senderId, m.round])).toEqual([
      ["human", "bob", 0],
      ["bot", "scout", 1],
      ["bot", "sage", 2],
      ["bot", "scout", 3],
      ["system", "porch", 3],
    ]);
    expect(saved[1]!.mentions).toEqual(["sage"]);
    expect(saved.at(-1)!.text).toBe(
      "The assistants stopped after 3 turns. Send a message to continue.",
    );
    expect(events.map((e) => e.type)).toEqual([
      "message",
      "turn_started",
      "message",
      "turn_started",
      "message",
      "turn_started",
      "message",
      "message",
      "round_finished",
    ]);
    expect(events.at(-1)).toEqual({
      type: "round_finished",
      roomId: "porch",
      reason: "max_rounds",
      turns: 3,
    });
  });

  it("stops a discussion mid-turn and never posts the abandoned reply", async () => {
    household();
    let release!: (value: { text: string }) => void;
    let seen: AbortSignal | undefined;
    const coordinator = new GroupCoordinator({
      repository: groups,
      executeTurn: (turn) => {
        seen = turn.signal;
        return new Promise((resolve) => (release = resolve));
      },
    });
    const started = new Promise<void>((resolve) =>
      coordinator.subscribe("porch", (event) => event.type === "turn_started" && resolve()),
    );
    const { round } = coordinator.sendHumanMessage("porch", { ...person, text: "@sage go" });
    await started;
    expect(() => coordinator.sendHumanMessage("porch", { ...person, text: "Again" })).toThrow(
      new Conflict("The assistants are still answering here. Stop them or wait to send."),
    );
    expect(coordinator.stopRoom("porch")).toBe(true);
    expect(await round).toMatchObject({ reason: "stopped", turns: 1, replies: [] });
    expect(seen!.aborted).toBe(true);
    release({ text: "Too late @scout" });
    await Promise.resolve();
    expect(groups.listMessages("porch").map((m) => m.senderKind)).toEqual(["human"]);
    expect(coordinator.stopRoom("porch")).toBe(false);
    expect(coordinator.isRunning("porch")).toBe(false);
  });

  it("posts a failed turn as a room notice without its error", async () => {
    household();
    const coordinator = new GroupCoordinator({
      repository: groups,
      executeTurn: async () => {
        throw new Error("token sk-leaked");
      },
    });
    const result = await coordinator.sendHumanMessage("porch", { ...person, text: "Hi" }).round;
    expect(result.reason).toBe("failed");
    expect(groups.listMessages("porch").at(-1)).toMatchObject({
      senderKind: "system",
      text: "Scout could not reply.",
    });
  });

  it("keeps thread replies and their context inside the thread", async () => {
    household();
    const fake = scripted({ scout: () => "On it.", sage: () => "Thread answer." });
    const coordinator = new GroupCoordinator({ repository: groups, executeTurn: fake.executeTurn });
    const root = coordinator.sendHumanMessage("porch", { ...person, text: "Fence plan?" });
    await root.round;
    await coordinator.sendHumanMessage("porch", { ...person, text: "Unrelated" }).round;

    fake.turns.length = 0;
    const reply = coordinator.sendHumanMessage("porch", {
      ...person,
      text: "@sage details?",
      threadId: root.message.id,
    });
    const result = await reply.round;
    expect(result.replies[0]).toMatchObject({ threadId: root.message.id, senderId: "sage" });
    expect(fake.turns[0]!.threadId).toBe(root.message.id);
    expect(fake.turns[0]!.transcript.map((m) => m.text)).toEqual(["Fence plan?", "@sage details?"]);
    expect(groups.listMessages("porch", { threadId: null }).map((m) => m.text)).toEqual([
      "Fence plan?",
      "On it.",
      "Unrelated",
      "On it.",
    ]);

    for (const threadId of ["missing", reply.message.id])
      expect(() =>
        coordinator.sendHumanMessage("porch", { ...person, text: "x", threadId }),
      ).toThrow(new InvalidInput("Reply to a message that starts a thread in this group chat."));
  });

  it("refuses a message from someone who cannot see every assistant in the room", () => {
    groups.createRoom({
      id: "desk",
      name: "Desk",
      leadBotId: "alice-key",
      memberBotIds: ["alice-key", "alice-claude"],
      createdBy: "alice",
    });
    const coordinator = new GroupCoordinator({
      repository: groups,
      executeTurn: async () => {
        throw new Error("no turn expected");
      },
    });
    expect(() => coordinator.sendHumanMessage("desk", { ...person, text: "Hi" })).toThrow(
      new NotFound("This group chat is no longer available."),
    );
    expect(groups.listMessages("desk")).toEqual([]);
  });
});
