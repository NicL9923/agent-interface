import type { Approval, Bot, Capabilities, Conversation, Routine, Tool } from '../../src/shared/types.js';
import type { ExperienceOperation, ExperienceRequest, ExperienceRequester, ExperienceResult } from '../../src/shared/experience.js';
import type { AutomationOperation, AutomationRequest, AutomationRequester, AutomationResult, AutomationOverview, AutomationTask, EventSubscription } from '../../src/shared/automation.js';
import type { ProfileMemory, RoutineRunReceipt } from '../../src/shared/experience.js';

export const botFixture = (changes: Partial<Bot> = {}): Bot => ({ id: 'shared', name: 'Shared', model: 'test', shared: true, activity: 'idle', ...changes });
export const conversationFixture = (changes: Partial<Conversation> = {}): Conversation => ({ botId: 'shared', messages: [], activity: { state: 'idle' }, approvals: [], files: [], ...changes });
export const routineFixture = (changes: Partial<Routine> = {}): Routine => ({ id: 'routine', botId: 'shared', name: 'Routine', prompt: 'Report', schedule: '0 7 * * *', enabled: true, ...changes });
export const toolFixture = (changes: Partial<Tool> = {}): Tool => ({ id: 'terminal', name: 'Terminal', description: 'Run commands', enabled: true, ...changes });
export const approvalFixture = (changes: Partial<Approval> = {}): Approval => ({ id: 'approval', title: 'Allow command?', detail: 'Run the requested command', status: 'pending', ...changes });
export function capabilitiesFixture(changes: Partial<Capabilities> = {}): Capabilities {
  const unsupported = { supported: false };
  return { chat: unsupported, steering: unsupported, approvals: unsupported, uploads: unsupported,
    generatedFiles: unsupported, botConfiguration: unsupported, tools: unsupported, skills: unsupported,
    routines: unsupported, durableEvents: unsupported, idempotency: unsupported, imageGeneration: unsupported,
    stop: unsupported, portraitGeneration: unsupported, avatarMetadata: unsupported, ...changes };
}
export const memoryFixture = (changes: Partial<ProfileMemory> = {}): ProfileMemory => ({ botId: 'ranch', profile: 'ranch', scope: 'profile', owner: 'Hermes',
  documents: [{ target: 'memory', label: 'Assistant notes', revision: 'a'.repeat(64), enabled: true, entries: [], charLimit: 2000, charCount: 0 },
    { target: 'user', label: 'About you', revision: 'b'.repeat(64), enabled: true, entries: [], charLimit: 1000, charCount: 0 }], notice: 'Shared profile memory.', ...changes });
export const runReceiptFixture = (changes: Partial<RoutineRunReceipt> = {}): RoutineRunReceipt => ({ botId: 'ranch', routineId: 'routine', requestId: 'request', status: 'accepted', startedAt: '2026-10-01T00:00:00Z', ...changes });
export const automationOverviewFixture = (changes: Partial<AutomationOverview> = {}): AutomationOverview => ({ botId: 'ranch', owner: 'Hermes', goals: { supported: true, goal: null }, tasks: { supported: true, items: [] }, triggers: { supported: true, items: [], platformEnabled: false }, skills: { supported: true, installed: [], pending: [], approvalRequired: true }, ...changes });
export const automationTaskFixture = (changes: Partial<AutomationTask> = {}): AutomationTask => ({ id: 't_task', title: 'Fix fence', body: '', status: 'blocked', priority: 0, assignee: 'ranch', owner: 'ranch', dependencies: [], ...changes });
export const subscriptionFixture = (changes: Partial<EventSubscription> = {}): EventSubscription => ({ id: 'fence-event', description: 'Fence issue', events: ['issue.created'], routineId: 'routine', enabled: false, url: 'https://hermes.invalid/hooks/fence-event', secretSet: true, revision: 'a'.repeat(64), ...changes });

/** Each callback must return its operation's result. Unconfigured operations fail at their name. */
function configured<T>(handler: T | undefined, operation: string): T {
  if (!handler) throw new Error(`Runtime fixture ${operation} was not configured.`);
  return handler;
}
export type ExperienceHandlers = { [O in ExperienceOperation]?: (input: ExperienceRequest<O>) => ExperienceResult<O> | Promise<ExperienceResult<O>> };
export function experienceRequester(handlers: ExperienceHandlers): ExperienceRequester {
  function request<R extends ExperienceRequest>(input: R): Promise<ExperienceResult<R['operation']>>;
  async function request(input: ExperienceRequest): Promise<ExperienceResult<ExperienceOperation>> {
    switch (input.operation) {
      case 'search': return configured(handlers.search, input.operation)(input);
      case 'history': return configured(handlers.history, input.operation)(input);
      case 'usage': return configured(handlers.usage, input.operation)(input);
      case 'routine_results': return configured(handlers.routine_results, input.operation)(input);
      case 'routine_output': return configured(handlers.routine_output, input.operation)(input);
      case 'memory': return configured(handlers.memory, input.operation)(input);
      case 'save_memory': return configured(handlers.save_memory, input.operation)(input);
      case 'delete_memory': return configured(handlers.delete_memory, input.operation)(input);
      case 'preview': return configured(handlers.preview, input.operation)(input);
      case 'run': return configured(handlers.run, input.operation)(input);
      case 'run_receipt': return configured(handlers.run_receipt, input.operation)(input);
    }
  }
  return request;
}
export type AutomationHandlers = { [O in AutomationOperation]?: (input: AutomationRequest<O>) => AutomationResult<O> | Promise<AutomationResult<O>> };
export function automationRequester(handlers: AutomationHandlers): AutomationRequester {
  function request<R extends AutomationRequest>(input: R): Promise<AutomationResult<R['operation']>>;
  async function request(input: AutomationRequest): Promise<AutomationResult<AutomationOperation>> {
    switch (input.operation) {
      case 'overview': return configured(handlers.overview, input.operation)(input);
      case 'goal_set': return configured(handlers.goal_set, input.operation)(input);
      case 'goal_pause': return configured(handlers.goal_pause, input.operation)(input);
      case 'goal_clear': return configured(handlers.goal_clear, input.operation)(input);
      case 'goal_resume': return configured(handlers.goal_resume, input.operation)(input);
      case 'task_create': return configured(handlers.task_create, input.operation)(input);
      case 'task_get': return configured(handlers.task_get, input.operation)(input);
      case 'task_update': return configured(handlers.task_update, input.operation)(input);
      case 'task_action': return configured(handlers.task_action, input.operation)(input);
      case 'task_dependency': return configured(handlers.task_dependency, input.operation)(input);
      case 'trigger_create': return configured(handlers.trigger_create, input.operation)(input);
      case 'trigger_update': return configured(handlers.trigger_update, input.operation)(input);
      case 'trigger_toggle': return configured(handlers.trigger_toggle, input.operation)(input);
      case 'trigger_delete': return configured(handlers.trigger_delete, input.operation)(input);
      case 'skill_content': return configured(handlers.skill_content, input.operation)(input);
      case 'skill_diff': return configured(handlers.skill_diff, input.operation)(input);
      case 'skill_decide': return configured(handlers.skill_decide, input.operation)(input);
      case 'skill_policy': return configured(handlers.skill_policy, input.operation)(input);
    }
  }
  return request;
}
