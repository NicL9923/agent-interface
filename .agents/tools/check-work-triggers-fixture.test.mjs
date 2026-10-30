import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

const fixture = JSON.parse(readFileSync(".agents/fixtures/work-triggers.json", "utf8"));
const root = process.env.TMPDIR;
if (!root?.startsWith("/Volumes/DevSSD/scratch/")) throw Error("Use an existing SSD scratch TMPDIR");
const directory = mkdtempSync(join(root, "w3-checker-test-"));
function check(value) {
  const path = join(directory, "fixture.json");
  writeFileSync(path, JSON.stringify(value));
  return spawnSync(process.execPath, ["--import", "tsx", ".agents/tools/check-work-triggers-fixture.ts", path], { encoding: "utf8" });
}
after(() => rmSync(directory, { recursive: true, force: true }));
  test("accepts the fixture and long hashes without treating substrings as tokens", () => {
    assert.equal(check(fixture).status, 0);
  });
  test("rejects an altered route revision", () => {
    const changed = structuredClone(fixture);
    changed.workFixture.triggerRoutes[2].description += " changed";
    assert.notEqual(check(changed).status, 0);
  });
  test("rejects a state item that differs from its transport route", () => {
    const changed = structuredClone(fixture);
    changed.workStates.readonly.triggers.items[0].revision = "0".repeat(64);
    assert.notEqual(check(changed).status, 0);
  });
  test("rejects a whole secret-shaped token", () => {
    const changed = structuredClone(fixture);
    changed.workFixture.unexpected = "b".repeat(43);
    assert.notEqual(check(changed).status, 0);
  });
  test("rejects another orphan", () => {
    const changed = structuredClone(fixture);
    changed.routines = changed.routines.filter(routine => routine.id !== "routine-weekly");
    assert.notEqual(check(changed).status, 0);
  });
