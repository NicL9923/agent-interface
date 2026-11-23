import { afterEach, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { MERGE_PATCH } from "../src/shared/merge-patch.js";
import { defaultPreferences, type Preferences } from "../src/shared/types.js";
import { fakeRuntime, signIn } from "./helpers/server.js";

const origin = "https://app.example.invalid";
const apps: Awaited<ReturnType<typeof createApp>>["app"][] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
/** Every field a save can set, plus the ones only their own routes change. */
const saved: Preferences = {
  presentation: "advanced",
  theme: "dark",
  favorites: ["ranch"],
  modelFavorites: [{ provider: "subscription", model: "saved-model" }],
  defaultBotId: "ranch",
  sections: [{ id: "work", name: "Work", botIds: ["ranch"] }],
  followBots: ["ranch"],
  startPage: "today",
  chatStyle: "classic",
  ownBubble: "solid",
  notifications: { timezone: "UTC", quietStart: "22:00", quietEnd: "07:00", batchMinutes: 5 },
  hiddenRoutineRuns: [{ botId: "ranch", routineId: "morning" }],
  mainBotId: "ranch",
  checkIns: { enabled: true, everyHours: 2, timezone: "UTC" },
  mainSuggestionDismissed: true,
};
async function setup() {
  const config = loadConfig({
    NODE_ENV: "production",
    APP_ORIGIN: origin,
    APP_DATABASE: ":memory:",
    GOOGLE_CLIENT_ID: "fixture-client",
    HOUSEHOLD_EMAILS: "one@example.invalid",
  });
  const { app, store } = await createApp(config, fakeRuntime({ close: async () => {} }), {
    background: false,
  });
  apps.push(app);
  const headers = signIn(store, origin, "one");
  store.savePreferences("one", structuredClone(saved));
  const send = (payload: unknown, contentType: string, url = "/api/preferences") =>
    app.inject({
      method: url === "/api/preferences" ? "PATCH" : "PUT",
      url,
      headers: { ...headers, "content-type": contentType },
      payload: JSON.stringify(payload),
    });
  return {
    app,
    headers,
    store,
    patch: (payload: unknown) => send(payload, MERGE_PATCH),
    whole: (payload: unknown) => send(payload, "application/json"),
    send,
  };
}
const paths = (response: { json(): { details?: { path: unknown[] }[] } }) =>
  response.json().details?.map((detail) => detail.path);

it("changes only the fields a partial save names", async () => {
  const s = await setup();
  const response = await s.patch({ theme: "light", favorites: ["creek"] });
  expect(response.statusCode).toBe(200);
  expect(s.store.preferences("one")).toEqual({ ...saved, theme: "light", favorites: ["creek"] });
});

it("lands two partial saves of different fields made from the same stale copy", async () => {
  const s = await setup();
  // Two devices hold `saved`. A whole object from either would write its old copy over the other's change.
  await s.patch({ theme: "light" });
  await s.patch({ sections: [] });
  expect(s.store.preferences("one")).toEqual({ ...saved, theme: "light", sections: [] });
});

it("clears a clearable field sent as null and merges notifications key by key", async () => {
  const s = await setup();
  expect((await s.patch({ defaultBotId: null })).statusCode).toBe(200);
  expect(s.store.preferences("one")).not.toHaveProperty("defaultBotId");
  // Null inside notifications clears the quiet hours; the keys it leaves out keep their values.
  await s.patch({ notifications: { quietStart: null, quietEnd: null, batchMinutes: 10 } });
  expect(s.store.preferences("one").notifications).toEqual({ timezone: "UTC", batchMinutes: 10 });
  await s.patch({ hiddenRoutineRuns: null, mainSuggestionDismissed: null });
  expect(s.store.preferences("one")).not.toHaveProperty("hiddenRoutineRuns");
  expect(s.store.preferences("one")).not.toHaveProperty("mainSuggestionDismissed");
});

it("refuses null where clearing is not allowed and bad values, by field, saving nothing", async () => {
  const s = await setup();
  for (const [payload, path] of [
    [{ theme: null }, ["theme"]],
    [{ favorites: null }, ["favorites"]],
    [{ chatStyle: "compact" }, ["chatStyle"]],
    [{ notifications: { timezone: null } }, ["notifications", "timezone"]],
    [{ notifications: { batchMinutes: 61 } }, ["notifications", "batchMinutes"]],
  ] as const) {
    const refused = await s.patch(payload);
    expect(refused.statusCode).toBe(400);
    expect(paths(refused)).toEqual([path]);
  }
  expect(s.store.preferences("one")).toEqual(saved);
});

it("checks the merged notifications as a whole, so half a quiet-hours window is refused", async () => {
  const s = await setup();
  const refused = await s.patch({ notifications: { quietEnd: null } });
  expect(refused.statusCode).toBe(400);
  expect(refused.json().details).toEqual([
    { path: ["notifications"], message: "Choose different quiet start and end times." },
  ]);
  expect(s.store.preferences("one")).toEqual(saved);
  // Settings that never existed need every required key.
  s.store.savePreferences("one", { ...defaultPreferences });
  const incomplete = await s.patch({ notifications: { batchMinutes: 5 } });
  expect(paths(incomplete)).toEqual([["notifications", "timezone"]]);
});

it("refuses a merge patch that is not an object, with the reason", async () => {
  const s = await setup();
  const list = await s.patch(["theme"]);
  expect([list.statusCode, paths(list)]).toEqual([400, [[]]]);
  expect(s.store.preferences("one")).toEqual(saved);
});

// The parser takes input from any signed-in client; each refusal names its reason and saves nothing.
it("refuses an empty, malformed or prototype-poisoning merge patch body", async () => {
  const s = await setup();
  const raw = (payload: string) =>
    s.app.inject({
      method: "PATCH",
      url: "/api/preferences",
      headers: { ...s.headers, "content-type": MERGE_PATCH },
      payload,
    });
  const answers = [];
  for (const payload of [
    "",
    "{",
    '{"__proto__":{"theme":"light"}}',
    '{"constructor":{"prototype":{"theme":"light"}}}',
  ])
    answers.push(
      await raw(payload).then((response) => [response.statusCode, response.json().code]),
    );
  expect(answers).toEqual([
    [400, "FST_ERR_CTP_EMPTY_JSON_BODY"],
    [400, "FST_ERR_CTP_INVALID_JSON_BODY"],
    [400, "FST_ERR_CTP_INVALID_JSON_BODY"],
    [400, "FST_ERR_CTP_INVALID_JSON_BODY"],
  ]);
  expect(s.store.preferences("one")).toEqual(saved);
});

it("refuses a merge patch on any other route, and a media type no route reads", async () => {
  const s = await setup();
  const elsewhere = await s.send({ modelFavorites: [] }, MERGE_PATCH, "/api/preferences/models");
  expect([elsewhere.statusCode, elsewhere.json().error]).toEqual([
    415,
    `Only PATCH /api/preferences takes ${MERGE_PATCH}.`,
  ]);
  const form = await s.send({ theme: "light" }, "application/x-www-form-urlencoded");
  expect([form.statusCode, form.json().error]).toEqual([415, "Unsupported Media Type"]);
  expect(s.store.preferences("one")).toEqual(saved);
});

it("ignores the routed fields in a partial save, and a whole save keeps only the main assistant's", async () => {
  const s = await setup();
  const routed = {
    mainBotId: "creek",
    checkIns: { enabled: false, everyHours: 4, timezone: "UTC" },
    modelFavorites: [{ provider: "xyz", model: "test" }],
  };
  await s.patch({ ...routed, theme: "light" });
  expect(s.store.preferences("one")).toEqual({ ...saved, theme: "light" });
  // A whole save has always replaced model stars it sends, as the models route does.
  await s.whole({ ...defaultPreferences, ...routed });
  expect(s.store.preferences("one")).toMatchObject({
    mainBotId: saved.mainBotId,
    checkIns: saved.checkIns,
    modelFavorites: routed.modelFavorites,
  });
});

// Released iOS builds and tabs loaded before a deploy send whole objects as application/json.
it("stores a whole save exactly as before: an omitted default assistant clears, the rest it omits are kept", async () => {
  const s = await setup();
  const response = await s.whole({ ...defaultPreferences, theme: "light" });
  expect(response.statusCode).toBe(200);
  expect(s.store.preferences("one")).toEqual({
    ...defaultPreferences,
    theme: "light",
    modelFavorites: saved.modelFavorites,
    startPage: saved.startPage,
    chatStyle: saved.chatStyle,
    ownBubble: saved.ownBubble,
    notifications: saved.notifications,
    hiddenRoutineRuns: saved.hiddenRoutineRuns,
    mainBotId: saved.mainBotId,
    checkIns: saved.checkIns,
    mainSuggestionDismissed: saved.mainSuggestionDismissed,
  });
  // A whole save still needs every required field and still refuses null.
  const partial = await s.whole({ theme: "dark" });
  expect(partial.statusCode).toBe(400);
  expect(paths(partial)).toEqual([["presentation"], ["favorites"], ["sections"], ["followBots"]]);
  const cleared = await s.whole({ ...defaultPreferences, defaultBotId: null });
  expect(paths(cleared)).toEqual([["defaultBotId"]]);
});

// Released iOS builds read these details. The bodies were answered by the server at af8d1c38.
it("refuses a bad whole save with every field the server always named", async () => {
  const s = await setup();
  const sepia = await s.whole({ theme: "sepia" });
  expect([sepia.statusCode, sepia.json()]).toEqual([
    400,
    {
      error: "Invalid request",
      details: [
        { path: ["presentation"], message: 'Invalid option: expected one of "simple"|"advanced"' },
        { path: ["theme"], message: 'Invalid option: expected one of "system"|"light"|"dark"' },
        { path: ["favorites"], message: "Invalid input: expected array, received undefined" },
        { path: ["sections"], message: "Invalid input: expected array, received undefined" },
        { path: ["followBots"], message: "Invalid input: expected array, received undefined" },
      ],
    },
  ]);
  const nulls = await s.whole({ ...defaultPreferences, defaultBotId: null, chatStyle: "compact" });
  expect(nulls.json().details).toEqual([
    { path: ["defaultBotId"], message: "Invalid input: expected string, received null" },
    { path: ["chatStyle"], message: 'Invalid option: expected one of "bubbles"|"classic"' },
  ]);
  expect(s.store.preferences("one")).toEqual(saved);
});
