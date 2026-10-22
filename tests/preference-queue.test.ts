import { expect, it, vi } from "vitest";
import { preferenceQueue } from "../src/app/preference-queue";
import type { Preferences } from "../src/shared/types";

const base = { favorites: [], followBots: [], sections: [] } as unknown as Preferences;
const deferred = () => { let resolve!: (value: Preferences) => void, reject!: (error: Error) => void; const promise = new Promise<Preferences>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

it("sends one save at a time, builds each edit on the last, and shows only the newest", async () => {
  const replies = [deferred(), deferred()];
  const sent: Preferences[] = [], applied: Preferences[] = [];
  const queue = preferenceQueue({ send: value => { sent.push(value); return replies[sent.length - 1].promise; }, apply: value => applied.push(value), failed: vi.fn(), reload: vi.fn(), account: () => 1 });
  const first = queue.edit(value => ({ ...value, favorites: ["a"] }), base);
  const second = queue.edit(value => ({ ...value, favorites: [...value.favorites, "b"] }), base);
  await Promise.resolve();
  expect(sent.map(value => value.favorites)).toEqual([["a"]]);
  replies[0].resolve(sent[0]);
  await first;
  expect(applied).toEqual([]);
  expect(sent.map(value => value.favorites)).toEqual([["a"], ["a", "b"]]);
  replies[1].resolve(sent[1]);
  await second;
  expect(applied.map(value => value.favorites)).toEqual([["a", "b"]]);
});

it("reports a failure, keeps later saves going, and drops saves queued for another account", async () => {
  let account = 1;
  const failed = vi.fn(), applied: Preferences[] = [];
  const send = vi.fn(async (value: Preferences) => { if (value.favorites.includes("bad")) throw new Error("Refused"); return value; });
  const queue = preferenceQueue({ send, apply: value => applied.push(value), failed, reload: vi.fn(), account: () => account });
  await queue.save({ ...base, favorites: ["bad"] });
  expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: "Refused" }));
  const stale = queue.save({ ...base, favorites: ["old account"] });
  account = 2;
  const fresh = queue.save({ ...base, favorites: ["new account"] });
  await Promise.all([stale, fresh]);
  expect(send.mock.calls.map(([value]) => value.favorites)).toEqual([["bad"], ["new account"]]);
  expect(applied.map(value => value.favorites)).toEqual([["new account"]]);
});

it("never carries one account's queued preferences into another account's edit", async () => {
  let account = 1;
  const reply = deferred(), sent: Preferences[] = [];
  const queue = preferenceQueue({ send: value => { sent.push(value); return sent.length === 1 ? reply.promise : Promise.resolve(value); }, apply: vi.fn(), failed: vi.fn(), reload: vi.fn(), account: () => account });
  void queue.edit(value => ({ ...value, favorites: ["first account pin"] }), base);
  account = 2;
  const theirs = { ...base, followBots: ["their follow"] };
  const edit = queue.edit(value => ({ ...value, favorites: ["second account pin"] }), theirs);
  reply.resolve(sent[0]);
  await edit;
  expect(sent.at(-1)).toEqual({ ...theirs, favorites: ["second account pin"] });
});

it("reloads the server's copy when the newest save fails, since an earlier one may have landed", async () => {
  const applied: Preferences[] = [], sent: Preferences[] = [], reload = vi.fn();
  const send = async (value: Preferences) => { sent.push(value); if (value.favorites.includes("b")) throw new Error("Refused"); return value; };
  const queue = preferenceQueue({ send, apply: value => applied.push(value), failed: vi.fn(), reload, account: () => 1 });
  void queue.edit(value => ({ ...value, favorites: ["a"] }), base);
  await queue.edit(value => ({ ...value, favorites: [...value.favorites, "b"] }), base);
  expect(applied).toEqual([]);
  expect(reload).toHaveBeenCalledTimes(1);
  // With nothing queued, the next edit builds on the screen's (reloaded) value.
  await queue.edit(value => ({ ...value, favorites: [...value.favorites, "c"] }), { ...base, favorites: ["a", "from phone"] });
  expect(sent.at(-1)?.favorites).toEqual(["a", "from phone", "c"]);
});
