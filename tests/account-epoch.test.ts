// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authEpochKey } from "../src/app/storage";

// What a tab does with each record another tab can leave in storage, by what this tab shows. The App
// asks accountStart once per change of the record; `leftAccount` says the address must go before the
// next account's first draw. The cells the UI tests in account-transitions-ui.test.ts already cover
// are not repeated here: this table holds the rest, one case per branch.
const NOW = Date.UTC(2026, 10, 10, 15);
type Epoch = typeof import("../src/app/account-epoch");
const settled = (fields: object, id = "settled") => JSON.stringify({ id, at: NOW, ...fields });
const mark = (fields: object = {}, id = "changing") => JSON.stringify({ id, at: NOW, changing: true, ...fields });

/** A tab, with its own copy of the module, opened while storage holds `record`. */
async function openWith(record: string | null): Promise<Epoch> {
  if (record === null) localStorage.removeItem(authEpochKey); else localStorage.setItem(authEpochKey, record);
  vi.resetModules();
  return import("../src/app/account-epoch");
}
/** Another tab writes `record`, and this tab's App asks what to draw for it. */
function another(epoch: Epoch, record: string | null) {
  if (record === null) localStorage.removeItem(authEpochKey); else localStorage.setItem(authEpochKey, record);
  return epoch.accountStart();
}

beforeEach(() => { vi.useFakeTimers({ now: NOW }); localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); });

describe("a page that opens while another tab's sign-in or sign-out is on its way", () => {
  it.each([
    // The mark began with member one signed in, so the address is theirs, and stays when the change is undone.
    { name: "a mark that began with member one signed in, put back", opened: mark({ user: "one" }), settles: settled({ user: "one" }, "earlier"), left: false },
    // The mark began signed out; the name is only the last account's, kept for the next sign-in to compare.
    { name: "a mark that began signed out after member one, settled as member two", opened: mark({ user: "one", fromSignedOut: true }), settles: settled({ user: "two" }), left: false },
    // The mark began with an account no record named yet, which may not be the one that settles.
    { name: "a mark that began with an unnamed account, settled as member two", opened: mark(), settles: settled({ user: "two" }), left: true },
  ])("$name: the address left is $left", async ({ opened, settles, left }) => {
    const epoch = await openWith(opened);
    expect(epoch.accountStart()).toMatchObject({ wait: NOW + epoch.CHANGE_STALE_MS });
    expect(another(epoch, settles)).toEqual({ start: "bootstrap", leftAccount: left });
  });

  // A stale mark is settled as far as this tab can tell, as the account it began with or none, and
  // either way the address this page opened with stays for bootstrap to name the account.
  it.each([
    { name: "member one's own mark", opened: mark({ user: "one" }) },
    { name: "a mark that began signed out", opened: mark({ user: "one", fromSignedOut: true }) },
  ])("starts from bootstrap once $name is too old to be on its way, keeping the address", async ({ opened }) => {
    const epoch = await openWith(opened);
    epoch.accountStart();
    vi.setSystemTime(NOW + epoch.CHANGE_STALE_MS);
    expect(epoch.accountStart()).toEqual({ start: "bootstrap", leftAccount: false });
  });
});

describe("a page that shows member one", () => {
  async function showingOne() {
    const epoch = await openWith(settled({ user: "one" }, "earlier"));
    epoch.accountStart();
    expect(epoch.accountNamed("one", undefined)).toBe(true);
    return epoch;
  }

  it.each([
    { name: "a settled record of member two, with no mark first", record: settled({ user: "two" }) },
    { name: "a settled record that names no account", record: settled({}) },
    { name: "storage cleared", record: null },
  ])("drops the address for $name", async ({ record }) => {
    const epoch = await showingOne();
    expect(another(epoch, record)).toEqual({ start: "bootstrap", leftAccount: true });
  });

  it("drops the address when a sign-in that began signed out goes stale, since member one left before it", async () => {
    const epoch = await showingOne();
    // Member one signed out in another tab, which then began a sign-in and closed; this tab heard only the mark.
    expect(another(epoch, mark({ user: "one", fromSignedOut: true }))).toMatchObject({ wait: NOW + epoch.CHANGE_STALE_MS });
    vi.setSystemTime(NOW + epoch.CHANGE_STALE_MS);
    expect(epoch.accountStart()).toEqual({ start: "bootstrap", leftAccount: true });
  });
});

describe("the mark a sign-in or sign-out writes", () => {
  it.each([
    { name: "nothing stored", before: null, fromSignedOut: true, user: undefined },
    { name: "a sign-out of member one", before: settled({ signedOut: true, user: "one" }), fromSignedOut: true, user: "one" },
    { name: "member one signed in", before: settled({ user: "one" }), fromSignedOut: undefined, user: "one" },
    { name: "a record this code cannot read", before: "{not json", fromSignedOut: undefined, user: undefined },
  ])("says whether it began signed out, over $name", async ({ before, fromSignedOut, user }) => {
    const epoch = await openWith(before);
    epoch.accountStart();
    await epoch.beginAccountChange();
    const written = JSON.parse(localStorage.getItem(authEpochKey)!);
    expect(written).toMatchObject({ changing: true });
    expect(written.fromSignedOut).toBe(fromSignedOut);
    expect(written.user).toBe(user);
  });
});
