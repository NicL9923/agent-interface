import type { GroupState } from "../shared/collaboration.js";
import type { Runtime } from "../shared/types.js";

export const GROUP_POLL_MS = 2000;
export const GROUP_POLL_MAX_MS = 30_000;
type Listener = (state: GroupState) => void;
type Room = { listeners: Set<Listener>; timer?: NodeJS.Timeout; delay: number; generation: number; seen?: string };

/**
 * Polls the Hermes group coordinator for rooms that open app event streams watch: one poller
 * per room, only while someone watches it, slowing down while Hermes fails. Listeners hear
 * each change to the room's latest event or driver status. A new watcher refetches on open,
 * so it hears nothing until the next change.
 */
export class GroupWatch {
  private readonly rooms = new Map<string, Room>();
  constructor(private readonly runtime: Pick<Runtime, "groupRequest">, private readonly interval = GROUP_POLL_MS) {}
  get watched() { return [...this.rooms.keys()]; }
  watch(roomId: string, listener: Listener): () => void {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { listeners: new Set(), delay: this.interval, generation: 0 };
      this.rooms.set(roomId, room);
      this.schedule(roomId, room, 0);
    }
    room.listeners.add(listener);
    return () => {
      const current = this.rooms.get(roomId);
      if (current !== room || !room.listeners.delete(listener) || room.listeners.size) return;
      clearTimeout(room.timer);
      room.generation++;
      this.rooms.delete(roomId);
    };
  }
  close() {
    for (const room of this.rooms.values()) { clearTimeout(room.timer); room.generation++; }
    this.rooms.clear();
  }
  private schedule(roomId: string, room: Room, delay: number) {
    const generation = room.generation;
    room.timer = setTimeout(() => void this.poll(roomId, room, generation), delay);
    room.timer.unref();
  }
  private async poll(roomId: string, room: Room, generation: number) {
    let state: GroupState | undefined;
    try {
      state = await this.runtime.groupRequest!({ operation: "state", roomId }) as GroupState;
      room.delay = this.interval;
    } catch {
      room.delay = Math.min(room.delay * 2, GROUP_POLL_MAX_MS);
    }
    const stopped = () => room.generation !== generation || this.rooms.get(roomId) !== room;
    // The last watcher left while Hermes answered.
    if (stopped()) return;
    if (state?.room) {
      const seen = JSON.stringify([state.room.latest_seq, state.driver_status]);
      if (seen !== room.seen) {
        room.seen = seen;
        for (const listener of [...room.listeners]) listener(state);
      }
    }
    // A listener may have ended its stream, the last watch, just now.
    if (!stopped()) this.schedule(roomId, room, room.delay);
  }
}
