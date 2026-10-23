import { expect, expectTypeOf, it } from 'vitest';
import type { Runtime } from '../src/shared/types.js';
import type { ProfileMemory, RoutinePreview } from '../src/shared/experience.js';
import type { AutomationOverview, AutomationTask } from '../src/shared/automation.js';
import { fakeRuntime } from './helpers/server.js';
import { automationRequester, experienceRequester } from './helpers/runtime-fixtures.js';

// Compiled by typecheck, never called. Wrong operations and incomplete fixtures
// must be rejected before a route or test can receive an invalid result.
function checkContracts(runtime: Runtime) {
  const memory = runtime.experienceRequest!({operation:'memory',profile:'shared'});
  expectTypeOf(memory).toEqualTypeOf<Promise<ProfileMemory>>();
  const preview = runtime.experienceRequest!({operation:'preview',profile:'shared',schedule:'0 7 * * *'});
  expectTypeOf(preview).toEqualTypeOf<Promise<RoutinePreview>>();
  const task = runtime.automationRequest!({operation:'task_get',profile:'shared',taskId:'task'});
  expectTypeOf(task).toEqualTypeOf<Promise<AutomationTask>>();
  const overview = runtime.automationRequest!({operation:'goal_pause',profile:'shared'});
  expectTypeOf(overview).toEqualTypeOf<Promise<AutomationOverview>>();
  const policy = runtime.automationRequest!({operation:'skill_policy',profile:'shared',approvalRequired:true});
  expectTypeOf(policy).toEqualTypeOf<Promise<{ok:true}>>();
  // @ts-expect-error A preview cannot be used as profile memory.
  const invalidMemory: Promise<ProfileMemory> = preview;
  // @ts-expect-error A goal control returns an overview, not a task.
  const invalidTask: Promise<AutomationTask> = overview;
  // @ts-expect-error A memory operation cannot return another operation's document.
  experienceRequester({memory: () => ({botId:'shared',schedule:'daily',timezone:'UTC',nextRuns:[],kind:'cron'})});
  // @ts-expect-error Required bot fields must be present in typed runtime overrides.
  fakeRuntime({listBots: async () => [{id:'shared'}]});
  // @ts-expect-error Capabilities are a complete production contract.
  fakeRuntime({capabilities: async () => ({chat:{supported:true}})});
  // @ts-expect-error A task callback must return the full task document.
  automationRequester({task_get: () => ({ok:true})});
  // @ts-expect-error Trigger creation must include the one-time native signing secret.
  automationRequester({trigger_create: () => ({subscription:{id:'trigger',description:'Fence',events:[],routineId:'routine',enabled:false,url:'https://example.invalid',secretSet:true,revision:'revision'}})});
  // @ts-expect-error A receipt request requires its stable request and sender identities.
  runtime.experienceRequest!({operation:'run_receipt',profile:'shared',routineId:'routine'});
  void invalidMemory; void invalidTask;
}
void checkContracts;

it('names an unconfigured required runtime call', () => {
  const runtime = fakeRuntime({});
  expect(() => runtime.conversation('shared')).toThrow('fakeRuntime.conversation was not configured');
  expect(runtime.experienceRequest).toBeUndefined();
});
it('names an unconfigured operation fixture', async () => {
  await expect(experienceRequester({})({operation:'memory',profile:'shared'})).rejects.toThrow('Runtime fixture memory was not configured');
  await expect(automationRequester({})({operation:'overview',profile:'shared'})).rejects.toThrow('Runtime fixture overview was not configured');
});
