import { expect, it, vi } from "vitest";
import { preferenceQueue } from "../src/app/preference-queue";
import type { Preferences } from "../src/shared/types";

const base = { favorites: [], followBots: [], sections: [] } as unknown as Preferences;
const deferred = () => { let resolve!: (value: Preferences) => void, reject!: (error: Error) => void; const promise = new Promise<Preferences>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

it("sends one save at a time, builds each edit on the last, and shows each saved answer", async () => {
  const replies = [deferred(), deferred()];
  const sent: Preferences[] = [], applied: Preferences[] = [];
  const queue = preferenceQueue({ send: value => { sent.push(value); return replies[sent.length - 1].promise; }, apply: value => applied.push(value), failed: vi.fn(), account: () => 1 });
  const first = queue.edit(value => ({ ...value, favorites: ["a"] }), base);
  const second = queue.edit(value => ({ ...value, favorites: [...value.favorites, "b"] }), base);
  await Promise.resolve();
  expect(sent.map(value => value.favorites)).toEqual([["a"]]);
  replies[0].resolve(sent[0]);
  await first;
  expect(sent.map(value => value.favorites)).toEqual([["a"], ["a", "b"]]);
  replies[1].resolve(sent[1]);
  await second;
  expect(applied.map(value => value.favorites)).toEqual([["a"], ["a", "b"]]);
});

it("keeps an earlier saved answer on screen when a later save fails, so the next edit keeps it", async () => {
  let screen = base;
  const sent: Preferences[] = [], failed = vi.fn();
  const send = async (value: Preferences) => { sent.push(value); if (value.favorites.includes("b")) throw new Error("Refused"); return value; };
  const queue = preferenceQueue({ send, apply: value => { screen = value; }, failed, account: () => 1 });
  void queue.edit(value => ({ ...value, favorites: ["a"] }), screen);
  await queue.edit(value => ({ ...value, favorites: [...value.favorites, "b"] }), screen);
  expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: "Refused" }));
  expect(screen.favorites).toEqual(["a"]);
  // An edit made right after the failure builds on the confirmed pin, with no reload to wait for.
  await queue.edit(value => ({ ...value, followBots: ["ranch"] }), screen);
  expect(sent.at(-1)).toMatchObject({ favorites: ["a"], followBots: ["ranch"] });
});

it("treats a read that overlapped any save as stale for preferences", async () => {
  const reply = deferred();
  const queue = preferenceQueue({ send: () => reply.promise, apply: vi.fn(), failed: vi.fn(), account: () => 1 });
  const idle = queue.mark();
  expect(queue.fresh(idle)).toBe(true);
  const saving = queue.save({ ...base, favorites: ["a"] });
  expect(queue.fresh(idle)).toBe(false);
  const during = queue.mark();
  reply.resolve({ ...base, favorites: ["a"] });
  await saving;
  expect(queue.fresh(during)).toBe(false);
  expect(queue.fresh(queue.mark())).toBe(true);
});

it("never carries one account's queued preferences into another account's edit", async () => {
  let account = 1;
  const reply = deferred(), sent: Preferences[] = [], applied: Preferences[] = [];
  const queue = preferenceQueue({ send: value => { sent.push(value); return sent.length === 1 ? reply.promise : Promise.resolve(value); }, apply: value => applied.push(value), failed: vi.fn(), account: () => account });
  void queue.edit(value => ({ ...value, favorites: ["first account pin"] }), base);
  account = 2;
  const theirs = { ...base, followBots: ["their follow"] };
  const edit = queue.edit(value => ({ ...value, favorites: ["second account pin"] }), theirs);
  // The first account's save never goes out; the second account's is the first one sent.
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  reply.resolve(sent[0]);
  await edit;
  expect(sent.at(-1)).toEqual({ ...theirs, favorites: ["second account pin"] });
  expect(applied).toEqual([{ ...theirs, favorites: ["second account pin"] }]);
});
