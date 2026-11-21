import { expect, it, vi } from "vitest";
import { patchFor, preferenceQueue } from "../src/app/preference-queue";
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

it("sends one save at a time, builds each edit on the last, and shows each saved answer", async () => {
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
  expect(applied.map((value) => value.favorites)).toEqual([["a"], ["a", "b"]]);
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
  expect(applied).toEqual([
    { ...base, followBots: ["their follow"], favorites: ["second account pin"] },
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

/** A server whose answers wait for the test, each one the patch merged over what it holds. */
const slowServer = (stored: Preferences) => {
  const held = server(stored);
  const sent: PreferencesPatch[] = [];
  const answers: (() => void)[] = [];
  let screen = stored;
  const queue = preferenceQueue({
    send: (patch) => {
      sent.push(patch);
      return new Promise((resolve, reject) =>
        answers.push(() =>
          patch.favorites?.includes("refused")
            ? reject(new Error("Refused"))
            : resolve(held.save(patch)),
        ),
      );
    },
    apply: (value) => {
      screen = value;
    },
    failed: vi.fn(),
    account: () => 1,
  });
  return {
    held,
    sent,
    queue,
    screen: () => screen,
    /** Lets the oldest save answer once it has been sent. */
    answer: async () => {
      await vi.waitFor(() => expect(answers.length).toBeGreaterThan(0));
      answers.shift()!();
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

it("does not carry a refused save's change into the edit queued behind it", async () => {
  const s = slowServer(base);
  void s.queue.edit((value) => ({ ...value, favorites: [...value.favorites, "refused"] }), base, [
    "favorites",
  ]);
  const next = s.queue.edit(
    (value) => ({ ...value, favorites: [...value.favorites, "ranch"] }),
    base,
    ["favorites"],
  );
  await s.answer();
  await s.answer();
  await next;
  expect(s.sent).toEqual([{ favorites: ["refused"] }, { favorites: ["ranch"] }]);
  expect(s.held.stored.favorites).toEqual(["ranch"]);
});
