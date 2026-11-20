// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { connectionCopy, needsSetup } from "../src/components/ConnectionPanel";
import type { RuntimeStatus } from "../src/shared/types";

// What the connection notice and the app's live region say. The rules a person would notice broken:
// it never mentions a draft that does not exist, it says one line until a loss lasts, and the most
// certain fact wins when several are true at once.
const down = (code?: string): RuntimeStatus => ({ connected: false, code }) as RuntimeStatus;
const hermes = { connection: down("unreachable") };
const app = { connection: down("unreachable"), appUnavailable: true };
const chat = { connection: { connected: true } as RuntimeStatus, chatOnly: true };
const offline = { connection: down("unreachable"), offline: true };

describe("what the connection notice says", () => {
  it.each([
    ["offline", offline, "Your draft is kept on this device. "],
    ["the app unreachable", { ...app, lasting: true }, "Your draft is kept. "],
    ["Hermes not answering", { ...hermes, lasting: true }, "Your draft is kept. "],
    ["one chat failing", { ...chat, lasting: true }, "Your draft is kept. "],
  ])("says the draft is kept only when there is one: %s", (_name, state, sentence) => {
    const without = connectionCopy(state).detail!;
    expect(without).not.toMatch(/draft/i);
    // The same notice with the one sentence added, so nothing else changes with it.
    expect(connectionCopy({ ...state, hasDraft: true }).detail!.replace(sentence, "")).toBe(
      without,
    );
  });

  it("never mentions a draft where none is at stake, even when there is one", () => {
    const live = connectionCopy({ ...chat, chatOnly: false, liveOnly: true, hasDraft: true });
    const setup = connectionCopy({ connection: down("unauthorized"), hasDraft: true });
    expect(`${live.detail} ${setup.detail}`).not.toMatch(/draft/i);
  });

  it("says one line with no reason until a loss lasts, then names what is down", () => {
    for (const state of [hermes, app, chat])
      expect(connectionCopy({ ...state, hasDraft: true })).toEqual({ title: "Reconnecting…" });
    expect(connectionCopy({ ...hermes, lasting: true }).title).toBe("Hermes isn't answering");
    expect(connectionCopy({ ...app, lasting: true }).title).toBe("Can't reach the app");
    expect(connectionCopy({ ...chat, lasting: true }).title).toBe("Can't refresh this chat");
  });

  it("calls a server that just started connecting, not reconnecting", () => {
    expect(connectionCopy({ connection: down("connecting") })).toEqual({ title: "Connecting…" });
    expect(connectionCopy({ connection: down("connecting"), lasting: true }).title).toBe(
      "Connecting to Hermes",
    );
    // The app being unreachable says nothing about Hermes, whatever the last answer said of it.
    expect(connectionCopy({ connection: down("connecting"), appUnavailable: true }).title).toBe(
      "Reconnecting…",
    );
  });

  it("lets the most certain fact win: offline, then stopped live updates, then the rest", () => {
    const everything = { ...app, connection: down("unauthorized"), chatOnly: true, lasting: true };
    expect(connectionCopy({ ...everything, offline: true, liveOnly: true }).title).toBe(
      "You're offline",
    );
    expect(connectionCopy({ ...everything, liveOnly: true }).title).toBe(
      "Live updates are delayed",
    );
    // What bootstrap last said of Hermes is stale while the app cannot be reached.
    expect(connectionCopy(everything).title).toBe("Can't reach the app");
  });

  it("asks for setup at once, without waiting for the loss to last", () => {
    const copy = connectionCopy({ connection: down("unauthorized") });
    expect(copy.setup).toBe(true);
    expect(copy.title).toBe("Hermes didn't accept the connection");
  });

  it("treats a code it does not know, or none, as Hermes not answering", () => {
    for (const code of ["something_new", undefined]) {
      expect(needsSetup(down(code))).toBe(false);
      expect(connectionCopy({ connection: down(code), lasting: true }).title).toBe(
        "Hermes isn't answering",
      );
    }
  });

  it("needs setup only while Hermes is down for a reason a person must fix", () => {
    expect(needsSetup(down("not_configured"))).toBe(true);
    expect(needsSetup(down("unreachable"))).toBe(false);
    // Connected is connected, whatever code came with it.
    expect(needsSetup({ connected: true, code: "unauthorized" } as RuntimeStatus)).toBe(false);
    // A code that names an Object.prototype member is no setup state.
    expect(needsSetup(down("toString"))).toBe(false);
  });
});
