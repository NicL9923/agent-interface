// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { GroupRoom } from "../src/shared/collaboration";
import type { Bot } from "../src/shared/types";
import { memberNames, orderRooms, pendingGroup, roomFaces, roomPreview } from "../src/app/home-rooms";
import { groupCreateKey } from "../src/app/storage";

const member = (id: string, name?: string) => ({ member_id: id, profile: id, handle: id, display_name: name });
const room = (id: string, at?: string, extra: Partial<GroupRoom> = {}): GroupRoom => ({
  room_id: id, name: id, members: [member("ranch", "Ranch hand"), member("planner", "Planner")],
  ...at ? { latest: { text: `Hello from ${id}`, at, author: "Planner" } } : {}, ...extra,
});

describe("home group chat rows", () => {
  it("puts the newest message first and keeps the catalog order for ties and quiet rooms", () => {
    const rooms = [room("quiet-a"), room("old", "2026-10-01T10:00:00Z"), room("quiet-b"), room("new", "2026-10-30T10:00:00Z"), room("same", "2026-10-01T10:00:00Z")];
    expect(orderRooms(rooms).map(item => item.room_id)).toEqual(["new", "old", "same", "quiet-a", "quiet-b"]);
  });
  it("does not reorder rooms whose messages are older than a later poll shows the same", () => {
    const rooms = [room("a", "2026-10-01T10:00:00Z"), room("b", "2026-10-02T10:00:00Z")];
    expect(orderRooms(orderRooms(rooms)).map(item => item.room_id)).toEqual(["b", "a"]);
    expect(rooms.map(item => item.room_id)).toEqual(["a", "b"]);
  });
  it("previews the last speaker and words, or says nobody has spoken", () => {
    expect(roomPreview(room("a", "2026-10-01T10:00:00Z"))).toBe("Planner: Hello from a");
    expect(roomPreview(room("b"))).toBe("No messages yet");
    expect(roomPreview(room("c", undefined, { latest: { text: "", at: "2026-10-01T10:00:00Z", author: "You" } }))).toBe("No messages yet");
  });
  it("shows at most three faces and tolerates a member the person cannot see as an avatar", () => {
    const bots = [{ id: "ranch", name: "Ranch hand" }, { id: "planner", name: "Planner" }] as Bot[];
    const big = room("big", undefined, { members: ["ranch", "planner", "kitchen", "garden"].map(id => member(id)) });
    expect(roomFaces(big, bots).map(face => [face.member.member_id, face.bot?.id])).toEqual([["ranch", "ranch"], ["planner", "planner"], ["kitchen", undefined]]);
  });
  it("names members in words", () => {
    expect(memberNames(room("a"))).toBe("Ranch hand and Planner");
    expect(memberNames(room("b", undefined, { members: [member("ranch", "Ranch hand"), member("planner"), member("kitchen", "Kitchen")] }))).toBe("Ranch hand, planner and Kitchen");
  });
});

describe("a group creation waiting to be finished", () => {
  beforeEach(() => localStorage.clear());
  it("is read for the signed-in person only, and a damaged copy is ignored", () => {
    const saved = { requestId: "r", name: "Garden crew", botIds: ["ranch", "planner"] };
    localStorage.setItem(groupCreateKey("one"), JSON.stringify(saved));
    expect(pendingGroup("one")).toEqual(saved);
    expect(pendingGroup("two")).toBeNull();
    localStorage.setItem(groupCreateKey("one"), JSON.stringify({ name: 3 }));
    expect(pendingGroup("one")).toBeNull();
  });
});
