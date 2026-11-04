import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import type { Routine, Runtime } from "../src/shared/types.js";
import type { GroupCatalog } from "../src/shared/collaboration.js";
import { localLogin } from "./helpers/server.js";

// Routines that also post in group chats: who may choose which room, and what each person sees.
const origin = "http://127.0.0.1:3000";
const base = { botId: "shared", name: "Morning", prompt: "Check the ranch", schedule: "1h", enabled: false, recipientIds: [] };
const room = (room_id: string, profiles: string[]) => ({ room_id, name: room_id, members: profiles.map(profile => ({ member_id: profile, profile, handle: profile })) });
let created: Awaited<ReturnType<typeof createApp>>;
let rows: Routine[];
let save: ReturnType<typeof vi.fn>;
let catalog: GroupCatalog;
let groupRequest: ReturnType<typeof vi.fn>;
let saveBot: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  rows = [{ ...base, id: "abc123", roomIds: ["team", "secret"] }];
  catalog = { supported: true, canSend: true, routineDelivery: true, rooms: [room("team", ["shared", "planner"]), room("secret", ["shared", "diary"]), room("mine", ["shared", "notes"]),
    // Two rooms without the routine's assistant: one everyone can open, one only local-one's "keeper" keeps private.
    room("crew", ["planner", "garden"]), room("den", ["planner", "keeper"])] };
  save = vi.fn(async (input, id) => ({ ...input, id: id ?? "new" }));
  groupRequest = vi.fn(async () => catalog);
  saveBot = vi.fn(async (input, id) => ({ ...input, id, activity: "idle" }));
  const runtime = {
    status: async () => ({ connected: true }),
    capabilities: async () => ({ routines: { supported: true }, botConfiguration: { supported: true }, avatarMetadata: { supported: false } }),
    listBots: async () => ["shared", "planner", "diary", "notes", "garden", "keeper"].map(id => ({ id, name: id, shared: true, activity: "idle" })),
    routines: async () => rows, saveRoutine: save, saveBot, groupRequest, close: async () => {},
  } as unknown as Runtime;
  created = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_ORIGIN: origin, APP_DATABASE: ":memory:" }), runtime, { background: false });
  // "diary" is the other member's personal assistant, so its room is hidden from local-one.
  created.store.savePresentation("diary", { shared: false, ownerId: "local-two" });
  created.store.savePresentation("notes", { shared: false, ownerId: "local-one" });
  created.store.savePresentation("keeper", { shared: false, ownerId: "local-one" });
});
afterEach(async () => { await created?.app.close(); });
const write = async (payload: object, id?: string, member = "one") => created.app.inject({ method: id ? "PUT" : "POST",
  url: `/api/routines${id ? `/${id}` : ""}`, headers: await localLogin(created.app, origin, member), payload });

it("shows each person only the rooms they can open, and keeps the hidden ones on save", async () => {
  const headers = await localLogin(created.app, origin);
  expect((await created.app.inject({ url: "/api/routines", headers })).json()[0].roomIds).toEqual(["team"]);
  const response = await write({ ...rows[0], roomIds: ["mine"] }, "abc123");
  expect(response.statusCode).toBe(200);
  // local-one dropped "team", added "mine", and never saw "secret", which stays.
  expect(save.mock.calls[0][0].roomIds).toEqual(["secret", "mine"]);
  // The other member sees "team" and their own assistant's "secret".
  const other = await localLogin(created.app, origin, "two");
  expect((await created.app.inject({ url: "/api/routines", headers: other })).json()[0].roomIds).toEqual(["team", "secret"]);
  expect(response.json().roomIds).toEqual(["mine"]);
});

it("leaves a routine's rooms alone when they are omitted or unchanged", async () => {
  expect((await write({ ...base, name: "Renamed" }, "abc123")).statusCode).toBe(200);
  expect((await write({ ...base, roomIds: ["team"] }, "abc123")).statusCode).toBe(200);
  expect(save.mock.calls.map(([input]) => "roomIds" in input)).toEqual([false, false]);
});

it("refuses rooms someone cannot open and Hermes versions that cannot post in rooms", async () => {
  expect((await write({ ...base, roomIds: ["secret"] })).statusCode).toBe(400);
  expect((await write({ ...base, roomIds: ["missing"] })).statusCode).toBe(400);
  expect((await write({ ...base, roomIds: ["bad id"] })).statusCode).toBe(400);
  catalog = { ...catalog, routineDelivery: false };
  expect((await write({ ...base, roomIds: ["team"] })).statusCode).toBe(409);
  // Removing every room needs no support from Hermes.
  expect((await write({ ...base, roomIds: [] })).statusCode).toBe(200);
  expect(save).toHaveBeenCalledTimes(1);
});

