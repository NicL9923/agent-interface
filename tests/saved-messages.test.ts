// @vitest-environment jsdom
import { createElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { useLatestMessageAt } from "../src/app/unread";
import { useSavedMessages } from "../src/app/use-saved-messages";
import type { Bot, Message } from "../src/shared/types";
import { mountRoot } from "./ui-harness";
import type { Mount } from "./ui-harness";

const message = (id: string, createdAt: string, text = id): Message => ({ id, role: "assistant", text, createdAt });
const a = message("a", "2026-11-10T10:00:00Z"), b = message("b", "2026-11-10T10:01:00Z");
const live = (text: string): Message => ({ id: "s-inflight", role: "assistant", text, createdAt: "2026-11-10T10:05:00Z" });
const bot = (at?: string) => ({ id: "bot", name: "Bot", activity: "idle", ...at ? { lastMessage: { at, text: "hi" } } : {} }) as unknown as Bot;

let mount: Mount;
beforeEach(() => { mount = mountRoot(); });

describe("useSavedMessages", () => {
  const seen: (Message[] | undefined)[] = [];
  const Probe = ({ messages }: { messages: Message[] | undefined }) => { seen.push(useSavedMessages(messages)); return null; };
  const show = async (messages: Message[] | undefined) => { await mount.render(createElement(Probe, { messages })); return seen.at(-1); };
  beforeEach(() => { seen.length = 0; });

  it("leaves out the live row and keeps its list while only that row changes", async () => {
    const first = await show([a, b, live("The north")]);
    expect(first).toEqual([a, b]);
    expect(await show([a, b, live("The north gate")])).toBe(first);
    // The row going away entirely, as when the reply is saved under its own ID, is a change of saved rows only if one arrived.
    expect(await show([a, b])).toBe(first);
  });

  // Each is a change a person sees, so what is derived from the saved rows must be worked out again.
  it.each<[string, Message[]]>([
    ["a saved message arrives", [a, b, message("c", "2026-11-10T10:02:00Z"), live("x")]],
    ["a saved message is edited", [a, { ...b, text: "edited" }, live("x")]],
    ["a saved message is removed", [a, live("x")]],
    ["earlier messages load", [message("z", "2026-11-10T09:00:00Z"), a, b, live("x")]],
    ["the live reply is saved under its own ID", [a, b, message("s", "2026-11-10T10:05:00Z")]],
  ])("returns a new list when %s", async (_, next) => {
    const first = await show([a, b, live("x")]);
    const changed = await show(next);
    expect(changed).not.toBe(first);
    expect(changed).toEqual(next.filter(item => !item.id.endsWith("-inflight")));
  });

  it("passes no messages through, and the list back from none", async () => {
    expect(await show(undefined)).toBeUndefined();
    expect(await show([a])).toEqual([a]);
    expect(await show(undefined)).toBeUndefined();
  });
});

describe("useLatestMessageAt", () => {
  // Each saved message's time is read through a getter, so the reads are the scans.
  const reads = { count: 0 };
  const watched = (id: string, createdAt: string): Message => {
    const row = { id, role: "assistant", text: id } as Message;
    Object.defineProperty(row, "createdAt", { enumerable: true, get() { reads.count++; return createdAt; } });
    return row;
  };
  const found: (string | undefined)[] = [];
  const Probe = (props: { bot?: Bot; messages?: Message[] }) => { found.push(useLatestMessageAt(props.bot, props.messages)); return null; };
  const show = async (props: { bot?: Bot; messages?: Message[] }) => { await mount.render(createElement(Probe, props)); return found.at(-1); };
  beforeEach(() => { reads.count = 0; found.length = 0; });

  it("reads each saved message once, however often the chat renders or its live reply changes", async () => {
    const rows = [watched("a", "2026-11-10T10:00:00Z"), watched("b", "2026-11-10T10:01:00Z")];
    const hello = bot();
    expect(await show({ bot: hello, messages: [...rows, live("The")] })).toBe("2026-11-10T10:01:00Z");
    const first = reads.count;
    expect(first).toBeGreaterThan(0);
    // A keystroke renders the chat with the same list; a delta brings a new list with the same saved rows.
    await show({ bot: hello, messages: [...rows, live("The")] });
    await show({ bot: hello, messages: [...rows, live("The north gate")] });
    expect(reads.count).toBe(first);
  });

  it("answers with the newest of the roster preview and the saved messages, and moves when one arrives", async () => {
    const rows = [watched("a", "2026-11-10T10:00:00Z")];
    expect(await show({ bot: bot("2026-11-10T10:30:00Z"), messages: rows })).toBe("2026-11-10T10:30:00Z");
    expect(await show({ bot: bot("2026-11-10T09:00:00Z"), messages: rows })).toBe("2026-11-10T10:00:00Z");
    const arrived = [...rows, watched("b", "2026-11-10T11:00:00Z")];
    expect(await show({ bot: bot("2026-11-10T09:00:00Z"), messages: arrived })).toBe("2026-11-10T11:00:00Z");
    // A live reply never counts as read.
    expect(await show({ bot: bot("2026-11-10T09:00:00Z"), messages: [...arrived, live("x")] })).toBe("2026-11-10T11:00:00Z");
  });

  it("has no time without a bot to be shown", async () => {
    expect(await show({ messages: [watched("a", "2026-11-10T10:00:00Z")] })).toBeUndefined();
  });
});
