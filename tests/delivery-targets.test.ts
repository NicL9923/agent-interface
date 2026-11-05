import { describe, expect, it } from 'vitest';
import { deliverRooms, deliveryRooms, parseRoomToken, routineTargetsAfter, withDeliverRooms } from '../src/server/delivery-targets';

// Cases from Hermes 3a1e9ef's own rules and tests: cron/scheduler_delivery_room.py (parse_room_deliver_token,
// _ROOM_TOKEN_RE), tests/cron/test_cron_room_delivery.py, cron/scheduler_delivery.py (_normalize_deliver_value,
// _delivery_lane_value, _resolve_single_delivery_target) and tests/cron/test_cron_failure_deliver.py.
const ROOM_ID = 'room-cron';
const rooms = (job: Parameters<typeof deliveryRooms>[0]) => deliveryRooms(job);

describe('parse_room_deliver_token', () => {
  it('reads a room token as Hermes does, with any case and spacing it trims', () => {
    expect(parseRoomToken(`room:${ROOM_ID}`)).toBe(ROOM_ID);
    expect(parseRoomToken(`room:${ROOM_ID}@research`)).toBe(`${ROOM_ID}@research`);
    expect(parseRoomToken('room: lodge')).toBe('lodge');
    expect(parseRoomToken('  ROOM: lodge@diary ')).toBe('lodge@diary');
    expect(parseRoomToken('Room:a.b:c-d_e')).toBe('a.b:c-d_e');
  });
  it('tells a malformed room token ("" — Hermes skips it) from a non-room target (null)', () => {
    expect(parseRoomToken('room:')).toBe('');
    expect(parseRoomToken('room:lodge @diary')).toBe('');
    expect(parseRoomToken('room:-lodge')).toBe('');
    expect(parseRoomToken('room:lodge@di.ary')).toBe('');
    expect(parseRoomToken('bot-chat:ranch')).toBeNull();
    expect(parseRoomToken('rooms:lodge')).toBeNull();
    expect(parseRoomToken('room')).toBeNull();
  });
});

describe('every room a routine posts in', () => {
  it('reads deliver like _normalize_deliver_value: comma text, lists, empty and local', () => {
    expect(rooms({ deliver: `room:${ROOM_ID}` })).toEqual({ rooms: [ROOM_ID], unknown: false });
    expect(rooms({ deliver: 'room:' })).toEqual({ rooms: [], unknown: false });
    expect(rooms({ deliver: 'room:nope' })).toEqual({ rooms: ['nope'], unknown: false });
    expect(rooms({ deliver: ['bot-chat:ranch', ' room: lodge '] })).toEqual({ rooms: ['lodge'], unknown: false });
    expect(rooms({ deliver: 'bot-chat:ranch, room:den,room:den@keeper,all,telegram:-1001:17' })).toEqual({ rooms: ['den'], unknown: false });
    for (const deliver of [undefined, null, '', 'local', []]) expect(rooms({ deliver })).toEqual({ rooms: [], unknown: false });
    // A key Hermes would not find reads as local, as job.get("deliver", "local") does.
    expect(rooms({})).toEqual({ rooms: [], unknown: false });
  });
  it('reads failure_deliver as a second lane when it is set and not blank', () => {
    expect(rooms({ deliver: 'local', failure_deliver: 'room:alerts' }).rooms).toEqual(['alerts']);
    expect(rooms({ deliver: 'room:den', failure_deliver: ['room: lodge@diary'] }).rooms).toEqual(['den', 'lodge']);
    expect(rooms({ deliver: 'room:den', failure_deliver: '   ' }).rooms).toEqual(['den']);
    expect(rooms({ deliver: 'slack:D0MAIN', failure_deliver: 'slack:D0ALERTS,telegram:-1001:17' }).rooms).toEqual([]);
  });
  it('counts origin delivery into the room a job came from', () => {
    const origin = { platform: 'room', chat_id: 'lodge@diary' };
    expect(rooms({ deliver: 'origin', origin }).rooms).toEqual(['lodge']);
    // A bare platform name matching the origin falls back to the origin chat.
    expect(rooms({ deliver: 'room', origin }).rooms).toEqual(['lodge']);
    expect(rooms({ deliver: 'origin', origin: { platform: 'telegram', chat_id: '5' } }).rooms).toEqual([]);
    expect(rooms({ deliver: 'origin', origin: 'combined-digest-replaces-x-and-y' }).rooms).toEqual([]);
  });
  it('reports what it cannot mirror as unknown instead of guessing', () => {
    expect(rooms({ deliver: { room: 'lodge' } }).unknown).toBe(true);
    expect(rooms({ deliver: ['room:den', { room: 'lodge' }] }).unknown).toBe(true);
    expect(rooms({ deliver: 'local', failure_deliver: true }).unknown).toBe(true);
    expect(rooms({ deliver: 'origin', origin: { platform: ['room'], chat_id: 'lodge' } }).unknown).toBe(true);
  });
});

describe("the app's own rooms", () => {
  it('lists and rewrites only plain room tokens in deliver, keeping every other target as written', () => {
    expect(deliverRooms('bot-chat:ranch, room: dinner,room:team@other,ROOM:dinner')).toEqual(['dinner']);
    expect(withDeliverRooms('bot-chat:ranch,room: old,room:team@other,telegram', ['new', 'new'])).toBe('bot-chat:ranch,room:team@other,telegram,room:new');
    expect(withDeliverRooms('local', ['a'])).toBe('room:a');
    expect(withDeliverRooms('room:a', [])).toBe('local');
    expect(withDeliverRooms({ odd: true }, ['a'])).toBeUndefined();
  });
  it("finds every room after a save from Hermes's delivery, never by subtracting the client's rooms", () => {
    const current = { roomIds: ['den'], delivery: { deliver: 'bot-chat:shared,room:den,room:den@keeper', failure_deliver: 'room:alerts' } };
    expect(routineTargetsAfter(current, 'shared', []).rooms.sort()).toEqual(['alerts', 'den']);
    expect(routineTargetsAfter(undefined, 'shared', ['team'])).toEqual({ rooms: ['team'], unknown: false });
    expect(routineTargetsAfter({ delivery: { deliver: 42n } }, 'shared', ['team']).unknown).toBe(true);
  });
});