it("posts a personal assistant's results only in rooms nobody else can open", async () => {
  // "team" is open to the whole household; "mine" includes local-one's personal "notes".
  const refused = await write({ ...base, botId: "notes", roomIds: ["team"] });
  expect(refused.statusCode).toBe(400);
  expect(refused.json().code).toBe("private_recipients");
  expect((await write({ ...base, botId: "notes", roomIds: ["mine"] })).statusCode).toBe(200);
});

it("shows no rooms, rather than too many, when Hermes cannot list them", async () => {
  groupRequest.mockRejectedValue(new Error("Hermes is unreachable"));
  const listed = (await created.app.inject({ url: "/api/routines", headers: await localLogin(created.app, origin) })).json();
  expect(listed[0]).not.toHaveProperty("roomIds");
  expect((await write({ ...base, roomIds: ["team"] }, "abc123")).statusCode).toBeGreaterThanOrEqual(500);
  expect(save).not.toHaveBeenCalled();
});

const share = async (botId: string, shared: boolean) => created.app.inject({ method: "PATCH", url: `/api/bots/${botId}`, headers: await localLogin(created.app, origin),
  payload: { name: botId, instructions: "", model: "test", shared, confirmPrivate: true } });

it("refuses to make an assistant personal while its routine posts in a room others can open", async () => {
  // The review's repro: a shared assistant's routine posts in a shared room it is not in.
  rows = [{ ...base, id: "abc123", name: "Morning", roomIds: ["crew"] }];
  const refused = await share("shared", false);
  expect(refused.statusCode).toBe(409);
  expect(refused.json()).toMatchObject({ code: "routine_rooms" });
  expect(refused.json().error).toContain('"Morning" posts in "crew"');
  expect(created.store.presentation("shared").shared).not.toBe(false);
  expect(saveBot).not.toHaveBeenCalled();
  // A room that has the assistant in it closes along with it, so that change goes ahead.
  rows = [{ ...base, id: "abc123", roomIds: ["team"] }];
  expect((await share("shared", false)).statusCode).toBe(200);
  expect(created.store.presentation("shared")).toMatchObject({ shared: false, ownerId: "local-one" });
});

it("refuses to share the last personal member of a room a personal routine posts in", async () => {
  rows = [{ ...base, botId: "notes", id: "notes1", name: "Journal", roomIds: [] }];
  // "den" holds local-one's "keeper", so only local-one opens it and the personal routine may post there.
  expect((await write({ ...base, botId: "notes", roomIds: ["den"] }, "notes1")).statusCode).toBe(200);
  expect(save.mock.calls.at(-1)![0].roomIds).toEqual(["den"]);
  rows = [{ ...rows[0], roomIds: ["den"] }];
  const refused = await share("keeper", true);
  expect(refused.statusCode).toBe(409);
  expect(refused.json().code).toBe("routine_rooms");
  expect(created.store.presentation("keeper").shared).toBe(false);
  // Without such a routine, sharing it is as before.
  rows = [];
  expect((await share("keeper", true)).statusCode).toBe(200);
});

it("refuses a sharing change it cannot check, and skips the check when sharing stays the same", async () => {
  rows = [{ ...base, id: "abc123", roomIds: ["team"] }];
  groupRequest.mockRejectedValueOnce(new Error("Hermes is unreachable"));
  expect((await share("shared", false)).json().code).toBe("routine_rooms_unknown");
  groupRequest.mockClear();
  expect((await share("planner", true)).statusCode).toBe(200);
  expect(groupRequest).not.toHaveBeenCalled();
});

it("names only rooms a person can open in a routine's errors", async () => {
  rows = [{ ...base, id: "abc123", roomIds: ["team", "secret"],
    lastDeliveryError: "room:secret: no live Group Chat with that id on this machine; room:team@shared delivery failed: busy",
    lastError: "room:secret@diary delivery failed" }];
  const headers = await localLogin(created.app, origin);
  const [routine] = (await created.app.inject({ url: "/api/routines", headers })).json();
  expect(routine.lastDeliveryError).toBe("a group chat: no live Group Chat with that id on this machine; room:team@shared delivery failed: busy");
  expect(routine.lastError).toBe("a group chat delivery failed");
  // Without the room list, no room is named.
  groupRequest.mockRejectedValue(new Error("Hermes is unreachable"));
  const [blind] = (await created.app.inject({ url: "/api/routines", headers })).json();
  expect(blind.lastDeliveryError).toBe("a group chat: no live Group Chat with that id on this machine; a group chat delivery failed: busy");
  expect(blind).not.toHaveProperty("roomIds");
});
