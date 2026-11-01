import type { GroupEvent, GroupLatest, GroupPage, GroupRoom } from "../shared/collaboration.js";

/** Events read back from a room's end to find its newest message. Driver notices in between rarely pass a handful. */
export const LATEST_LOOKBACK = 30;
/** Rooms read from Hermes at once while the previews fill in. */
export const LATEST_READS_AT_ONCE = 4;
/** The longest preview sent to home. The row shows two lines at most. */
export const LATEST_TEXT_CHARS = 160;

const isMessage = (event: GroupEvent) => event.kind === "message.user" || event.kind === "message.member";

/** The newest message among a room's trailing events, or none. */
export function newestMessage(events: GroupEvent[]) {
  return events.filter(isMessage).sort((a, b) => b.seq - a.seq)[0];
}

/**
 * Words one event for a viewer. A person's own message reads "You", as in the room itself;
 * `person` names the household member who sent a message, when one is on record.
 */
export function previewOf(event: GroupEvent, room: GroupRoom, viewerId: string, person: (userId: string) => string | undefined): GroupLatest {
  const raw = typeof event.payload?.text === "string" ? event.payload.text : "";
  const text = raw.replace(/\s+/g, " ").trim();
  let author: string;
  if (event.kind === "message.user") {
    const sender = event.sender?.id || event.actor?.id;
    author = sender === viewerId ? "You" : event.sender?.name || person(sender ?? "") || "Household member";
  } else {
    const id = event.actor?.id ?? event.payload?.member_id;
    const member = room.members.find(item => item.member_id === id || item.member_id === event.payload?.member_id);
    author = member?.display_name || member?.profile || "Assistant";
  }
  return { text: text.length > LATEST_TEXT_CHARS ? `${text.slice(0, LATEST_TEXT_CHARS - 1).trimEnd()}…` : text, at: new Date(event.created_at * 1000).toISOString(), author };
}

type Read = (roomId: string, since: number) => Promise<GroupPage>;

/**
 * The newest message of each room, read from Hermes only when the room's `latest_seq` moves.
 * Home polls the catalog, so a quiet household costs no log reads at all, a new room costs one,
 * and a cold start costs one per room, a few at a time. A failed read leaves that room without
 * a preview until the next catalog read tries again.
 */
export class GroupLatestCache {
  private readonly seen = new Map<string, { seq: number; event?: GroupEvent }>();
  private readonly reading = new Map<string, Promise<void>>();
  constructor(private readonly read: Read) {}
  /** Brings the rooms' previews up to date, then forgets rooms that are gone. */
  async refresh(rooms: GroupRoom[]) {
    const live = new Set(rooms.map(room => room.room_id));
    for (const id of [...this.seen.keys()]) if (!live.has(id)) this.seen.delete(id);
    const stale = rooms.filter(room => typeof room.latest_seq === "number" && room.latest_seq > 0 && this.seen.get(room.room_id)?.seq !== room.latest_seq);
    const queue = [...stale];
    await Promise.all(Array.from({ length: Math.min(LATEST_READS_AT_ONCE, queue.length) }, async () => {
      for (let room = queue.shift(); room; room = queue.shift()) await this.load(room);
    }));
  }
  /** The newest message known for a room, or none. */
  latest(roomId: string) { return this.seen.get(roomId)?.event; }
  private load(room: GroupRoom) {
    const seq = room.latest_seq!;
    let reading = this.reading.get(room.room_id);
    if (!reading) {
      reading = this.read(room.room_id, Math.max(0, seq - LATEST_LOOKBACK)).then(page => {
        this.seen.set(room.room_id, { seq, event: Array.isArray(page.events) ? newestMessage(page.events) : undefined });
      }, () => {}).finally(() => this.reading.delete(room.room_id));
      this.reading.set(room.room_id, reading);
    }
    return reading;
  }
}
