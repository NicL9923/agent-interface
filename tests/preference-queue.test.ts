import { expect, it, vi } from "vitest";
import { patchFor, preferenceQueue } from "../src/app/preference-queue";
import { moveSection } from "../src/app/preferences-editing";
import { applyMergePatch } from "../src/shared/merge-patch";
import type { Preferences, PreferencesPatch } from "../src/shared/types";

const base = { favorites: [], followBots: [], sections: [] } as unknown as Preferences;
/** A server that keeps what each save leaves out, as PATCH /preferences does with a merge patch. */
const server = (stored: Preferences) => ({
  stored,
  save(patch: PreferencesPatch) {
    this.stored = applyMergePatch(this.stored, patch) as Preferences;
    return this.stored;
  },
});
const deferred = () => {
  let resolve!: (value: Preferences) => void, reject!: (error: Error) => void;
  const promise = new Promise<Preferences>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};

it("sends one save at a time, builds each edit on the last, and shows each answer with what still waits", async () => {
  const replies = [deferred(), deferred()];
  const sent: PreferencesPatch[] = [],
    applied: Preferences[] = [];
  const queue = preferenceQueue({
    send: (value) => {
      sent.push(value);
      return replies[sent.length - 1].promise;
    },
    apply: (value) => applied.push(value),
    failed: vi.fn(),
    account: () => 1,
  });
  const first = queue.edit((value) => ({ ...value, favorites: ["a"] }), base);
  const second = queue.edit((value) => ({ ...value, favorites: [...value.favorites, "b"] }), base);
  await Promise.resolve();
  expect(sent.map((value) => value.favorites)).toEqual([["a"]]);
  replies[0].resolve({ ...base, favorites: ["a"] });
  await first;
  expect(sent.map((value) => value.favorites)).toEqual([["a"], ["a", "b"]]);
  replies[1].resolve({ ...base, favorites: ["a", "b"] });
  await second;
  // Each tap shows at once, and the first answer shows with the save still waiting laid over it, so the second
  // pin never leaves the screen.
  expect(applied.map((value) => value.favorites)).toEqual([
    ["a"],
    ["a", "b"],
    ["a", "b"],
    ["a", "b"],
  ]);
});

it("keeps an earlier saved answer on screen when a later save fails, so the next edit keeps it", async () => {
  let screen = base;
  const sent: PreferencesPatch[] = [],
    failed = vi.fn(),
    held = server(base);
  const send = async (patch: PreferencesPatch) => {
    sent.push(patch);
    if (patch.favorites?.includes("b")) throw new Error("Refused");
    return held.save(patch);
  };
  const queue = preferenceQueue({
    send,
    apply: (value) => {
      screen = value;
    },
    failed,
    account: () => 1,
  });
  void queue.edit((value) => ({ ...value, favorites: ["a"] }), screen);
  await queue.edit((value) => ({ ...value, favorites: [...value.favorites, "b"] }), screen);
  expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: "Refused" }));
  expect(screen.favorites).toEqual(["a"]);
  // An edit made right after the failure builds on the confirmed pin, with no reload to wait for.
  await queue.edit((value) => ({ ...value, favorites: [...value.favorites, "c"] }), screen);
  expect(sent.at(-1)).toEqual({ favorites: ["a", "c"] });
  expect(held.stored.favorites).toEqual(["a", "c"]);
});

it("treats a read that overlapped any save as stale for preferences", async () => {
  const reply = deferred();
  const queue = preferenceQueue({
    send: () => reply.promise,
    apply: vi.fn(),
    failed: vi.fn(),
    account: () => 1,
  });
  const idle = queue.mark();
  expect(queue.fresh(idle)).toBe(true);
  const saving = queue.edit((value) => ({ ...value, favorites: ["a"] }), base);
  expect(queue.fresh(idle)).toBe(false);
  const during = queue.mark();
  reply.resolve({ ...base, favorites: ["a"] });
  await saving;
  expect(queue.fresh(during)).toBe(false);
  expect(queue.fresh(queue.mark())).toBe(true);
});

