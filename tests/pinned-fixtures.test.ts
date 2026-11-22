import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path));

// The iOS W3 tests refuse any fixture but the reviewed one, by its SHA-256. Only a native run on
// the Mac sees that refusal, so a reformat once broke them unseen for days. This finds it anywhere.
describe("the W3 event-trigger fixture", () => {
  const fixture = ".agents/fixtures/work-triggers.json";
  const digest = createHash("sha256").update(read(fixture)).digest("hex");
  const pins = ["ScreenshotTourTests.swift", "AutomationFlowTests.swift"].map((file) => {
    const source = read(join("ios", "AgentInterfaceUITests", file)).toString("utf8");
    return {
      file,
      hashes: [...source.matchAll(/SHA256\.hash\(data: \w+\)[^\n]*?"([0-9a-f]{64})"/g)].map(
        (match) => match[1],
      ),
    };
  });

  it("has the bytes the iOS tests pin", () => {
    for (const { file, hashes } of pins) {
      expect(hashes.length, `${file} pins the fixture`).toBeGreaterThan(0);
      for (const hash of hashes) expect(hash, `${file} pin`).toBe(digest);
    }
  });
});
