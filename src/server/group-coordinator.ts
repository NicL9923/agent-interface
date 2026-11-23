import { randomUUID } from "node:crypto";
import { Conflict, InvalidInput, NotFound } from "../shared/errors.js";
import type { CredentialRecord, ManagedBotRecord } from "../shared/harness.js";
import { assertGroupChatAllowed } from "./credential-policy.js";
import type { StoreDatabase } from "./store-database.js";

/**
 * Native group chats: rooms of managed bots that WildBots runs itself, with no Hermes room behind them. People
 * post; the bots they name answer one turn at a time, and a bot can name another to hand the discussion on.
 */
export interface NativeGroupRoom {
  id: string;
  name: string;
  description: string;
  leadBotId: string;
  memberBotIds: string[];
  /** The most bot turns one person's message can start. */
  maxRounds: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}
export type GroupSenderKind = "human" | "bot" | "system";
export interface NativeGroupMessage {
  seq: number;
  id: string;
  roomId: string;
  /** The top-level message this one replies under. Null on the room's main timeline. */
  threadId: string | null;
  senderKind: GroupSenderKind;
  senderId: string;
  senderName: string;
  text: string;
  /** Member bot IDs the text names, in the order it names them. */
  mentions: string[];
  /** The bot turn that wrote it, from 1. People and the room itself write round 0. */
  round: number;
  createdAt: number;
}
export interface NativeGroupRoomInput {
  id?: string;
  name: string;
  description?: string;
  leadBotId: string;
  memberBotIds: string[];
  maxRounds?: number;
  createdBy: string;
}
export type NativeGroupRoomPatch = Partial<
  Pick<NativeGroupRoom, "name" | "description" | "leadBotId" | "memberBotIds" | "maxRounds">
>;

/** Bot and credential records, as `ManagedBotRepository` keeps them. */
export interface GroupBotDirectory {
  getManagedBot(id: string): ManagedBotRecord | undefined;
  getCredential(id: string): CredentialRecord | undefined;
}

export const DEFAULT_MAX_ROUNDS = 4;
export const MAX_GROUP_ROUNDS = 12;
export const MAX_GROUP_MEMBERS = 12;
const MAX_NAME = 100;
const MAX_DESCRIPTION = 500;
const MAX_MESSAGE = 20_000;
const DEFAULT_CONTEXT_MESSAGES = 30;

type RoomRow = {
  id: string;
  name: string;
  description: string;
  lead_bot_id: string;
  member_bot_ids_json: string;
  max_rounds: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};
type MessageRow = {
  seq: number;
  id: string;
  room_id: string;
  thread_id: string | null;
  sender_kind: GroupSenderKind;
  sender_id: string;
  sender_name: string;
  text: string;
  mentions_json: string;
  round: number;
  created_at: number;
};

const readRoom = (row: RoomRow): NativeGroupRoom => ({
  id: row.id,
  name: row.name,
  description: row.description,
  leadBotId: row.lead_bot_id,
  memberBotIds: JSON.parse(row.member_bot_ids_json) as string[],
  maxRounds: row.max_rounds,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
});
const readMessage = (row: MessageRow): NativeGroupMessage => ({
  seq: row.seq,
  id: row.id,
  roomId: row.room_id,
  threadId: row.thread_id,
  senderKind: row.sender_kind,
  senderId: row.sender_id,
  senderName: row.sender_name,
  text: row.text,
  mentions: JSON.parse(row.mentions_json) as string[],
  round: row.round,
  createdAt: row.created_at,
});

/** Whether a person may see a bot: everyone sees a shared bot, only its owner a personal one. */
const visibleTo = (bot: Pick<ManagedBotRecord, "shared" | "ownerId">, userId: string) =>
  bot.shared || bot.ownerId === userId;

/**
 * Whether a room serves more than one household member. A room with a shared bot is a household room, since
 * everyone can see that bot; so is one whose personal bots belong to someone other than the room's creator.
 * Only a room of its creator's own personal bots is a one-person room.
 */
