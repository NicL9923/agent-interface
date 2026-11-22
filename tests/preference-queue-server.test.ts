import { afterEach, expect, it, vi } from "vitest";
import { preferenceQueue } from "../src/app/preference-queue";
import { addSection, setSectionBots } from "../src/app/preferences-editing";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { MERGE_PATCH } from "../src/shared/merge-patch.js";
import {
  defaultPreferences,
  type Preferences,
  type PreferencesPatch,
} from "../src/shared/types.js";
import { fakeRuntime, signIn } from "./helpers/server.js";

// The real queue against the real server: what these cases get wrong is what the server stores.
const origin = "https://app.example.invalid";
const apps: Awaited<ReturnType<typeof createApp>>["app"][] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
const start: Preferences = {
  ...defaultPreferences,
  sections: [{ id: "a", name: "Around the house", botIds: ["ranch"] }],
};
/**
 * A tab whose saves each wait for the test. `answer` lets the oldest one reach the server; `"unsent"` fails
 * it before it gets there, and `"lost"` lets it land but loses the answer.
 */
async function tab() {
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
  store.savePreferences("one", structuredClone(start));
  const put = async (patch: PreferencesPatch) => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/preferences",
      headers: { ...headers, "content-type": MERGE_PATCH },
      payload: JSON.stringify(patch),
    });
    if (response.statusCode !== 200) throw new Error(response.json().error);
    return response.json() as Preferences;
  };
  const waiting: {
    patch: PreferencesPatch;
    resolve(value: Preferences): void;
    reject(error: Error): void;
  }[] = [];
  let screen = start;
  const failed = vi.fn();
  const queue = preferenceQueue({
    send: (patch) => new Promise((resolve, reject) => waiting.push({ patch, resolve, reject })),
    apply: (value) => {
      screen = value;
    },
    failed,
    account: () => 1,
  });
  return {
    queue,
    failed,
    screen: () => screen,
    stored: () => store.preferences("one"),
    answer: async (outcome: "ok" | "unsent" | "lost" = "ok") => {
      await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0));
      const save = waiting.shift()!;
      if (outcome === "unsent") save.reject(new Error("Can't reach the app server."));
      else
        await put(save.patch).then(
          (saved) =>
            outcome === "lost"
              ? save.reject(new Error("The connection was lost"))
              : save.resolve(saved),
          (error: Error) => save.reject(error),
        );
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
}
const members = (value: Preferences) =>
  Object.fromEntries(value.sections.map((section) => [section.name, section.botIds]));
/** Settings checks an assistant in a section's page, as its checkbox does. */
const check = (sectionId: string, botId: string) => (value: Preferences) =>
  setSectionBots(value, sectionId, [
    ...(value.sections.find((item) => item.id === sectionId)?.botIds ?? []),
    botId,
  ]);

// Ranch Hand sits in "Around the house". The person creates a section the server refuses, opens it while its save
// waits, and checks Ranch Hand. That edit was made on a screen that had the new section.
it("never takes an assistant out of its section when the section it moved to was refused", async () => {
  const t = await tab();
  const refused = "x".repeat(101);
  void t.queue.edit((value) => addSection(value, refused, "b"), start, ["sections"]);
  const move = t.queue.edit(check("b", "ranch"), start, ["sections"]);
  await t.answer();
  await t.answer();
  await move;
  expect(members(t.stored())).toEqual({ "Around the house": ["ranch"] });
  expect(t.failed).toHaveBeenCalledTimes(2);
  expect(members(t.screen())).toEqual({ "Around the house": ["ranch"] });
});

it("creates the section with the assistant in it when only the first save failed to send", async () => {
  const t = await tab();
  void t.queue.edit((value) => addSection(value, "Barn", "b"), start, ["sections"]);
  const move = t.queue.edit(check("b", "ranch"), start, ["sections"]);
  await t.answer("unsent");
  await t.answer();
  await move;
  expect(members(t.stored())).toEqual({ "Around the house": [], Barn: ["ranch"] });
});

// The server commits B and the answer is lost. C was added on a screen that showed B.
it("keeps a change the server committed though its answer was lost", async () => {
  const t = await tab();
  void t.queue.edit((value) => addSection(value, "Barn", "b"), start, ["sections"]);
  const next = t.queue.edit((value) => addSection(value, "Creek", "c"), start, ["sections"]);
  await t.answer("lost");
  await t.answer();
  await next;
  expect(t.stored().sections.map((section) => section.name)).toEqual([
    "Around the house",
    "Barn",
    "Creek",
  ]);
});
