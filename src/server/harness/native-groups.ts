import { randomUUID } from "node:crypto";
import { Conflict, InvalidInput, NotFound } from "../../shared/errors.js";
import type {
  GroupCatalog,
  GroupContext,
  GroupEvent,
  GroupMember,
  GroupMemberActivity,
  GroupPage,
  GroupRequest,
  GroupResponse,
  GroupRoom,
  GroupRouting,
  GroupState,
} from "../../shared/collaboration.js";
import type { ManagedBotRecord } from "../../shared/harness.js";
import {
  GroupCoordinator,
  type NativeGroupMessage,
  type NativeGroupRoom,
} from "../group-coordinator.js";
import type { Store } from "../store.js";

const LOG_PAGE_LIMIT = 200;
const CONTEXT_PREFIX = "group_context:";
const SEND_PREFIX = "group_send:";

interface StoredRoomExtras {
  notes: string;
  routing: GroupRouting;
}

export interface NativeGroupAdapter {
  handle(input: GroupRequest): Promise<GroupResponse>;
  deliverRoutine(
    roomId: string,
    input: { routineId: string; routineName: string; text: string; failed?: boolean },
  ): GroupEvent;
  watch(roomId: string, listener: () => void): () => void;
  close(): void;
}

/**
 * Adapts `NativeGroupRepository` + `GroupCoordinator` to the `Runtime.groupRequest` contract used by
 * `/api/groups*`, `GroupWatch`, and the Web & iOS group chat screens.
 */