it("never carries one account's queued preferences into another account's edit", async () => {
  let account = 1;
  const reply = deferred(),
    sent: PreferencesPatch[] = [],
    applied: Preferences[] = [];
  const theirs = server({ ...base, followBots: ["their follow"] });
  const queue = preferenceQueue({
    send: (patch) => {
      sent.push(patch);
      return reply.promise;
    },
    apply: (value) => applied.push(value),
    failed: vi.fn(),
    account: () => account,
  });
  void queue.edit((value) => ({ ...value, favorites: ["first account pin"] }), base);
  account = 2;
  const edit = queue.edit(
    (value) => ({ ...value, favorites: [...value.favorites, "second account pin"] }),
    theirs.stored,
  );
  // The first account's save never goes out; the second account's is the first one sent.
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  reply.resolve(theirs.save(sent[0]));
  await edit;
  expect(sent).toEqual([{ favorites: ["second account pin"] }]);
  // The first account's pin showed while it was signed in. Nothing shown since holds it.
  const theirsPinned = { ...base, followBots: ["their follow"], favorites: ["second account pin"] };
  expect(applied).toEqual([
    { ...base, favorites: ["first account pin"] },
    theirsPinned,
    theirsPinned,
  ]);
});

// The server keeps a chat style choice a save leaves out. A tab can hold an older copy of one than the server does,
// set since on another device, so a save carries a choice only when this edit changed it.
it("sends a chat style choice only with the edit that changed it", async () => {
  const sent: PreferencesPatch[] = [];
  const queue = preferenceQueue({
    send: async (value) => {
      sent.push(value);
      return value as Preferences;
    },
    apply: vi.fn(),
    failed: vi.fn(),
    account: () => 1,
  });
  // This tab still holds Tinted and Bubbles; another device may have saved something else since.
  const held = { ...base, theme: "light", chatStyle: "bubbles", ownBubble: "tint" } as Preferences;
  await queue.edit((value) => ({ ...value, theme: "dark" }), held);
  expect(sent[0]).toMatchObject({ theme: "dark" });
  expect(sent[0]).not.toHaveProperty("chatStyle");
  expect(sent[0]).not.toHaveProperty("ownBubble");
  await queue.edit((value) => ({ ...value, chatStyle: "classic" }), { ...held, theme: "dark" });
  expect(sent[1]).toMatchObject({ chatStyle: "classic" });
  expect(sent[1]).not.toHaveProperty("ownBubble");
});

it("sends a chat style choice changed back while the first change is still saving", async () => {
  const replies = [deferred(), deferred()];
  const sent: PreferencesPatch[] = [];
  const queue = preferenceQueue({
    send: (value) => {
      sent.push(value);
      return replies[sent.length - 1].promise;
    },
    apply: vi.fn(),
    failed: vi.fn(),
    account: () => 1,
  });
  const held = { ...base, chatStyle: "bubbles", ownBubble: "tint" } as Preferences;
  const first = queue.edit((value) => ({ ...value, chatStyle: "classic" }), held);
  // The screen still holds Bubbles, so the second edit equals what was last confirmed. It must be sent all the same.
  const second = queue.edit((value) => ({ ...value, chatStyle: "bubbles" }), held);
  await Promise.resolve();
  expect(sent[0]).toMatchObject({ chatStyle: "classic" });
  replies[0].resolve({ ...held, chatStyle: "classic" });
  await first;
  expect(sent[1]).toMatchObject({ chatStyle: "bubbles" });
  expect(sent[1]).not.toHaveProperty("ownBubble");
  replies[1].resolve(held);
  await second;
});

it("keeps a choice a later edit builds on, though that edit does not send it", async () => {
  const sent: PreferencesPatch[] = [],
    applied: Preferences[] = [];
  const queue = preferenceQueue({
    // The server answers with what it holds: the choices it was sent, over the ones it had.
    send: async (value) => {
      sent.push(value);
      return { ...applied.at(-1), ...value } as Preferences;
    },
    apply: (value) => applied.push(value),
    failed: vi.fn(),
    account: () => 1,
  });
  const held = { ...base, theme: "light", chatStyle: "bubbles", ownBubble: "tint" } as Preferences;
  void queue.edit((value) => ({ ...value, ownBubble: "solid" }), held);
  await queue.edit((value) => ({ ...value, theme: "dark" }), held);
  expect(sent[1]).not.toHaveProperty("ownBubble");
  expect(applied.at(-1)).toMatchObject({ theme: "dark", ownBubble: "solid" });
});

