import type { GroupState } from "../shared/collaboration.js";
import type { Runtime } from "../shared/types.js";
import { httpError } from "./http-error.js";

export const GROUP_POLL_MS = 2000;
export const GROUP_POLL_MAX_MS = 30_000;
/** Safety-net poll cadence when the runtime pushes group changes via `watchGroup`. */
export const GROUP_SAFETY_POLL_MS = 15_000;
/** Coalescing window for event-driven group wakes so bursts collapse into one state read. */
export const GROUP_WAKE_COALESCE_MS = 25;
/** Open watches one person may hold, across tabs and devices. A household needs a few at most. */
export const GROUP_WATCHES_PER_PERSON = 8;
/** Rooms polled at once for everyone, so the server's reads of Hermes stay bounded. */
export const GROUP_WATCHED_ROOMS = 24;
type Listener = (state: GroupState) => void;
type Room = {
  listeners: Set<Listener>;
  timer?: NodeJS.Timeout;
  wakeTimer?: NodeJS.Timeout;
  unwatch?: () => void;
  polling: boolean;
  dirty: boolean;
  delay: number;
  generation: number;
  seen?: string;
};

/**
 * What a watcher must hear about: the room's newest event and its driver status, including who works
 * in which tool. Each assistant's last-frame time moves on almost every step of a turn, so it is left
 * out; the slow fallback poll still refreshes it. Room settings append an event, so they move latest_seq.
 */
export function fingerprint(state: GroupState): string {
  const status = state.driver_status;
  return JSON.stringify([
    state.room.latest_seq,
    status && {
      ...status,
      member_activity: status.member_activity?.map(({ progress_at: _, ...activity }) => activity),
    },
  ]);
}

/**
 * Watches group rooms for open app event streams: one watcher per room, only while someone watches it.
 * When the runtime exposes `watchGroup`, room changes trigger an immediate coalesced state read with a
 * slower safety-net poll; otherwise it polls on `interval`, slowing down while Hermes fails. Callers can
 * also call `notify(roomId)` after local HTTP group mutations for instant wakeups. Listeners hear each
 * change to the room's latest event or driver status. Watches beyond a person's share, or a room beyond
 * the total, are refused with a 429 before anything is polled.
 */
export class GroupWatch {
  private readonly rooms = new Map<string, Room>();
  private readonly owners = new Map<string, number>();
  constructor(
    private readonly runtime: Pick<Runtime, "groupRequest" | "watchGroup">,
    private readonly interval = GROUP_POLL_MS,
  ) {}
  get watched() {
    return [...this.rooms.keys()];
  }
  watch(roomId: string, owner: string, listener: Listener): () => void {
    const held = this.owners.get(owner) ?? 0;
    if (held >= GROUP_WATCHES_PER_PERSON)
      throw httpError(
        429,
        "Too many group chats are open for you at once. Close one in another tab or device, then try again.",
      );
    let room = this.rooms.get(roomId);
    if (!room && this.rooms.size >= GROUP_WATCHED_ROOMS)
      throw httpError(
        429,
        "Too many group chats are open in this household right now. Try again once one closes.",
      );
    let unwatch: (() => void) | undefined;
    if (!room) {
      unwatch = this.runtime.watchGroup?.(roomId, () => this.notify(roomId));
      room = {
        listeners: new Set(),
        unwatch,
        polling: false,
        dirty: false,
        delay: this.baseInterval(unwatch),
        generation: 0,
      };
      this.rooms.set(roomId, room);
      this.schedule(roomId, room, 0);
    }
    this.owners.set(owner, held + 1);
    // Each watch is its own entry, so two streams sharing a listener still count and leave separately.
    const entry: Listener = (state) => listener(state);
    room.listeners.add(entry);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const left = (this.owners.get(owner) ?? 1) - 1;
      if (left > 0) this.owners.set(owner, left);
      else this.owners.delete(owner);
      const current = this.rooms.get(roomId);
      if (current !== room || !room.listeners.delete(entry) || room.listeners.size) return;
      clearTimeout(room.timer);
      clearTimeout(room.wakeTimer);
      room.unwatch?.();
      room.generation++;
      this.rooms.delete(roomId);
    };
  }
  /** Schedules a coalesced state check for a watched room after a known mutation. No-op if unwatched. */
  notify(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (room.polling) {
      room.dirty = true;
      return;
    }
    if (room.wakeTimer) return;
    clearTimeout(room.timer);
    room.timer = undefined;
    const generation = room.generation;
    room.wakeTimer = setTimeout(() => {
      room.wakeTimer = undefined;
      void this.poll(roomId, room, generation);
    }, GROUP_WAKE_COALESCE_MS);
    room.wakeTimer.unref();
  }
  close() {
    for (const room of this.rooms.values()) {
      clearTimeout(room.timer);
      clearTimeout(room.wakeTimer);
      room.unwatch?.();
      room.generation++;
    }
    this.rooms.clear();
    this.owners.clear();
  }
  private baseInterval(unwatch?: () => void) {
    return unwatch ? Math.max(this.interval, GROUP_SAFETY_POLL_MS) : this.interval;
  }
  private schedule(roomId: string, room: Room, delay: number) {
    clearTimeout(room.timer);
    const generation = room.generation;
    room.timer = setTimeout(() => {
      room.timer = undefined;
      void this.poll(roomId, room, generation);
    }, delay);
    room.timer.unref();
  }
  private async poll(roomId: string, room: Room, generation: number) {
    clearTimeout(room.timer);
    room.timer = undefined;
    clearTimeout(room.wakeTimer);
    room.wakeTimer = undefined;
    room.polling = true;
    room.dirty = false;
    let state: GroupState | undefined;
    try {
      state = (await this.runtime.groupRequest!({ operation: "state", roomId })) as GroupState;
      room.delay = this.baseInterval(room.unwatch);
    } catch {
      room.delay = Math.min(room.delay * 2, GROUP_POLL_MAX_MS);
    } finally {
      room.polling = false;
    }
    const stopped = () => room.generation !== generation || this.rooms.get(roomId) !== room;
    // The last watcher left while Hermes answered.
    if (stopped()) return;
    if (state?.room) {
      const seen = fingerprint(state);
      if (seen !== room.seen) {
        room.seen = seen;
        for (const listener of [...room.listeners]) listener(state);
      }
    }
    // A listener may have ended its stream, the last watch, just now.
    if (stopped()) return;
    if (room.dirty) {
      room.dirty = false;
      this.notify(roomId);
      return;
    }
    this.schedule(roomId, room, room.delay);
  }
}
