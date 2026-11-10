// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { LOCAL_SAVE_WAIT_MS, localRead, localRemove, localSave, localSaveSoon } from "../src/app/storage";

beforeEach(() => { vi.useFakeTimers(); });

it("writes rapid saves once, the newest, no later than the wait after the first", () => {
  const writes = vi.spyOn(Storage.prototype, "setItem");
  localSaveSoon("draft", { text: "S" });
  vi.advanceTimersByTime(LOCAL_SAVE_WAIT_MS - 50);
  // A later save does not push the write back, so steady typing is still stored every moment.
  localSaveSoon("draft", { text: "Saddle" });
  expect(writes.mock.calls).toEqual([]);
  vi.advanceTimersByTime(50);
  expect(writes.mock.calls).toEqual([["draft", JSON.stringify({ text: "Saddle" })]]);
});

it("lets a read see a save that is still waiting", () => {
  localSaveSoon("draft", { text: "Saddle up" });
  expect(localRead("draft")).toEqual({ text: "Saddle up" });
});

it("keeps a direct save over one that was waiting, as if the waiting one had been written first", () => {
  localSaveSoon("draft", { text: "typed" });
  localSave("draft", { text: "sent copy" });
  vi.advanceTimersByTime(LOCAL_SAVE_WAIT_MS);
  expect(localRead("draft")).toEqual({ text: "sent copy" });
});

it("drops a waiting save when its key is removed", () => {
  localSaveSoon("draft", { text: "typed" });
  localRemove("draft");
  vi.advanceTimersByTime(LOCAL_SAVE_WAIT_MS);
  expect(localStorage.getItem("draft")).toBeNull();
});
