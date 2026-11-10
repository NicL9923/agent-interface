import { describe, expect, it } from "vitest";
import { waitingOnClose } from "../src/app/close-request";

// What waits on a sheet's close is bound to that mount of the sheet and the account it was raised
// for. The app-level cases in worker-opens-ui.test.ts drive it through the real sheets.
describe("something waiting on a sheet's close", () => {
  const sheet = {}, other = {};

  it.each([
    ["the sheet it waited on, for the same account", sheet, "one", "ranch"],
    ["another mount of the sheet", other, "one", null],
    ["the same sheet after a sign-in as someone else", sheet, "two", null],
    ["no sheet", undefined, "one", null],
  ])("is taken by %s only when both match", (_name, closing, account, expected) => {
    const waiting = waitingOnClose<string>();
    waiting.wait("ranch", sheet, "one");
    expect(waiting.take(closing, account)).toBe(expected);
    // Taken or dropped, it never opens on a later close.
    expect(waiting.take(sheet, "one")).toBeNull();
  });

  it("is cancelled by its own stay, and an older stay leaves a newer wait alone", () => {
    const waiting = waitingOnClose<string>();
    const stayOlder = waiting.wait("ranch", sheet, "one");
    waiting.wait("home", sheet, "one");
    stayOlder();
    expect(waiting.take(sheet, "one")).toBe("home");
    const stay = waiting.wait("ranch", sheet, "one");
    stay();
    expect(waiting.take(sheet, "one")).toBeNull();
  });
});
