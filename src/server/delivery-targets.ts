// How Hermes reads a routine's delivery targets, mirrored exactly so the app checks every group chat Hermes
// will post in. This is the only place the app parses `deliver`. Sources, at Hermes 3a1e9ef:
//   cron/scheduler_delivery.py: _normalize_deliver_value, _delivery_lane_value, _resolve_delivery_targets,
//     _resolve_single_delivery_target, _resolve_origin, and the "room" platform check in the send loop
//   cron/scheduler_delivery_room.py: parse_room_deliver_token, _ROOM_TOKEN_RE, deliver_to_room

/** A routine's delivery fields as Hermes stores them. Server only, never sent to clients. */
export interface RoutineDelivery { deliver?: unknown; failure_deliver?: unknown; origin?: unknown }

/** The rooms a routine posts in, by room identity, or `unknown` when Hermes's reading cannot be mirrored. */
export type DeliveryRooms = { rooms: string[]; unknown: false } | { rooms: string[]; unknown: true };

// _ROOM_TOKEN_RE: a room ID, then an optional @<profile> naming the gateway that hosts it.
const ROOM_ADDRESS = /^(?<room>[A-Za-z0-9][A-Za-z0-9._:-]*)(?:@(?<profile>[A-Za-z0-9_-]+))?$/;
const ROOM_PREFIX = "room:";

/**
 * parse_room_deliver_token: `room:<id>[@<profile>]`, with any case and spacing Hermes accepts, gives its
 * address; a malformed room token gives "" (Hermes skips it); anything else gives null.
 */
export function parseRoomToken(part: string): string | null {
  const raw = part.trim();
  if (!raw.toLowerCase().startsWith(ROOM_PREFIX)) return null;
  const rest = raw.slice(ROOM_PREFIX.length).trim();
  return ROOM_ADDRESS.test(rest) ? rest : "";
}
/** The room an address names. `den` and `den@keeper` are the same room. */
export function roomOfAddress(address: string): string | undefined {
  return ROOM_ADDRESS.exec(address)?.groups?.room;
}

/**
 * _normalize_deliver_value: one comma-separated string, "local" when empty. Undefined for a value whose
 * Python text the app cannot reproduce (anything but text, a number or a list of them).
 */
function normalize(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return "local";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    if (!value.every(item => typeof item === "string" || typeof item === "number")) return undefined;
    const parts = value.map(item => String(item).trim()).filter(Boolean);
    return parts.length ? parts.join(",") : "local";
  }
  return undefined;
}

/**
 * _delivery_lane_value for both outcomes: a success reads `deliver`, a failure reads `failure_deliver`
 * instead when it is set and not blank. Both can post, so both count.
 */
function lanes(job: RoutineDelivery): unknown[] {
  const success = "deliver" in job ? job.deliver : "local";
  const failure = job.failure_deliver;
  const failureSet = failure !== null && failure !== undefined && (typeof failure !== "string" || failure.trim() !== "");
  return failureSet ? [success, failure] : [success];
}

/** _resolve_origin: the job's origin when it names a platform and chat. Undefined when unusable. */
function origin(job: RoutineDelivery): { platform: string; chat: string } | undefined | "unknown" {
  const value = job.origin;
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { platform, chat_id: chat } = value as { platform?: unknown; chat_id?: unknown };
  if (!platform || !chat) return undefined;
  if (typeof platform !== "string" || (typeof chat !== "string" && typeof chat !== "number")) return "unknown";
  return { platform, chat: String(chat) };
}

/**
 * Every room a routine's delivery posts in, from every lane Hermes honors, by room identity. A target
 * resolves to the "room" platform in three ways: a `room:<id>[@<profile>]` token; `origin` when the job's
 * origin is a room; and the bare platform name `room` when the origin is a room, which falls back to the
 * origin chat. Routing tokens such as `all` expand to home channels, which are never rooms.
 */
export function deliveryRooms(job: RoutineDelivery): DeliveryRooms {
  const rooms = new Set<string>();
  let unknown = false;
  const from = origin(job);
  const originRoom = () => {
    if (from === "unknown") { unknown = true; return; }
    if (from?.platform !== "room") return;
    const room = roomOfAddress(from.chat);
    if (room) rooms.add(room);
  };
  for (const lane of lanes(job)) {
    const value = normalize(lane);
    if (value === undefined) { unknown = true; continue; }
    if (value === "local") continue;
    for (const raw of value.split(",")) {
      const part = raw.trim();
      if (!part) continue;
      const address = parseRoomToken(part);
      if (address !== null) {
        const room = address && roomOfAddress(address);
        if (room) rooms.add(room);
        continue;
      }
      if (part === "origin" || part === "room") originRoom();
    }
  }
  return { rooms: [...rooms], unknown } as DeliveryRooms;
}

/**
 * The group chats the app manages for a routine: plain `room:<id>` tokens in `deliver`, however Hermes
 * spaces or capitalizes them. A room named for a profile, any other lane and origin delivery were written
 * outside the app and stay as they are; `deliveryRooms` still checks them.
 */
export function deliverRooms(deliver: unknown): string[] {
  const value = normalize(deliver);
  if (value === undefined || value === "local") return [];
  return [...new Set(value.split(",").flatMap(part => {
    const address = parseRoomToken(part);
    return address && !address.includes("@") ? [address] : [];
  }))];
}

/**
 * `deliver` with exactly these group chats among the app's own room tokens, keeping every other target
 * as written. Undefined when the current value cannot be read, so nothing is rewritten from a guess.
 */
export function withDeliverRooms(deliver: unknown, roomIds: string[]): string | undefined {
  const value = normalize(deliver);
  if (value === undefined) return undefined;
  const parts = value === "local" ? [] : value.split(",").map(part => part.trim()).filter(Boolean);
  const others = parts.filter(part => { const address = parseRoomToken(part); return !(address && !address.includes("@")) && part !== "local"; });
  const targets = [...others, ...[...new Set(roomIds)].map(id => `room:${id}`)];
  return targets.length ? targets.join(",") : "local";
}

/**
 * Every room a routine posts in now. A runtime that reports no delivery fields, such as a test double,
 * has only the rooms it lists.
 */
export function routineTargets(routine: { roomIds?: string[]; delivery?: RoutineDelivery }): DeliveryRooms {
  return routine.delivery ? deliveryRooms(routine.delivery) : { rooms: [...new Set(routine.roomIds ?? [])], unknown: false };
}

/**
 * Every room a routine will post in after a save that sets the app's rooms to `roomIds` (undefined leaves
 * them). Computed from the delivery Hermes will then hold, never by subtracting what the client sees.
 */
export function routineTargetsAfter(current: { roomIds?: string[]; delivery?: RoutineDelivery } | undefined, botId: string, roomIds: string[] | undefined): DeliveryRooms {
  if (!current) return routineTargets({ delivery: { deliver: withDeliverRooms(`bot-chat:${botId}`, roomIds ?? []) } });
  if (roomIds === undefined) return routineTargets(current);
  if (!current.delivery) return routineTargets({ roomIds });
  const deliver = withDeliverRooms(current.delivery.deliver, roomIds);
  return deliver === undefined ? { rooms: [], unknown: true } : deliveryRooms({ ...current.delivery, deliver });
}
