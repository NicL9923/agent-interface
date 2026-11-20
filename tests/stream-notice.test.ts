// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  reportStream,
  resetStreamHealth,
  streamUp,
  useStreamsDown,
  useStreamsLive,
  type StreamsLive,
} from "../src/app/stream-health";
import { mountRoot } from "./ui-harness";

// The connection notice shows once a stream has been down for 20 seconds without a break.
let shown: boolean[];
function Probe({ names }: { names: string[] }) {
  shown.push(useStreamsDown(names, 20_000));
  return null;
}
beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2026-11-10T12:00:00Z") });
  resetStreamHealth();
  shown = [];
});
afterEach(() => {
  vi.useRealTimers();
});
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const report = (name: string, up: boolean | undefined) => act(async () => reportStream(name, up));

// Live updates are back only when the streams say so. One that is closed says nothing.
describe("streams live", () => {
  let up: StreamsLive[];
  let scopes: string[];
  function UpProbe({ names }: { names: string[] }) {
    const { live, scope } = useStreamsLive(names);
    up.push(live);
    scopes.push(scope);
    return null;
  }
  beforeEach(() => {
    up = [];
    scopes = [];
  });

  it("is up only while every named stream has heard from the server, and closed while one is not open", async () => {
    const { render } = mountRoot();
    await render(createElement(UpProbe, { names: ["household", "chat:shared"] }));
    expect(up.at(-1)).toBe("closed");
    await report("household", true);
    expect(up.at(-1)).toBe("closed");
    await report("chat:shared", true);
    expect(up.at(-1)).toBe("up");
    await report("chat:shared", false);
    expect(up.at(-1)).toBe("waiting");
    await report("chat:shared", true);
    // Closed, as when the page hides: not down, and not up either.
    await report("household", undefined);
    expect(up.at(-1)).toBe("closed");
  });

  // A chat's stream is closed and reopened for a new session within one batch, so no render sees it
  // closed. The replacement is still another stream, and the scope says so.
  it("names the streams anew when one closes, even if it reopens before a render", async () => {
    const { render } = mountRoot();
    await render(createElement(UpProbe, { names: ["household", "chat:shared"] }));
    await report("household", true);
    await report("chat:shared", false);
    const before = scopes.at(-1);
    up = [];
    await act(async () => {
      reportStream("chat:shared", undefined);
      reportStream("chat:shared", false);
    });
    expect(up).not.toContain("closed");
    expect(scopes.at(-1)).not.toBe(before);
    // Failing and retrying is the same stream, and the same scope.
    const reopened = scopes.at(-1);
    await report("chat:shared", true);
    await report("chat:shared", false);
    expect(scopes.at(-1)).toBe(reopened);
  });
});

describe("streams down", () => {
  it("turns true 20 seconds into an outage, not a moment sooner, and false as soon as the stream hears anything", async () => {
    const { render } = mountRoot();
    await render(createElement(Probe, { names: ["household", "chat:shared"] }));
    await report("household", false);
    await advance(19_999);
    expect(shown.at(-1)).toBe(false);
    await advance(1);
    expect(shown.at(-1)).toBe(true);
    await report("household", true);
    expect(shown.at(-1)).toBe(false);
  });

  it("never shows for a brief reconnect, and counts an outage from its start however often it is reported", async () => {
    const { render } = mountRoot();
    await render(createElement(Probe, { names: ["household"] }));
    await report("household", false);
    await advance(5_000);
    await report("household", true);
    await advance(60_000);
    expect(shown).not.toContain(true);
    await report("household", false);
    await advance(10_000);
    // A replacement reports down again: the outage's start stands.
    await report("household", false);
    await advance(10_000);
    expect(shown.at(-1)).toBe(true);
  });

  it("ignores streams it was not asked about, and a stream closed as a page hides", async () => {
    const { render } = mountRoot();
    await render(createElement(Probe, { names: ["household"] }));
    await report("room:barn", false);
    await advance(60_000);
    expect(shown.at(-1)).toBe(false);
    await report("household", false);
    await advance(10_000);
    await report("household", undefined);
    await advance(60_000);
    expect(shown.at(-1)).toBe(false);
  });

  it("calls a stream up only once it has heard from the server", () => {
    expect(streamUp("household")).toBe(false);
    reportStream("household", false);
    expect(streamUp("household")).toBe(false);
    reportStream("household", true);
    expect(streamUp("household")).toBe(true);
    reportStream("household", undefined);
    expect(streamUp("household")).toBe(false);
  });
});
