import { describe, expect, it } from "vitest";
import { GroupLatestCache } from "../src/server/group-latest";
import type { GroupPage, GroupRoom } from "../src/shared/collaboration";

const room = (id: string, seq: number): GroupRoom => ({ room_id: id, name: id, latest_seq: seq, members: [] });
const page = (id: string, seq: number): GroupPage => ({ events: [{ event_id: `${id}-${seq}`, seq, kind: "message.member", created_at: 1, actor: { kind: "member", id: "m" }, payload: { text: id } }] } as unknown as GroupPage);

describe("GroupLatestCache", () => {
  it("keeps a room another viewer can't see, so their polls don't reread it", async () => {
    const reads: string[] = [];
    const cache = new GroupLatestCache(async (roomId, since) => { reads.push(roomId); return page(roomId, since + 1); });
    const mine = room("mine", 3), shared = room("shared", 2), catalog = [mine, shared];
    await cache.refresh([mine, shared], catalog);
    // Someone who can't see "mine" polls, then the owner polls again with nothing new.
    await cache.refresh([shared], catalog);
    await cache.refresh([mine, shared], catalog);
    expect(reads.sort()).toEqual(["mine", "shared"]);
    expect(cache.latest("mine")).toBeDefined();
  });

  it("forgets a room once Hermes no longer lists it", async () => {
    const cache = new GroupLatestCache(async (roomId, since) => page(roomId, since + 1));
    await cache.refresh([room("gone", 1)]);
    await cache.refresh([], []);
    expect(cache.latest("gone")).toBeUndefined();
  });
});