// A change measured against the queue's newest value misses one case. An answer can bring another tab's Classic on
// screen while a save built on Bubbles still waits. The person then picks Bubbles, which equals what the waiting
// save holds, so only the pick itself says the choice changed.
it("sends a choice the person picks though a save still waiting holds that value", async () => {
  const replies = [deferred(), deferred(), deferred()];
  const sent: PreferencesPatch[] = [];
  const held = { ...base, theme: "light", chatStyle: "bubbles" } as Preferences;
  let screen = held;
  const queue = preferenceQueue({
    send: (value) => {
      sent.push(value);
      return replies[sent.length - 1].promise;
    },
    apply: (value) => {
      screen = value;
    },
    failed: vi.fn(),
    account: () => 1,
  });
  const first = queue.edit((value) => ({ ...value, theme: "dark" }), screen);
  const second = queue.edit((value) => ({ ...value, startPage: "today" }), screen);
  replies[0].resolve({ ...held, theme: "dark", chatStyle: "classic" });
  await first;
  expect(screen.chatStyle).toBe("classic");
  const third = queue.edit((value) => ({ ...value, chatStyle: "bubbles" }), screen, ["chatStyle"]);
  replies[1].resolve({ ...screen, startPage: "today" });
  await second;
  expect(sent[2]).toMatchObject({ chatStyle: "bubbles" });
  replies[2].resolve({ ...screen, chatStyle: "bubbles" });
  await third;
  expect(screen.chatStyle).toBe("bubbles");
});

// Each tab holds a copy older than the other's save. A whole object from either would undo the other's change.
it("lands two saves of different fields made from the same stale copy", async () => {
  const held = { ...base, theme: "light", favorites: ["ranch"] } as Preferences;
  const shared = server(held);
  const sent: PreferencesPatch[] = [];
  const tab = () =>
    preferenceQueue({
      send: async (patch) => {
        sent.push(patch);
        return shared.save(patch);
      },
      apply: vi.fn(),
      failed: vi.fn(),
      account: () => 1,
    });
  await tab().edit((value) => ({ ...value, theme: "dark" }), held, ["theme"]);
  await tab().edit((value) => ({ ...value, favorites: [...value.favorites, "creek"] }), held, [
    "favorites",
  ]);
  expect(sent).toEqual([{ theme: "dark" }, { favorites: ["ranch", "creek"] }]);
  expect(shared.stored).toMatchObject({ theme: "dark", favorites: ["ranch", "creek"] });
});

it("clears a field the edit removed, and the quiet hours a notifications edit dropped", async () => {
  const held = {
    ...base,
    defaultBotId: "ranch",
    notifications: { timezone: "UTC", quietStart: "22:00", quietEnd: "07:00", batchMinutes: 5 },
  } as Preferences;
  const shared = server(held);
  const sent: PreferencesPatch[] = [];
  const queue = preferenceQueue({
    send: async (patch) => {
      sent.push(patch);
      return shared.save(patch);
    },
    apply: vi.fn(),
    failed: vi.fn(),
    account: () => 1,
  });
  await queue.edit(({ defaultBotId: _, ...value }) => value, held, ["defaultBotId"]);
  await queue.edit(
    (value) => ({ ...value, notifications: { timezone: "UTC", batchMinutes: 5 } }),
    shared.stored,
    ["notifications"],
  );
  expect(sent).toEqual([
    { defaultBotId: null },
    { notifications: { timezone: "UTC", batchMinutes: 5, quietStart: null, quietEnd: null } },
  ]);
  expect(shared.stored).not.toHaveProperty("defaultBotId");
  expect(shared.stored.notifications).toEqual({ timezone: "UTC", batchMinutes: 5 });
});

it("sends a key an object field set to undefined as null", () => {
  const held = {
    ...base,
    notifications: { timezone: "UTC", quietStart: "22:00", quietEnd: "07:00", batchMinutes: 0 },
  } as Preferences;
  const next = {
    ...held,
    notifications: { ...held.notifications!, quietStart: undefined, quietEnd: undefined },
  };
  expect(patchFor(next, ["notifications"])).toEqual({
    notifications: { timezone: "UTC", batchMinutes: 0, quietStart: null, quietEnd: null },
  });
});

it("names every clearable key of an object field, whatever an older copy held", () => {
  const next = { ...base, notifications: { timezone: "UTC", batchMinutes: 0 } } as Preferences;
  expect(patchFor(next, ["notifications"])).toEqual({
    notifications: { timezone: "UTC", batchMinutes: 0, quietStart: null, quietEnd: null },
  });
});