export function roomIsMultiUser(
  createdBy: string,
  members: Pick<ManagedBotRecord, "shared" | "ownerId">[],
) {
  return members.some((bot) => bot.shared || bot.ownerId !== createdBy);
}

const mentionToken = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]/gu, "");

/**
 * The member bots a text names with `@id` or `@name`, in the order it first names them. A name is matched with
 * its spaces and punctuation removed, so `@ResearchBot` names "Research Bot". An e-mail address names no one.
 */
export function parseMentions(text: string, members: Pick<ManagedBotRecord, "id" | "name">[]) {
  const byToken = new Map<string, string>();
  for (const bot of members) {
    byToken.set(bot.id.toLowerCase(), bot.id);
    const name = mentionToken(bot.name);
    if (name && !byToken.has(name)) byToken.set(name, bot.id);
  }
  const found: string[] = [];
  for (const match of text.matchAll(/(?<![\p{L}\p{N}_.@-])@([\p{L}\p{N}_-]{1,64})/gu)) {
    const id = byToken.get(mentionToken(match[1]!));
    if (id && !found.includes(id)) found.push(id);
  }
  return found;
}

/** Rooms and their messages, with every membership change checked against the credential policy. */
export class NativeGroupRepository {
  constructor(
    private readonly database: StoreDatabase,
    private readonly bots: GroupBotDirectory,
  ) {}

  private get db() {
    return this.database.db;
  }
  private write<T>(operation: () => T): T {
    return this.db.isTransaction ? operation() : this.database.transaction(operation);
  }

  /** The live bot records for a room's members. Refuses one that is gone, archived, unseen or disallowed. */
  memberBots(
    room: Pick<NativeGroupRoom, "createdBy" | "memberBotIds" | "leadBotId">,
  ): ManagedBotRecord[] {
    const bots = room.memberBotIds.map((id) => {
      const bot = this.bots.getManagedBot(id);
      if (!bot || bot.archivedAt != null || !visibleTo(bot, room.createdBy))
        throw new InvalidInput("Choose assistants that still exist for this group chat.");
      return bot;
    });
    const multiUser = roomIsMultiUser(room.createdBy, bots);
    for (const bot of bots)
      assertGroupChatAllowed(
        bot,
        bot.credentialId ? this.bots.getCredential(bot.credentialId) : undefined,
        multiUser,
      );
    return bots;
  }

  private validate(room: Omit<NativeGroupRoom, "id" | "createdAt" | "updatedAt" | "archivedAt">) {
    const name = typeof room.name === "string" ? room.name.trim() : "";
    if (!name || name.length > MAX_NAME)
      throw new InvalidInput(`Name the group chat in 1 to ${MAX_NAME} characters.`);
    const description = typeof room.description === "string" ? room.description.trim() : "";
    if (description.length > MAX_DESCRIPTION)
      throw new InvalidInput(`Keep the description under ${MAX_DESCRIPTION} characters.`);
    const members = room.memberBotIds;
    if (
      !Array.isArray(members) ||
      members.length < 2 ||
      members.length > MAX_GROUP_MEMBERS ||
      members.some((id) => typeof id !== "string" || !id) ||
      new Set(members).size !== members.length
    )
      throw new InvalidInput(
        `Choose 2 to ${MAX_GROUP_MEMBERS} different assistants for this group chat.`,
      );
    if (!members.includes(room.leadBotId))
      throw new InvalidInput("Choose a lead from this group chat's assistants.");
    if (
      !Number.isInteger(room.maxRounds) ||
      room.maxRounds < 1 ||
      room.maxRounds > MAX_GROUP_ROUNDS
    )
      throw new InvalidInput(`Allow 1 to ${MAX_GROUP_ROUNDS} assistant turns per message.`);
    if (typeof room.createdBy !== "string" || !room.createdBy)
      throw new InvalidInput("Sign in to create a group chat.");
    this.memberBots(room);
    return { ...room, name, description };
  }