export function createNativeGroupAdapter({
  store,
  executeTurn,
  now = Date.now,
}: {
  store: Store;
  executeTurn: (bot: ManagedBotRecord, prompt: string, signal: AbortSignal) => Promise<string>;
  now?: () => number;
}): NativeGroupAdapter {
  const repository = store.nativeGroups;
  const activeWork = new Map<string, GroupMemberActivity>();
  const activeRooms = new Set<string>();
  const roomWatchers = new Map<string, Set<() => void>>();

  function notifyRoom(roomId: string) {
    const listeners = roomWatchers.get(roomId);
    if (!listeners?.size) return;
    for (const listener of [...listeners])
      try {
        listener();
      } catch {
        // One broken watcher never stops the others or the room.
      }
  }

  function readExtras(roomId: string): StoredRoomExtras {
    const row = store.db
      .prepare("SELECT value FROM metadata WHERE key=?")
      .get(`${CONTEXT_PREFIX}${roomId}`) as { value: string } | undefined;
    if (!row) return { notes: "", routing: "lead" };
    try {
      const parsed = JSON.parse(row.value) as Partial<StoredRoomExtras>;
      return {
        notes: typeof parsed.notes === "string" ? parsed.notes : "",
        routing: parsed.routing === "everyone" ? "everyone" : "lead",
      };
    } catch {
      return { notes: "", routing: "lead" };
    }
  }

  function writeExtras(roomId: string, extras: StoredRoomExtras) {
    store.db
      .prepare(
        "INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(`${CONTEXT_PREFIX}${roomId}`, JSON.stringify(extras));
  }

  function latestSeq(roomId: string): number {
    const row = store.db
      .prepare("SELECT coalesce(max(seq), 0) AS seq FROM native_group_messages WHERE room_id=?")
      .get(roomId) as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  function toMember(botId: string): GroupMember {
    const bot = store.managedBots.getManagedBot(botId);
    return {
      member_id: botId,
      profile: botId,
      handle: botId,
      display_name: bot?.name ?? botId,
    };
  }

  function toRoom(room: NativeGroupRoom): GroupRoom {
    return {
      room_id: room.id,
      name: room.name,
      members: room.memberBotIds.map(toMember),
      latest_seq: latestSeq(room.id),
    };
  }

  function toContext(room: NativeGroupRoom): GroupContext {
    const extras = readExtras(room.id);
    return {
      purpose: room.description,
      notes: extras.notes,
      routing: extras.routing,
      lead_member_id: extras.routing === "everyone" ? "" : room.leadBotId,
    };
  }

  function toEvent(message: NativeGroupMessage): GroupEvent {
    const isRoutine =
      message.senderKind === "system" &&
      (message.senderId.startsWith("cron:") || message.senderId.startsWith("cron-notice:"));
    const kind =
      message.senderKind === "human" || isRoutine
        ? "message.user"
        : message.senderKind === "bot"
          ? "message.member"
          : "room.notice";
    const actorKind =
      message.senderKind === "human" || isRoutine
        ? "user"
        : message.senderKind === "bot"
          ? "member"
          : "system";
    return {
      event_id: message.id,
      seq: message.seq,
      kind,
      created_at: Math.floor(message.createdAt / 1000),
      actor: {
        kind: actorKind,
        id: message.senderId,
        display_name: message.senderName,
      },
      payload: {
        text: message.text,
        thread_id: message.threadId ?? message.id,
        ...(message.senderKind === "bot" ? { member_id: message.senderId } : {}),
      },
      ...(message.senderKind === "human" && message.senderId
        ? { sender: { id: message.senderId, name: message.senderName } }
        : {}),
    };
  }

  const coordinator = new GroupCoordinator({
    repository,
    now,
    defaultRecipients: (room) =>
      readExtras(room.id).routing === "everyone" ? [...room.memberBotIds] : [room.leadBotId],
    replyThreadId: (message) => message.threadId ?? message.id,
    executeTurn: async ({ room, bot, prompt, signal }) => {
      const extras = readExtras(room.id);
      const fullPrompt = extras.notes.trim()
        ? `${prompt}\n\n# Shared room notes\n${extras.notes.trim()}`
        : prompt;
      const text = await executeTurn(bot, fullPrompt, signal);
      return { text };
    },
  });

  function ensureSubscribed(roomId: string) {
    if (activeRooms.has(roomId)) return;
    activeRooms.add(roomId);
    coordinator.subscribe(roomId, (event) => {
      if (event.type === "turn_started") {
        activeWork.set(roomId, {
          member_id: event.botId,
          status: "running",
          thread_id: event.threadId,
          round_index: event.round - 1,
          started_at: Math.floor(now() / 1000),
        });
      } else if (event.type === "round_finished") {
        activeWork.delete(roomId);
      }
      notifyRoom(roomId);
    });
  }

  function defaultActorId(memberIds: string[]): string {
    const firstUser = store.users()[0]?.id;
    if (firstUser) return firstUser;
    for (const id of memberIds) {
      const owner = store.managedBots.getManagedBot(id)?.ownerId;
      if (owner) return owner;
    }
    return "household";
  }

  async function handle(input: GroupRequest): Promise<GroupResponse> {
    switch (input.operation) {
      case "list": {
        const rooms = repository.listRooms().map(toRoom);
        return {
          supported: true,
          canSend: true,
          settings: true,
          routineDelivery: true,
          rooms,
        } satisfies GroupCatalog;
      }
      case "create": {
        const existing = repository.getRoom(input.roomId);
        if (existing && existing.archivedAt === undefined) return { room: toRoom(existing) };
        const memberIds = input.members.map((member) => member.profile);
        if (memberIds.length < 2)
          throw new InvalidInput("Choose at least 2 assistants for a group chat.");
        const created = repository.createRoom(
          {
            id: input.roomId,
            name: input.name,
            leadBotId: memberIds[0]!,
            memberBotIds: memberIds,
            createdBy: input.actorId?.trim() || defaultActorId(memberIds),
          },
          now(),
        );
        return { room: toRoom(created) };
      }
      case "state": {
        const room = repository.openRoom(input.roomId);
        const running = coordinator.isRunning(room.id);
        const activity = activeWork.get(room.id);
        return {
          room: toRoom(room),
          driver_status: {
            running,
            working: running,
            blocked: false,
            pending_actions: [],
            member_activity: activity ? [activity] : [],
            max_rounds: room.maxRounds,
          },
          context: toContext(room),
        } satisfies GroupState;
      }
      case "log": {
        const room = repository.openRoom(input.roomId);
        const messages = repository.listMessages(room.id, {
          afterSeq: input.since,
          limit: LOG_PAGE_LIMIT,
        });
        const events = messages.map(toEvent);
        const latest = latestSeq(room.id);
        const cursor = events.at(-1)?.seq ?? input.since;
        return {
          events,
          cursor,
          latest_seq: latest,
          has_more: messages.length === LOG_PAGE_LIMIT && cursor < latest,
        } satisfies GroupPage;
      }
      case "send": {
        const room = repository.openRoom(input.roomId);
        const sendKey = `${SEND_PREFIX}${room.id}:${input.requestId}`;
        const recorded = store.db.prepare("SELECT value FROM metadata WHERE key=?").get(sendKey) as
          | { value: string }
          | undefined;
        if (recorded) {
          const previous = repository.getMessage(room.id, recorded.value);
          if (previous) return { accepted: true, event: toEvent(previous) };
        }
        const actorId = input.actorId?.trim() || room.createdBy;
        const actorName =
          input.actorName?.trim() || store.getUser(actorId)?.name || "Household member";
        // Clients generate a fresh threadId for new topics and reuse an existing root event_id for thread replies.
        const root = input.threadId ? repository.getMessage(room.id, input.threadId) : undefined;
        const resolvedThreadId = root && root.threadId === null ? root.id : null;
        ensureSubscribed(room.id);
        const { message } = coordinator.sendHumanMessage(room.id, {
          userId: actorId,
          userName: actorName,
          text: input.text,
          threadId: resolvedThreadId,
        });
        store.db
          .prepare(
            "INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(sendKey, message.id);
        return { accepted: true, event: toEvent(message) };
      }
      case "stop": {
        repository.openRoom(input.roomId);
        const stopped = coordinator.stopRoom(input.roomId);
        if (stopped) notifyRoom(input.roomId);
        return { cancelled: stopped ? 1 : 0 };
      }
      case "context": {
        const current = repository.openRoom(input.roomId);
        const leadBotId =
          input.routing === "lead" && input.leadMemberId ? input.leadMemberId : current.leadBotId;
        if (!current.memberBotIds.includes(leadBotId))
          throw new InvalidInput("Choose a lead from this group's assistants.");
        const updated = repository.updateRoom(
          current.id,
          { description: input.purpose, leadBotId },
          now(),
        );
        writeExtras(current.id, { notes: input.notes, routing: input.routing });
        const notice = repository.appendMessage(
          {
            id: randomUUID(),
            roomId: current.id,
            threadId: null,
            senderKind: "system",
            senderId: current.id,
            senderName: updated.name,
            text: "Updated group settings.",
            mentions: [],
            round: 0,
          },
          now(),
        );
        notifyRoom(current.id);
        return { context: toContext(updated), event: toEvent(notice) };
      }
      case "approve": {
        repository.openRoom(input.roomId);
        throw new Conflict("Group approvals are not required for native assistants.");
      }
    }
  }

  function deliverRoutine(
    roomId: string,
    input: { routineId: string; routineName: string; text: string; failed?: boolean },
  ): GroupEvent {
    ensureSubscribed(roomId);
    const { message } = coordinator.deliverRoutineMessage(roomId, input);
    return toEvent(message);
  }

  function watch(roomId: string, listener: () => void): () => void {
    ensureSubscribed(roomId);
    let set = roomWatchers.get(roomId);
    if (!set) roomWatchers.set(roomId, (set = new Set()));
    const entry = () => listener();
    set.add(entry);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      set.delete(entry);
      if (!set.size && roomWatchers.get(roomId) === set) roomWatchers.delete(roomId);
    };
  }

  function close() {
    for (const roomId of activeRooms) coordinator.stopRoom(roomId);
    activeWork.clear();
    roomWatchers.clear();
  }

  return { handle, deliverRoutine, watch, close };
}

export { NotFound };