/**
 * A server whose answers wait for the test. `answer` lets the oldest save land and answer, `"refuse"`
 * refuses it, and `"lost"` lands it but loses the answer on the way back.
 */
const slowServer = (stored: Preferences) => {
  const held = server(stored);
  const sent: PreferencesPatch[] = [];
  const waiting: {
    patch: PreferencesPatch;
    resolve(value: Preferences): void;
    reject(error: Error): void;
  }[] = [];
  let screen = stored;
  const failed = vi.fn();
  const queue = preferenceQueue({
    send: (patch) => {
      sent.push(patch);
      return new Promise((resolve, reject) => waiting.push({ patch, resolve, reject }));
    },
    apply: (value) => {
      screen = value;
    },
    failed,
    account: () => 1,
  });
  return {
    held,
    sent,
    queue,
    failed,
    screen: () => screen,
    answer: async (outcome: "ok" | "refuse" | "lost" = "ok") => {
      await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0));
      const save = waiting.shift()!;
      if (outcome === "refuse") save.reject(new Error("Refused"));
      else if (outcome === "lost") {
        held.save(save.patch);
        save.reject(new Error("The connection was lost"));
      } else save.resolve(held.save(save.patch));
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
};

// The tab's copy never had quiet hours. An answer brings another device's 22:00 to 07:00 on screen while a
// save built on that copy still waits, and the person turns quiet hours off.
it("turns off quiet hours the screen shows though the tab's first copy never had them", async () => {
  const tab = {
    ...base,
    theme: "light",
    notifications: { timezone: "UTC", batchMinutes: 0 },
  } as Preferences;
  const s = slowServer(tab);
  s.held.stored = {
    ...tab,
    notifications: { timezone: "UTC", quietStart: "22:00", quietEnd: "07:00", batchMinutes: 0 },
  };
  void s.queue.edit((value) => ({ ...value, theme: "dark" }), tab, ["theme"]);
  void s.queue.edit((value) => ({ ...value, startPage: "today" }), tab, ["startPage"]);
  await s.answer();
  expect(s.screen().notifications?.quietStart).toBe("22:00");
  const off = s.queue.edit(
    (value) => ({ ...value, notifications: { timezone: "UTC", batchMinutes: 0 } }),
    s.screen(),
    ["notifications"],
  );
  await s.answer();
  await s.answer();
  await off;
  expect(s.sent[2]).toEqual({
    notifications: { timezone: "UTC", batchMinutes: 0, quietStart: null, quietEnd: null },
  });
  expect(s.held.stored.notifications).toEqual({ timezone: "UTC", batchMinutes: 0 });
});

// An answer brings another device's pin on screen while a save built on the tab's older list still waits.
// The person pins from that screen, so the new list must keep what they saw.
it("builds an edit on the pins an answer put on screen, not on a waiting save's older copy", async () => {
  const tab = { ...base, favorites: [] } as Preferences;
  const s = slowServer(tab);
  s.held.stored = { ...tab, favorites: ["creek"] };
  void s.queue.edit((value) => ({ ...value, theme: "dark" }), tab, ["theme"]);
  void s.queue.edit((value) => ({ ...value, presentation: "advanced" }), tab, ["presentation"]);
  await s.answer();
  expect(s.screen().favorites).toEqual(["creek"]);
  const pin = s.queue.edit(
    (value) => ({ ...value, favorites: [...value.favorites, "ranch"] }),
    s.screen(),
    ["favorites"],
  );
  await s.answer();
  await s.answer();
  await pin;
  expect(s.sent[2]).toEqual({ favorites: ["creek", "ranch"] });
  expect(s.held.stored.favorites).toEqual(["creek", "ranch"]);
});

// Saves go out as they were built when the person tapped. One refused for a passing reason does not change the
// patch behind it, which already holds that change because the screen showed it.
it("sends the save behind a refused one as it was built, so it lands both changes", async () => {
  const s = slowServer(base);
  void s.queue.edit((value) => ({ ...value, favorites: [...value.favorites, "creek"] }), base, [
    "favorites",
  ]);
  const next = s.queue.edit(
    (value) => ({ ...value, favorites: [...value.favorites, "ranch"] }),
    base,
    ["favorites"],
  );
  await s.answer("refuse");
  // The refused pin leaves the screen's overlay; the waiting save still shows what it will send.
  expect(s.screen().favorites).toEqual(["creek", "ranch"]);
  await s.answer();
  await next;
  expect(s.sent).toEqual([{ favorites: ["creek"] }, { favorites: ["creek", "ranch"] }]);
  expect(s.held.stored.favorites).toEqual(["creek", "ranch"]);
  expect(s.failed).toHaveBeenCalledOnce();
});