  createRoom(input: NativeGroupRoomInput, now = Date.now()): NativeGroupRoom {
    return this.write(() => {
      const room = this.validate({
        name: input.name,
        description: input.description ?? "",
        leadBotId: input.leadBotId,
        memberBotIds: input.memberBotIds,
        maxRounds: input.maxRounds ?? DEFAULT_MAX_ROUNDS,
        createdBy: input.createdBy,
      });
      const id = input.id ?? randomUUID();
      if (this.getRoom(id)) throw new Conflict("A group chat with this ID already exists.");
      this.db
        .prepare(
          `INSERT INTO native_group_rooms(id,name,description,lead_bot_id,member_bot_ids_json,max_rounds,created_by,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          room.name,
          room.description,
          room.leadBotId,
          JSON.stringify(room.memberBotIds),
          room.maxRounds,
          room.createdBy,
          now,
          now,
        );
      return this.getRoom(id)!;
    });
  }

  getRoom(id: string): NativeGroupRoom | undefined {
    const row = this.db.prepare("SELECT * FROM native_group_rooms WHERE id=?").get(id) as
      | RoomRow
      | undefined;
    return row && readRoom(row);
  }

  /** A room that is still open, or NotFound. */
  openRoom(id: string): NativeGroupRoom {
    const room = this.getRoom(id);
    if (!room || room.archivedAt !== undefined)
      throw new NotFound("This group chat is no longer available.");
    return room;
  }

  /** Open rooms, oldest first. Pass a person to list only rooms whose every assistant they can see. */
  listRooms(userId?: string): NativeGroupRoom[] {
    const rooms = (
      this.db
        .prepare(
          "SELECT * FROM native_group_rooms WHERE archived_at IS NULL ORDER BY created_at,rowid",
        )
        .all() as RoomRow[]
    ).map(readRoom);
    return userId === undefined ? rooms : rooms.filter((room) => this.canOpen(room, userId));
  }

  canOpen(room: NativeGroupRoom, userId: string) {
    return room.memberBotIds.every((id) => {
      const bot = this.bots.getManagedBot(id);
      return !!bot && bot.archivedAt == null && visibleTo(bot, userId);
    });
  }

  updateRoom(id: string, patch: NativeGroupRoomPatch, now = Date.now()): NativeGroupRoom {
    return this.write(() => {
      const current = this.openRoom(id);
      const room = this.validate({
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        leadBotId: patch.leadBotId ?? current.leadBotId,
        memberBotIds: patch.memberBotIds ?? current.memberBotIds,
        maxRounds: patch.maxRounds ?? current.maxRounds,
        createdBy: current.createdBy,
      });
      this.db
        .prepare(
          `UPDATE native_group_rooms SET name=?,description=?,lead_bot_id=?,member_bot_ids_json=?,max_rounds=?,updated_at=? WHERE id=?`,
        )
        .run(
          room.name,
          room.description,
          room.leadBotId,
          JSON.stringify(room.memberBotIds),
          room.maxRounds,
          now,
          id,
        );
      return this.getRoom(id)!;
    });
  }

  addMember(id: string, botId: string, now = Date.now()) {
    const room = this.openRoom(id);
    if (room.memberBotIds.includes(botId)) return room;
    return this.updateRoom(id, { memberBotIds: [...room.memberBotIds, botId] }, now);
  }

  removeMember(id: string, botId: string, now = Date.now()) {
    const room = this.openRoom(id);
    if (room.leadBotId === botId)
      throw new InvalidInput("Choose another lead before removing this assistant.");
    return this.updateRoom(
      id,
      { memberBotIds: room.memberBotIds.filter((member) => member !== botId) },
      now,
    );
  }

  archiveRoom(id: string, now = Date.now()): boolean {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE native_group_rooms SET archived_at=?,updated_at=? WHERE id=? AND archived_at IS NULL",
          )
          .run(now, now, id).changes,
      ) > 0
    );
  }

  appendMessage(
    input: Omit<NativeGroupMessage, "seq" | "id" | "createdAt"> & { id?: string },
    now = Date.now(),
  ): NativeGroupMessage {
    const row = this.db
      .prepare(
        `INSERT INTO native_group_messages(id,room_id,thread_id,sender_kind,sender_id,sender_name,text,mentions_json,round,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING *`,
      )
      .get(
        input.id ?? randomUUID(),
        input.roomId,
        input.threadId,
        input.senderKind,
        input.senderId,
        input.senderName,
        input.text,
        JSON.stringify(input.mentions),
        input.round,
        now,
      ) as MessageRow;
    return readMessage(row);
  }

  getMessage(roomId: string, id: string): NativeGroupMessage | undefined {
    const row = this.db
      .prepare("SELECT * FROM native_group_messages WHERE room_id=? AND id=?")
      .get(roomId, id) as MessageRow | undefined;
    return row && readMessage(row);
  }

  /**
   * A room's messages in order. `threadId` undefined reads everything, null the main timeline, and a message ID
   * that thread with its top-level message first.
   */
  listMessages(
    roomId: string,
    options: { threadId?: string | null; afterSeq?: number; limit?: number } = {},
  ): NativeGroupMessage[] {
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
    const after = options.afterSeq ?? 0;
    const { threadId } = options;
    const rows =
      threadId === undefined
        ? this.db
            .prepare(
              "SELECT * FROM native_group_messages WHERE room_id=? AND seq>? ORDER BY seq LIMIT ?",
            )
            .all(roomId, after, limit)
        : threadId === null
          ? this.db
              .prepare(
                "SELECT * FROM native_group_messages WHERE room_id=? AND thread_id IS NULL AND seq>? ORDER BY seq LIMIT ?",
              )
              .all(roomId, after, limit)
          : this.db
              .prepare(
                "SELECT * FROM native_group_messages WHERE room_id=? AND (thread_id=? OR id=?) AND seq>? ORDER BY seq LIMIT ?",
              )
              .all(roomId, threadId, threadId, after, limit);
    return (rows as MessageRow[]).map(readMessage);
  }

  /** The newest `limit` messages of one timeline, oldest first: the context a bot's turn reads. */
  recentMessages(roomId: string, threadId: string | null, limit: number): NativeGroupMessage[] {
    const rows =
      threadId === null
        ? this.db
            .prepare(
              "SELECT * FROM native_group_messages WHERE room_id=? AND thread_id IS NULL ORDER BY seq DESC LIMIT ?",
            )
            .all(roomId, limit)
        : this.db
            .prepare(
              "SELECT * FROM native_group_messages WHERE room_id=? AND (thread_id=? OR id=?) ORDER BY seq DESC LIMIT ?",
            )
            .all(roomId, threadId, threadId, limit);
    return (rows as MessageRow[]).map(readMessage).reverse();
  }
}

/** What one bot is asked to do in its turn. */
export interface GroupTurnInput {
  room: NativeGroupRoom;
  bot: ManagedBotRecord;
  /** This turn's number within the discussion, from 1. */
  round: number;
  threadId: string | null;
  /** The message that named this bot, or the person's message for the lead. */
  trigger: NativeGroupMessage;
  /** Recent messages of this timeline, oldest first, ending with the trigger or later turns. */
  transcript: NativeGroupMessage[];
  /** The transcript as text, ready to send as the turn's prompt. */
  prompt: string;
  /** Aborted when the room is stopped. */
  signal: AbortSignal;
}
export type GroupTurnExecutor = (input: GroupTurnInput) => Promise<{ text: string }>;

export type GroupRoundEnd = "settled" | "max_rounds" | "stopped" | "failed";
export type GroupRoomEvent =
  | { type: "message"; roomId: string; message: NativeGroupMessage }
  | { type: "turn_started"; roomId: string; botId: string; round: number; threadId: string | null }
  | { type: "round_finished"; roomId: string; reason: GroupRoundEnd; turns: number };
export interface GroupRoundResult {
  reason: GroupRoundEnd;
  turns: number;
  replies: NativeGroupMessage[];
}

/** The transcript a bot reads, one line per message, naming who wrote each. */
export function formatGroupPrompt(
  room: Pick<NativeGroupRoom, "name" | "description">,
  bot: Pick<ManagedBotRecord, "name">,
  transcript: NativeGroupMessage[],
) {
  return [
    `You are ${bot.name} in the group chat "${room.name}"${room.description ? `: ${room.description}` : "."}`,
    "Reply to the latest message. Name another assistant with @name only when you need it to answer next.",
    "",
    ...transcript.map(
      (message) =>
        `${message.senderKind === "bot" ? `🤖 ${message.senderName}` : message.senderKind === "system" ? "[room]" : message.senderName}: ${message.text}`,
    ),
  ].join("\n");
}

/**
 * Runs each person's message as a bounded discussion. The named bots, or the lead when nobody is named, take
 * turns one at a time; a reply that names another member queues that member. No message ever starts more
 * than the room's `maxRounds` turns, so two bots naming each other cannot talk forever. One discussion runs
 * per room: a second message waits for it to finish or be stopped.
 */
export class GroupCoordinator {
  private readonly running = new Map<string, AbortController>();
  private readonly listeners = new Map<string, Set<(event: GroupRoomEvent) => void>>();
  private readonly now: () => number;
  private readonly contextMessages: number;

  constructor(
    private readonly options: {
      repository: NativeGroupRepository;
      executeTurn: GroupTurnExecutor;
      now?: () => number;
      contextMessages?: number;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.contextMessages = options.contextMessages ?? DEFAULT_CONTEXT_MESSAGES;
  }

  /** Listen to one room's events, as an SSE stream does. Returns the unsubscribe. */
  subscribe(roomId: string, listener: (event: GroupRoomEvent) => void) {
    let set = this.listeners.get(roomId);
    if (!set) this.listeners.set(roomId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(roomId);
    };
  }

  private emit(event: GroupRoomEvent) {
    for (const listener of this.listeners.get(event.roomId) ?? [])
      try {
        listener(event);
      } catch {
        // One broken stream never stops the discussion or the other listeners.
      }
  }

  private post(input: Omit<NativeGroupMessage, "seq" | "id" | "createdAt">) {
    const message = this.options.repository.appendMessage(input, this.now());
    this.emit({ type: "message", roomId: input.roomId, message });
    return message;
  }

  isRunning(roomId: string) {
    return this.running.has(roomId);
  }

  /**
   * Saves a person's message and starts its discussion. Resolves once the message is saved; `round` settles
   * when the discussion ends and never rejects.
   */
  sendHumanMessage(
    roomId: string,
    input: { userId: string; userName: string; text: string; threadId?: string | null },
  ): { message: NativeGroupMessage; round: Promise<GroupRoundResult> } {
    const { repository } = this.options;
    const room = repository.openRoom(roomId);
    if (!repository.canOpen(room, input.userId))
      throw new NotFound("This group chat is no longer available.");
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text || text.length > MAX_MESSAGE)
      throw new InvalidInput(`Write a message of 1 to ${MAX_MESSAGE} characters.`);
    const threadId = input.threadId ?? null;
    if (threadId !== null) {
      const root = repository.getMessage(roomId, threadId);
      if (!root || root.threadId !== null)
        throw new InvalidInput("Reply to a message that starts a thread in this group chat.");
    }
    if (this.running.has(roomId))
      throw new Conflict("The assistants are still answering here. Stop them or wait to send.");
    // Credentials can change after a room was made, so every discussion checks its members again.
    const members = repository.memberBots(room);
    const mentions = parseMentions(text, members);
    const message = this.post({
      roomId,
      threadId,
      senderKind: "human",
      senderId: input.userId,
      senderName: input.userName,
      text,
      mentions,
      round: 0,
    });
    const controller = new AbortController();
    this.running.set(roomId, controller);
    const round = this.discuss(room, members, message, controller.signal)
      .catch((): GroupRoundResult => {
        // A failed save ends the discussion; its listeners still learn that it ended.
        this.emit({ type: "round_finished", roomId, reason: "failed", turns: 0 });
        return { reason: "failed", turns: 0, replies: [] };
      })
      .finally(() => {
        if (this.running.get(roomId) === controller) this.running.delete(roomId);
      });
    return { message, round };
  }

  /** Stops the room's discussion. The turn in progress is abandoned and its reply never posted. */
  stopRoom(roomId: string): boolean {
    const controller = this.running.get(roomId);
    if (!controller) return false;
    this.running.delete(roomId);
    controller.abort();
    return true;
  }

  private async discuss(
    room: NativeGroupRoom,
    members: ManagedBotRecord[],
    message: NativeGroupMessage,
    signal: AbortSignal,
  ): Promise<GroupRoundResult> {
    const byId = new Map(members.map((bot) => [bot.id, bot]));
    const threadId = message.threadId;
    const queue: { botId: string; trigger: NativeGroupMessage }[] = (
      message.mentions.length ? message.mentions : [room.leadBotId]
    ).map((botId) => ({ botId, trigger: message }));
    const replies: NativeGroupMessage[] = [];
    let turns = 0;
    const finish = (reason: GroupRoundEnd): GroupRoundResult => {
      this.emit({ type: "round_finished", roomId: room.id, reason, turns });
      return { reason, turns, replies };
    };
    while (queue.length) {
      if (signal.aborted) return finish("stopped");
      if (turns >= room.maxRounds) {
        this.post({
          roomId: room.id,
          threadId,
          senderKind: "system",
          senderId: room.id,
          senderName: room.name,
          text: `The assistants stopped after ${room.maxRounds} turns. Send a message to continue.`,
          mentions: [],
          round: turns,
        });
        return finish("max_rounds");
      }
      const { botId, trigger } = queue.shift()!;
      const bot = byId.get(botId)!;
      turns += 1;
      this.emit({ type: "turn_started", roomId: room.id, botId, round: turns, threadId });
      const transcript = this.options.repository.recentMessages(
        room.id,
        threadId,
        this.contextMessages,
      );
      let reply: { text: string };
      try {
        reply = await abortable(
          this.options.executeTurn({
            room,
            bot,
            round: turns,
            threadId,
            trigger,
            transcript,
            prompt: formatGroupPrompt(room, bot, transcript),
            signal,
          }),
          signal,
        );
      } catch {
        if (signal.aborted) return finish("stopped");
        this.post({
          roomId: room.id,
          threadId,
          senderKind: "system",
          senderId: room.id,
          senderName: room.name,
          text: `${bot.name} could not reply.`,
          mentions: [],
          round: turns,
        });
        return finish("failed");
      }
      if (signal.aborted) return finish("stopped");
      const text = typeof reply?.text === "string" ? reply.text.trim().slice(0, MAX_MESSAGE) : "";
      if (!text) continue;
      const handoffs = parseMentions(text, members).filter((id) => id !== botId);
      const posted = this.post({
        roomId: room.id,
        threadId,
        senderKind: "bot",
        senderId: bot.id,
        senderName: bot.name,
        text,
        mentions: handoffs,
        round: turns,
      });
      replies.push(posted);
      for (const next of handoffs)
        if (!queue.some((item) => item.botId === next))
          queue.push({ botId: next, trigger: posted });
    }
    return finish("settled");
  }
}

/** A turn that settles as soon as the room is stopped, even when its executor ignores the signal. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("stopped"));
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new Error("stopped"));
    signal.addEventListener("abort", stop, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(error instanceof Error ? error : new Error("turn failed"));
      },
    );
  });
}
