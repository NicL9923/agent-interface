import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
let assistants: string[];
let slowRead: Promise<void> | undefined;
let readsBeforeSlow = 0;
const setRoutineEnabled = vi.fn(async () => {});
const deleteRoutine = vi.fn(async (_id: string, _botId: string) => {});
beforeEach(async () => {
  rows = [{ ...base, id: "abc123", roomIds: ["team", "secret"] }];
  catalog = { supported: true, canSend: true, routineDelivery: true, rooms: [room("team", ["shared", "planner"]), room("secret", ["shared", "diary"]), room("mine", ["shared", "notes"]),
    // Two rooms without the routine's assistant: one everyone can open, one only local-one's "keeper" keeps private.
    room("crew", ["planner", "garden"]), room("den", ["planner", "keeper"]),
    // Only local-two opens "lodge", through their "diary".
    room("lodge", ["planner", "diary"])] };
  save = vi.fn(async (input, id) => ({ ...input, id: id ?? "new" }));
  groupRequest = vi.fn(async () => catalog);
  assistants = ["shared", "planner", "diary", "notes", "garden", "keeper"];
  saveBot = vi.fn(async (input, id) => { const botId = id ?? input.name; if (!assistants.includes(botId)) assistants.push(botId); return { ...input, id: botId, activity: "idle" }; });
  const runtime = {
    status: async () => ({ connected: true }),
    capabilities: async () => ({ routines: { supported: true }, botConfiguration: { supported: true }, avatarMetadata: { supported: false } }),
    listBots: async () => assistants.map(id => ({ id, name: id, shared: true, activity: "idle" })),
    deleteBot: async (id: string) => { assistants = assistants.filter(other => other !== id); },
    deleteRoutine,
    setRoutineEnabled, experienceRequest: async () => ({ requestId: "r", routineId: "abc123", botId: "shared", status: "accepted" }),
    // A read copies the routines when Hermes is asked. `slowRead` holds back the answer to the read after
    // `readsBeforeSlow` more, as a slow Hermes would.
    routines: async () => {
      const copy = structuredClone(rows);
      if (slowRead && readsBeforeSlow-- === 0) { const wait = slowRead; slowRead = undefined; await wait; }
      return copy;
    }, saveRoutine: save, saveBot, groupRequest, close: async () => {},
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
  // Exact Hermes strings: cron/scheduler_delivery_room.py names the target and, on an authority conflict,
  // repeats the profile; cron/scheduler_delivery.py joins a run's errors with "; ".
  const conflict = "room:secret@diary delivery failed: This Group Chat is managed by another gateway. @diary does not host it. If a profile's gateway hosts this room, deliver to room:secret@<that profile> (Room settings shows the exact target).";
  const gone = "room:team: no live Group Chat with that id on this machine";
  rows = [
    { ...base, id: "abc123", roomIds: ["team", "secret"], lastDeliveryError: `${conflict}; ${gone}`, lastError: "room:secret@diary: no profile named 'diary' on this machine (Room settings shows the exact target)" },
    { ...base, id: "def456", roomIds: ["team"], lastDeliveryError: gone },
    // No room named, but the hidden assistant is.
    { ...base, id: "ghi789", roomIds: [], lastDeliveryError: "bot-chat delivery to profile 'diary' unverified: no canonical Bot Chat" },
  ];
  const headers = await localLogin(created.app, origin);
  const listed = (await created.app.inject({ url: "/api/routines", headers })).json();
  expect(listed.map((row: Routine) => [row.lastDeliveryError, row.lastError])).toEqual([
    ["Couldn't post in a group chat you can't open.", "Couldn't post in a group chat you can't open."],
    [gone, undefined],
    ["Message from another member's assistant: This message is private.", undefined],
  ]);
  expect(JSON.stringify(listed)).not.toContain("diary");
  // The member who can open "secret" sees Hermes's words.
  const other = (await created.app.inject({ url: "/api/routines", headers: await localLogin(created.app, origin, "two") })).json();
  expect(other[0].lastDeliveryError).toBe(`${conflict}; ${gone}`);
  // Without the room list, no error that names a room is shown.
  groupRequest.mockRejectedValue(new Error("Hermes is unreachable"));
  const blind = (await created.app.inject({ url: "/api/routines", headers })).json();
  expect(blind[1].lastDeliveryError).toBe("Couldn't post in a group chat you can't open.");
  expect(blind[0]).not.toHaveProperty("roomIds");
});

const create = async (name: string, shared: boolean, member = "one") => created.app.inject({ method: "POST", url: "/api/bots", headers: await localLogin(created.app, origin, member),
  payload: { name, instructions: "", model: "test", shared } });

it("lets a room's last personal member be deleted, but refuses a shared assistant that would reopen the room under its ID", async () => {
  // The reported gap: a personal routine posts in "den", private only because of local-one's "keeper".
  rows = [{ ...base, botId: "notes", id: "notes1", name: "Journal", roomIds: ["den"] }];
  const headers = await localLogin(created.app, origin);
  expect((await created.app.inject({ method: "DELETE", url: "/api/bots/keeper", headers })).statusCode).toBe(200);
  // A room listing a deleted assistant opens for nobody, so it is gone from every list.
  for (const member of ["one", "two"])
    expect((await created.app.inject({ url: "/api/groups", headers: await localLogin(created.app, origin, member) })).json().rooms.map((row: { room_id: string }) => row.room_id)).not.toContain("den");
  // A new shared "keeper" would open "den" to the household while "Journal" still posts there.
  const refused = await create("keeper", true, "two");
  expect(refused.statusCode).toBe(409);
  expect(refused.json().code).toBe("routine_rooms");
  // local-two cannot see local-one's routine or room, so neither is named.
  expect(refused.json().error).toContain("another member's routine posts in a group chat");
  expect(saveBot).not.toHaveBeenCalled();
  expect(created.store.presentation("keeper")).toEqual({});
  // A personal "keeper" of the routine's owner keeps the room private, so that one may be made.
  expect((await create("keeper", false)).statusCode).toBe(200);
});

it("treats a room member that is no longer an assistant as closing the room", async () => {
  // "crew" is open to everyone while "garden" exists; without it, nobody can open the room.
  assistants = assistants.filter(id => id !== "garden");
  rows = [{ ...base, id: "abc123", roomIds: ["crew"] }];
  expect((await share("shared", false)).statusCode).toBe(200);
});

it("merges a routine save with the rooms it has when its turn comes, not when it started", async () => {
  // The re-review's repro: the shared assistant's routine posts in "team" and in "lodge", which only local-two opens.
  rows = [{ ...base, id: "abc123", roomIds: ["team", "lodge"] }];
  save.mockImplementation(async (input, id) => {
    if (input.roomIds) rows = rows.map(row => row.id === id ? { ...row, roomIds: input.roomIds } : row);
    return { ...input, id };
  });
  // Save A, by local-one, adds "mine". The access check reads the routines first; Hermes is slow to answer
  // the save's own read, which captures the routine's rooms.
  let release!: () => void;
  slowRead = new Promise(resolve => { release = resolve; });
  readsBeforeSlow = 1;
  const a = write({ ...base, roomIds: ["team", "mine"] }, "abc123");
  await vi.waitFor(() => expect(slowRead).toBeUndefined());
  // Save B, by local-two, removes "lodge". Then local-one makes the assistant personal, which is safe now.
  expect((await write({ ...base, roomIds: ["team"] }, "abc123", "two")).statusCode).toBe(200);
  expect(rows[0].roomIds).toEqual(["team"]);
  expect((await share("shared", false)).statusCode).toBe(200);
  release();
  const saved = await a;
  expect(saved.statusCode).toBe(200);
  // A does not bring back "lodge", which local-two could open but no longer see the assistant behind.
  expect(rows[0].roomIds).toEqual(["team", "mine"]);
});

it("refuses a save whose rooms, including ones the saver cannot see, would expose the routine", async () => {
  // As Hermes, its CLI or an agent can leave it: a personal routine already posts in "lodge", which only local-two opens.
  created.store.savePresentation("shared", { shared: false, ownerId: "local-one" });
  rows = [{ ...base, id: "abc123", roomIds: ["lodge"] }];
  const refused = await write({ ...base, enabled: true, roomIds: ["team"] }, "abc123");
  expect(refused.statusCode).toBe(409);
  expect(refused.json().code).toBe("routine_rooms");
  expect(save).not.toHaveBeenCalled();
});

describe("a paused personal routine that posts in a room only another member can open", () => {
  const headers = () => localLogin(created.app, origin);
  beforeEach(() => {
    created.store.savePresentation("shared", { shared: false, ownerId: "local-one" });
    rows = [{ ...base, id: "abc123", enabled: false, roomIds: ["lodge"] }];
  });
  it("cannot be enabled by a save that leaves its rooms alone", async () => {
    // The re-review's repro: its owner sees no rooms, and saves it enabled without naming any.
    const [listed] = (await created.app.inject({ url: "/api/routines", headers: await headers() })).json();
    expect(listed.roomIds).toEqual([]);
    const refused = await write({ ...base, enabled: true }, "abc123");
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("routine_rooms");
    expect(save).not.toHaveBeenCalled();
    // Kept paused, any change still saves.
    expect((await write({ ...base, name: "Renamed" }, "abc123")).statusCode).toBe(200);
  });
  it("cannot be resumed or run, but can be paused", async () => {
    setRoutineEnabled.mockClear();
    const resumed = await created.app.inject({ method: "PATCH", url: "/api/routines/abc123/state", headers: await headers(), payload: { enabled: true } });
    expect(resumed.json().code).toBe("routine_rooms");
    const run = await created.app.inject({ method: "POST", url: "/api/routines/abc123/run", headers: await headers(), payload: { requestId: crypto.randomUUID() } });
    expect(run.json().code).toBe("routine_rooms");
    expect(setRoutineEnabled).not.toHaveBeenCalled();
    expect((await created.app.inject({ method: "PATCH", url: "/api/routines/abc123/state", headers: await headers(), payload: { enabled: false } })).statusCode).toBe(200);
    expect(setRoutineEnabled).toHaveBeenCalledWith("shared", "abc123", false);
  });
  it("is checked for a target written as room:<id>@<profile>, which the app never shows", async () => {
    rows = [{ ...base, id: "abc123", enabled: false, roomIds: [], delivery: { deliver: "bot-chat:shared,room:lodge@diary" } }];
    expect((await write({ ...base, enabled: true }, "abc123")).json().code).toBe("routine_rooms");
    // It is never sent to anyone.
    const [listed] = (await created.app.inject({ url: "/api/routines", headers: await headers() })).json();
    expect(listed).not.toHaveProperty("delivery");
  });
});

describe("every delivery field Hermes honors, read as Hermes reads it", () => {
  // "shared" is local-one's personal assistant here, so a room local-two can open must never hear from it.
  beforeEach(() => { created.store.savePresentation("shared", { shared: false, ownerId: "local-one" }); });
  it("checks a room named for a profile even when the save removes the same room's plain token", async () => {
    // Re-review repro 1: "crew" is open to everyone; the app's token goes, "room:crew@keeper" stays.
    rows = [{ ...base, id: "abc123", enabled: false, roomIds: ["crew"], delivery: { deliver: "bot-chat:shared,room:crew,room:crew@keeper" } }];
    const refused = await write({ ...base, enabled: true, roomIds: [] }, "abc123");
    expect(refused.json().code).toBe("routine_rooms");
    expect(save).not.toHaveBeenCalled();
  });
  it("refuses sharing a room's last personal member while a routine posts there for a profile", async () => {
    // Re-review repro 2: local-one's personal "notes" posts in "den" only through "room:den@keeper".
    rows = [{ ...base, botId: "notes", id: "notes1", enabled: true, roomIds: [], delivery: { deliver: "bot-chat:notes,room:den@keeper" } }];
    const refused = await share("keeper", true);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("routine_rooms");
  });
  it("reads room tokens with the spacing Hermes trims", async () => {
    // Re-review repro 3: Hermes delivers "room: crew" and "room: crew@keeper".
    for (const deliver of ["bot-chat:shared,room: crew", "bot-chat:shared, room: crew@keeper"]) {
      rows = [{ ...base, id: "abc123", enabled: false, roomIds: [], delivery: { deliver } }];
      expect((await write({ ...base, enabled: true }, "abc123")).json().code).toBe("routine_rooms");
    }
    expect(save).not.toHaveBeenCalled();
  });
  it("checks failure_deliver, which Hermes uses for a failed run's notice", async () => {
    // Re-review repro 5.
    rows = [{ ...base, id: "abc123", enabled: false, roomIds: [], delivery: { deliver: "bot-chat:shared", failure_deliver: "room:crew" } }];
    expect((await write({ ...base, enabled: true }, "abc123")).json().code).toBe("routine_rooms");
    const resumed = await created.app.inject({ method: "PATCH", url: "/api/routines/abc123/state", headers: await localLogin(created.app, origin), payload: { enabled: true } });
    expect(resumed.json().code).toBe("routine_rooms");
  });
  it("refuses to enable a routine whose delivery it cannot read", async () => {
    rows = [{ ...base, id: "abc123", enabled: false, roomIds: [], delivery: { deliver: { room: "crew" } } }];
    expect((await write({ ...base, enabled: true }, "abc123")).json().code).toBe("routine_rooms_unknown");
    // Paused, it still saves.
    expect((await write({ ...base, name: "Renamed" }, "abc123")).statusCode).toBe(200);
  });
});

describe("lookups, catalogs and whitespace exactly as Hermes has them", () => {
  beforeEach(() => { created.store.savePresentation("shared", { shared: false, ownerId: "local-one" }); });
  it("checks the named assistant's routine when another assistant has a job with the same ID", async () => {
    // A harmless copy on "planner" is listed first; "shared"'s copy posts in "crew", which everyone opens.
    rows = [{ ...base, botId: "planner", id: "dup", enabled: false, roomIds: [] },
      { ...base, id: "dup", enabled: false, roomIds: ["crew"], delivery: { deliver: "bot-chat:shared,room:crew" } }];
    expect((await write({ ...base, enabled: true }, "dup")).json().code).toBe("routine_rooms");
    // An ID-only route cannot tell two visible copies apart, so it changes neither.
    const resumed = await created.app.inject({ method: "PATCH", url: "/api/routines/dup/state", headers: await localLogin(created.app, origin), payload: { enabled: true } });
    expect(resumed.json().code).toBe("routine_ambiguous");
    expect(save).not.toHaveBeenCalled();
  });
  it("refuses delivery and sharing changes when Hermes offers no room catalog", async () => {
    catalog = { supported: false, canSend: false, rooms: [] };
    rows = [{ ...base, id: "abc123", enabled: false, roomIds: ["crew"], delivery: { deliver: "bot-chat:shared,room:crew" } }];
    expect((await write({ ...base, enabled: true }, "abc123")).json().code).toBe("routine_rooms_unknown");
    expect((await share("planner", false)).json().code).toBe("routine_rooms_unknown");
    expect(save).not.toHaveBeenCalled();
  });
  it("reads a target Hermes trims with Python whitespace", async () => {
    rows = [{ ...base, id: "abc123", enabled: false, roomIds: [], delivery: { deliver: "bot-chat:shared,\u001croom:\u0085crew" } }];
    expect((await write({ ...base, enabled: true }, "abc123")).json().code).toBe("routine_rooms");
  });
});

describe("routes that name only a routine ID, when two assistants hold jobs with it", () => {
  // "diary" is local-two's personal assistant, so its copy of "dup" is hidden from local-one.
  beforeEach(() => { deleteRoutine.mockClear(); rows = [{ ...base, botId: "diary", id: "dup", roomIds: [] }, { ...base, botId: "planner", id: "dup", roomIds: [] }]; });
  it("deletes the copy the person can see and tells Hermes its assistant", async () => {
    const headers = await localLogin(created.app, origin);
    expect((await created.app.inject({ method: "DELETE", url: "/api/routines/dup", headers })).statusCode).toBe(200);
    expect(deleteRoutine).toHaveBeenCalledWith("dup", "planner");
  });
  it("deletes nothing when the person can see both copies", async () => {
    rows = [{ ...base, botId: "shared", id: "dup", roomIds: [] }, { ...base, botId: "planner", id: "dup", roomIds: [] }];
    const refused = await created.app.inject({ method: "DELETE", url: "/api/routines/dup", headers: await localLogin(created.app, origin) });
    expect(refused.json().code).toBe("routine_ambiguous");
    expect(deleteRoutine).not.toHaveBeenCalled();
  });
  it("lets a trial of the hidden copy block only that copy", async () => {
    // local-two's trial of their "diary" copy is still running.
    created.store.user({ id: "local-two", name: "two", email: "two@example.invalid" });
    created.store.rememberRoutineTrial(crypto.randomUUID(), "local-two", "dup", "diary");
    expect((await write({ ...base, botId: "planner", name: "Renamed" }, "dup")).statusCode).toBe(200);
    expect((await created.app.inject({ method: "PATCH", url: "/api/routines/dup/state", headers: await localLogin(created.app, origin), payload: { enabled: false } })).statusCode).toBe(200);
    expect((await created.app.inject({ method: "DELETE", url: "/api/routines/dup", headers: await localLogin(created.app, origin) })).statusCode).toBe(200);
  });
});