// Another client pins Ranch Hand while this tab's theme save waits. The pin was tapped on a screen without it.
it("sends a pin as the list the person saw, so another client's same pin is not doubled", async () => {
  const s = slowServer(base);
  void s.queue.edit((value) => ({ ...value, theme: "dark" }), base, ["theme"]);
  const pin = s.queue.edit(
    (value) => ({ ...value, favorites: [...value.favorites, "ranch"] }),
    base,
    ["favorites"],
  );
  s.held.stored = { ...s.held.stored, favorites: ["ranch"] };
  await s.answer();
  await s.answer();
  await pin;
  expect(s.sent[1]).toEqual({ favorites: ["ranch"] });
  expect(s.held.stored.favorites).toEqual(["ranch"]);
});

// The person moves B up from [A, B, C] while a theme save waits; another client saves [A, C, B] meanwhile.
it("sends a reorder as the order the person saw", async () => {
  const section = (id: string) => ({ id, name: id, botIds: [] });
  const tab = { ...base, sections: ["A", "B", "C"].map(section) } as Preferences;
  const s = slowServer(tab);
  void s.queue.edit((value) => ({ ...value, theme: "dark" }), tab, ["theme"]);
  const move = s.queue.edit((value) => moveSection(value, "B", -1), tab, ["sections"]);
  s.held.stored = { ...s.held.stored, sections: ["A", "C", "B"].map(section) };
  await s.answer();
  await s.answer();
  await move;
  const order = (value: Preferences) => value.sections.map((item) => item.id);
  expect(order(s.held.stored)).toEqual(["B", "A", "C"]);
  expect(order(s.screen())).toEqual(["B", "A", "C"]);
});

// Settings can still show the person's own earlier copy while an answer has brought another device's Classic to
// the session. Picking Classic there changes nothing the queue can see, so only the control's name sends it.
it("sends a named pick that equals another device's value on screen", async () => {
  const held = { ...base, chatStyle: "bubbles" } as Preferences;
  const s = slowServer(held);
  void s.queue.edit((value) => ({ ...value, theme: "dark" }), held, ["theme"]);
  s.held.stored = { ...s.held.stored, chatStyle: "classic" };
  await s.answer();
  expect(s.screen().chatStyle).toBe("classic");
  const pick = s.queue.edit((value) => ({ ...value, chatStyle: "classic" }), s.screen(), [
    "chatStyle",
  ]);
  await s.answer();
  await pick;
  expect(s.sent[1]).toEqual({ chatStyle: "classic" });
});

it("sends a retry after a refusal on the confirmed copy", async () => {
  const s = slowServer(base);
  const pin = (value: Preferences) => ({ ...value, favorites: [...value.favorites, "ranch"] });
  const first = s.queue.edit(pin, base, ["favorites"]);
  await s.answer("refuse");
  await first;
  expect(s.screen().favorites).toEqual([]);
  const retry = s.queue.edit(pin, s.screen(), ["favorites"]);
  await s.answer();
  await retry;
  expect(s.sent).toEqual([{ favorites: ["ranch"] }, { favorites: ["ranch"] }]);
  expect(s.held.stored.favorites).toEqual(["ranch"]);
});

it("queues nothing for an edit that returns the value it was given", async () => {
  const s = slowServer(base);
  const result = s.queue.edit((value) => value, base, ["favorites"]);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(s.sent).toEqual([]);
  await expect(result).resolves.toBe("unchanged");
});

// A new main assistant comes back from its own route while a pin still waits. Both stay on screen. This stops
// checking the screen before the pin's save settles, so it does not cover an older preferences answer putting
// back what the other route cleared; see `confirm`.
it("keeps the saves still waiting on screen over an answer from another route, until the next save answers", async () => {
  const s = slowServer(base);
  const pin = s.queue.edit((value) => ({ ...value, favorites: ["ranch"] }), base, ["favorites"]);
  s.queue.confirm({ ...base, mainBotId: "sage" });
  expect(s.screen()).toMatchObject({ mainBotId: "sage", favorites: ["ranch"] });
  await s.answer();
  await expect(pin).resolves.toBe("saved");
});
