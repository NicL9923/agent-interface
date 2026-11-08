// Native vocabulary and route semantics assume Hermes c3a0ee37/d23cc6b0.
// Production 41dfcf2c was unavailable for source inspection; this is not a production probe.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { decodeAutomation } from "../../src/server/hermes-operation-contracts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/work-design.json", import.meta.url), "utf8"));
const sorted = (value: any): any => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex");
const bots = new Set(fixture.bots.map((bot: any) => bot.id));
const routines = new Set(fixture.routines.filter((routine: any) => routine.botId === "ranch").map((routine: any) => routine.id));
const taskStatuses = new Set(["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done"]);
for (const [name, value] of Object.entries<any>({ loaded: fixture.work, ...fixture.workStates })) {
  const { canManageTriggers, canManageLearningPolicy, ...payload } = value;
  assert.equal(typeof canManageTriggers, "boolean", name);
  assert.equal(canManageTriggers, canManageLearningPolicy, name);
  assert.deepEqual(decodeAutomation("overview", payload), payload, `${name}: exact production schema`);
  if (payload.goals.goal) assert.ok(["active", "paused", "done"].includes(payload.goals.goal.status), name);
  if (payload.goals.resume?.status === "accepted") assert.equal(payload.goals.resume.message, undefined);
  const tasks = new Map<string, any>(payload.tasks.items.map((task: any) => [task.id, task]));
  assert.equal(tasks.size, payload.tasks.items.length);
  for (const task of tasks.values()) {
    assert.match(task.id, /^t_[0-9a-f]{8}$/);
    assert.ok(taskStatuses.has(task.status));
    assert.ok(task.blockedReason === undefined || task.status === "blocked");
    if (task.status === "review") assert.ok(bots.has(task.assignee));
    for (const dependency of task.dependencies) {
      assert.ok(tasks.has(dependency), `${name}: missing ${dependency}`);
      if (task.status === "ready") assert.equal(tasks.get(dependency).status, "done");
    }
  }
  const revisions = new Set<string>();
  for (const trigger of payload.triggers.items) {
    assert.match(trigger.id, /^[a-z0-9][a-z0-9_-]{0,79}$/);
    assert.ok(trigger.events.length >= 1 && trigger.events.length <= 20);
    assert.ok(trigger.events.every((event: string) => /^[A-Za-z0-9_.*:-]{1,100}$/.test(event)));
    assert.equal(trigger.url, `https://hooks.example.invalid/p/ranch/webhooks/${trigger.id}`);
    assert.ok(routines.has(trigger.routineId));
    assert.match(trigger.revision, /^[a-f0-9]{64}$/);
    assert.ok(!revisions.has(trigger.revision)); revisions.add(trigger.revision);
    assert.equal("secret" in trigger, false);
  }
}
for (const [index, route] of fixture.workFixture.triggerRoutes.entries()) {
  const trigger = fixture.work.triggers.items[index];
  assert.equal(digest(route), trigger.revision);
  assert.equal(route.profile, "ranch");
  assert.equal(route.description, trigger.description);
  assert.deepEqual(route.events, trigger.events);
  assert.equal(route.cron_job, trigger.routineId);
  assert.equal(route.enabled, trigger.enabled);
  assert.equal(Boolean(route.secret), trigger.secretSet);
}
const secret = fixture.workFixture.syntheticSecret;
assert.match(secret, /^[A-Za-z0-9_-]{43}$/); assert.ok(secret.includes("SYNTHETIC"));
const subscription = fixture.work.triggers.items[0];
for (const [operation, response] of [["trigger_create", { subscription, secret }], ["trigger_update", { subscription }]] as const) {
  assert.deepEqual(decodeAutomation(operation, response), response);
}
const source = [readFileSync("src/hermes/automation.py", "utf8"), ...readdirSync("src/server").filter(name => name.endsWith(".ts")).map(name => readFileSync(`src/server/${name}`, "utf8"))].join("\n");
for (const [name, message] of Object.entries<string>(fixture.workMessages)) assert.ok(source.includes(message), `${name}: missing source text`);
const template = "This Hermes revision cannot expose {key}. Update and qualify its integration.";
assert.ok(source.includes(template));
for (const key of ["goals", "tasks", "triggers"]) assert.equal(fixture.workStates["sections-unsupported"][key].reason, template.replace("{key}", key));
const external = { ...fixture.workFixture.triggerRoutes[0], description: fixture.workFixture.externalTriggerEdit.description };
assert.equal(digest(external), fixture.workFixture.externalTriggerEdit.revision);
assert.notEqual(digest(external), subscription.revision);
assert.deepEqual(fixture.workFixture.newTask.dependencies, ["t_00000004", "t_00000003"]);
assert.ok(bots.has(fixture.workFixture.newTask.assignee));
assert.ok(routines.has(fixture.workFixture.newTrigger.routineId));
assert.equal(fixture.workFixture.editTaskAssignee, null);
console.log("Work fixture matches the production decoder and checked native assumptions. Production Hermes 41dfcf2c remains unverified.");
