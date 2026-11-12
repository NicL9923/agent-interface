import { describe, expect, it } from "vitest";
import { limiter, mapLimit } from "../src/server/concurrency.js";

describe("mapLimit", () => {
  it("starts the next item as soon as any running one finishes and keeps the items' order", async () => {
    const started: number[] = [];
    const finish = new Map<number, () => void>();
    const mapped = mapLimit([0, 1, 2, 3, 4], 2, item => new Promise<string>(resolve => {
      started.push(item);
      finish.set(item, () => resolve(`item ${item}`));
    }));
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    // A slow first item does not hold up the rest, as a fixed batch would.
    finish.get(1)!();
    await new Promise(resolve => setImmediate(resolve));
    expect(started).toEqual([0, 1, 2]);
    finish.get(2)!(); await new Promise(resolve => setImmediate(resolve));
    finish.get(3)!(); await new Promise(resolve => setImmediate(resolve));
    expect(started).toEqual([0, 1, 2, 3, 4]);
    finish.get(4)!(); finish.get(0)!();
    expect(await mapped).toEqual(["item 0", "item 1", "item 2", "item 3", "item 4"]);
  });

  it("returns an empty list without calling anything", async () => {
    expect(await mapLimit([], 4, async () => { throw new Error("never called"); })).toEqual([]);
  });
});

describe("limiter", () => {
  it("runs at most its limit at once and starts the next in order when one settles, even by failing", async () => {
    const gate = limiter(2), started: number[] = [];
    const finish = new Map<number, [() => void, () => void]>();
    const calls = [0, 1, 2, 3].map(item => gate(() => new Promise<number>((resolve, reject) => {
      started.push(item);
      finish.set(item, [() => resolve(item), () => reject(new Error(`item ${item}`))]);
    })));
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    finish.get(1)![1]();
    await expect(calls[1]).rejects.toThrow("item 1");
    await new Promise(resolve => setImmediate(resolve));
    expect(started).toEqual([0, 1, 2]);
    finish.get(0)![0]();
    await new Promise(resolve => setImmediate(resolve));
    expect(started).toEqual([0, 1, 2, 3]);
    finish.get(2)![0](); finish.get(3)![0]();
    expect(await Promise.all([calls[0], calls[2], calls[3]])).toEqual([0, 2, 3]);
  });
  it("frees the slot of a call that throws before it returns a promise", async () => {
    const gate = limiter(1);
    await expect(gate(() => { throw new Error("thrown at once"); })).rejects.toThrow("thrown at once");
    await expect(gate(async () => "next")).resolves.toBe("next");
  });
});
