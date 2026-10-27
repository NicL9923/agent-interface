import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { decodeExperience } from "../../src/server/hermes-operation-contracts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/memory-design.json", import.meta.url), "utf8"));
const digest = (...parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
for (const [name, payload] of Object.entries({ loaded: fixture.memory, ...fixture.memoryStates })) {
  const memory = decodeExperience("memory", payload, fixture.memory.profile, {} as never);
  assert.deepEqual(memory, payload, `${name} must match the production response schema exactly`);
  assert.equal(memory.botId, memory.profile);
  assert.deepEqual(memory.documents.map(document => document.target), ["memory", "user"]);
  for (const document of memory.documents) {
    const texts = document.entries.map(entry => entry.text);
    assert.equal(document.label, document.target === "memory" ? "Assistant notes" : "About you");
    assert.equal(document.revision, digest(memory.profile, document.target, texts));
    for (const entry of document.entries) {
      assert.equal(entry.id, digest(memory.profile, document.target, entry.text));
    }
    assert.equal(document.charCount, [...texts.join(fixture.memoryFixture.delimiter)].length);
    assert.ok(document.charCount <= document.charLimit);
  }
  assert.equal(memory.refresh?.revision, "");
  assert.equal(memory.refresh?.state, "applied");
}
assert.equal(fixture.memoryStates["too-long"].documents[0].charCount, 2180);
assert.ok([...fixture.memoryFixture.limitEditSuffix].length > 20);
console.log("All Memory fixture states match the production schema, IDs and revisions. Counts use the declared synthetic delimiter.");
