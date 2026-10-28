// Local adapter request/ownership/refusal rules are observed. Production41dfcf2c is unavailable.
// Older c3a0ee37/d23cc6b0 assumptions: status vocabulary; promote from todo/blocked
// with done parents, landing on ready; review reassignment; t_ plus8hex IDs.
// Fixture output assumes assign_task(None) clears; same-ID create replay is observed locally.
// Excluded: Block on done/review, adding dependencies to ready, cycles, Request review.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { decodeAutomation } from "../../src/server/hermes-operation-contracts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/work-tasks.json", import.meta.url), "utf8"));
const w1 = JSON.parse(readFileSync(new URL("../fixtures/work-design.json", import.meta.url), "utf8"));
const config = fixture.workFixture;
assert.equal(config.gate, "W2-tasks");
assert.equal(config.taskOrder, "newest-first");
for (const key of ["goals", "triggers", "skills"]) assert.deepEqual(fixture.work[key], w1.work[key], key);
assert.deepEqual(Object.keys(fixture.workStates).sort(), ["empty", "sections-unsupported"]);
for (const key of Object.keys(fixture.workStates)) assert.deepEqual(fixture.workStates[key], w1.workStates[key]);
const bots = new Set(fixture.bots.map((bot: any) => bot.id));
const vocabulary = new Set(["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done"]);
for (const [name, value] of Object.entries<any>({ loaded: fixture.work, ...fixture.workStates })) {
  const { canManageTriggers, canManageLearningPolicy, ...payload } = value;
  assert.equal(typeof canManageTriggers, "boolean", name);
  assert.equal(canManageTriggers, canManageLearningPolicy, name);
  assert.deepEqual(decodeAutomation("overview", payload), payload, `${name}: exact production schema`);
  const items = payload.tasks.items;
  const tasks = new Map<string, any>(items.map((task: any) => [task.id, task]));
  assert.equal(tasks.size, items.length, name);
  for (const [index, task] of items.entries()) {
    assert.match(task.id, /^t_[0-9a-f]{8}$/);
    if (index) assert.ok(items[index - 1].id > task.id, `${name}: newest first`);
    assert.ok(vocabulary.has(task.status));
    assert.ok(task.blockedReason === undefined || task.status === "blocked");
    if (task.status === "review") assert.ok(bots.has(task.assignee));
    for (const id of task.dependencies) assert.ok(tasks.has(id), `${name}: missing ${id}`);
    if (task.status === "ready") assert.ok(task.dependencies.every((id: string) => tasks.get(id).status === "done"));
    if (task.status === "todo") assert.ok(task.dependencies.some((id: string) => tasks.get(id).status !== "done"));
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  function visit(id: string) {
    assert.ok(!visiting.has(id), `${name}: dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const parent of tasks.get(id).dependencies) visit(parent);
    visiting.delete(id); visited.add(id);
  }
  for (const id of tasks.keys()) visit(id);
}
const tasks = new Map<string, any>(fixture.work.tasks.items.map((task: any) => [task.id, task]));
for (const status of ["todo", "running", "blocked", "review", "ready", "done"]) assert.ok([...tasks.values()].some(task => task.status === status));
assert.ok([...tasks.values()].some(task => task.assignee === null));
const subject = (key: string) => { const task = tasks.get(config.subjects[key]); assert.ok(task, key); return task; };
const refused = subject("refusedStart"), start = subject("start"), running = subject("running"), edit = subject("edit");
assert.equal(refused.status, "blocked"); assert.ok(refused.dependencies.some((id: string) => tasks.get(id).status !== "done"));
assert.equal(start.status, "blocked"); assert.deepEqual(start.dependencies, []);
assert.equal(running.status, "running"); assert.notEqual(edit.status, "running"); assert.notEqual(edit.assignee, null);
assert.equal(subject("detail").id, refused.id); assert.equal(subject("review").status, "review");
assert.deepEqual(config.editTask, { taskId: edit.id, assignee: null });
assert.deepEqual(config.newTask, w1.workFixture.newTask);
for (const id of config.newTask.dependencies) { assert.ok(tasks.has(id)); assert.notEqual(tasks.get(id).status, "running"); }
const source = [readFileSync("src/hermes/automation.py", "utf8"), ...readdirSync("src/server").filter(name => name.endsWith(".ts")).map(name => readFileSync(`src/server/${name}`, "utf8"))].join("\n");
for (const key of ["claimedTask", "refusedTransition", "blockReason", "catchAll"]) assert.ok(source.includes(fixture.workMessages[key]), `${key}: missing source text`);
console.log("Work task fixture matches the production decoder and checked native assumptions. Production Hermes 41dfcf2c remains unverified.");
