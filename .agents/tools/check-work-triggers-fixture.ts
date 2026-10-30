// Invalid trigger submissions are excluded: fixture transports do not model their 400s.
// Never enable the orphan: fixture transports do not model the missing-routine 409.
// Production webhook semantics and Hermes 41dfcf2c remain unverified.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { decodeAutomation } from "../../src/server/hermes-operation-contracts";

const raw = readFileSync(process.argv[2] ?? new URL("../fixtures/work-triggers.json", import.meta.url), "utf8");
const fixture = JSON.parse(raw);
const w2 = JSON.parse(readFileSync(new URL("../fixtures/work-tasks.json", import.meta.url), "utf8"));
const w1 = JSON.parse(readFileSync(new URL("../fixtures/work-design.json", import.meta.url), "utf8"));
const sorted = (value: any): any => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex");
assert.equal(fixture.workFixture.gate, "W3-triggers");
for (const key of ["bots", "preferences", "conversation", "screen"]) assert.deepEqual(fixture[key], w2[key]);
for (const key of ["goals", "skills"]) assert.deepEqual(fixture.work[key], w2.work[key]);
assert.deepEqual(fixture.work.tasks, { supported: true, items: [], truncated: false, limit: 100 });
assert.deepEqual(fixture.work.triggers.items.slice(0, 2), w1.work.triggers.items);
assert.deepEqual(fixture.workFixture.triggerRoutes.slice(0, 2), w1.workFixture.triggerRoutes);
assert.deepEqual(fixture.workFixture.newTrigger, w1.workFixture.newTrigger);
assert.deepEqual(fixture.workStates["sections-unsupported"], w1.workStates["sections-unsupported"]);
assert.deepEqual(Object.keys(fixture.workStates).sort(), ["no-routines", "readonly", "sections-unsupported", "trigger-platform-off"]);
const routines = new Set(fixture.routines.filter((r: any) => r.botId === "ranch").map((r: any) => r.id));
assert.deepEqual([...routines], ["routine-freezer", "routine-weekly"]);
assert.deepEqual(fixture.routines.filter((r: any) => r.botId !== "ranch").map((r: any) => [r.id, r.botId]), [["routine-garden", "garden"]]);
const items = fixture.work.triggers.items;
assert.deepEqual(items.map((item: any) => item.id), ["freezer-alerts", "gate-left-open", "barn-door-sensor"]);
assert.deepEqual(items.filter((item: any) => !routines.has(item.routineId)).map((item: any) => item.id), ["barn-door-sensor"]);
assert.equal(fixture.workFixture.triggerRoutes.length, items.length);
for (const [index, route] of fixture.workFixture.triggerRoutes.entries()) {
  const item = items[index];
  assert.equal(digest(route), item.revision);
  assert.equal(route.profile, "ranch");
  assert.equal(route.description, item.description);
  assert.deepEqual(route.events, item.events);
  assert.equal(route.cron_job, item.routineId);
  assert.equal(route.enabled, item.enabled);
  assert.equal(Boolean(route.secret), item.secretSet);
  assert.equal(item.url, `https://hooks.example.invalid/p/ranch/webhooks/${item.id}`);
}
assert.equal(items[2].events.length, 6);
assert.ok(items[2].events.every((event: string) => !event.includes("*")));
for (const [name, state] of Object.entries<any>({ loaded: fixture.work, ...fixture.workStates })) {
  const { canManageTriggers, canManageLearningPolicy, ...payload } = state;
  assert.equal(typeof canManageTriggers, "boolean", name);
  assert.equal(canManageTriggers, canManageLearningPolicy, name);
  assert.deepEqual(decodeAutomation("overview", payload), payload, name);
  for (const item of payload.triggers.items) assert.deepEqual(item, items.find((candidate: any) => candidate.id === item.id), name);
}
assert.equal(fixture.workStates.readonly.canManageTriggers, false);
assert.equal(fixture.workStates.readonly.triggers.platformEnabled, false);
assert.equal(fixture.workStates["trigger-platform-off"].canManageTriggers, true);
assert.equal(fixture.workStates["trigger-platform-off"].triggers.platformEnabled, false);
assert.equal(fixture.workStates["no-routines"].goals.goal, null);
assert.deepEqual(fixture.workStates["no-routines"].triggers.items, []);
const secret = fixture.workFixture.syntheticSecret;
assert.match(secret, /^[A-Za-z0-9_-]{43}$/); assert.ok(secret.includes("SYNTHETIC"));
assert.ok([...raw].every(character => character.charCodeAt(0) < 128), "fixture must remain ASCII for digest parity");
for (const token of raw.matchAll(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g)) assert.equal(token[0], secret);
for (const [operation, response] of [["trigger_create", { subscription: items[0], secret }], ["trigger_update", { subscription: items[0] }], ["trigger_toggle", { subscription: items[0] }]] as const) {
  assert.deepEqual(decodeAutomation(operation, response), response);
}
const source = [readFileSync("src/hermes/automation.py", "utf8"), ...readdirSync("src/server").filter(name => name.endsWith(".ts")).map(name => readFileSync(`src/server/${name}`, "utf8"))].join("\n");
for (const [name, message] of Object.entries<string>(fixture.workMessages)) assert.ok(source.includes(message), `${name}: missing source text`);
assert.equal(digest({ ...fixture.workFixture.triggerRoutes[0], description: fixture.workFixture.externalTriggerEdit.description }), fixture.workFixture.externalTriggerEdit.revision);
console.log("Work trigger fixture matches the production decoder and checked route assumptions. Production Hermes 41dfcf2c remains unverified.");
