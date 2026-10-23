/** Finite human controls. Hermes owns all durable state and execution. */
export interface AutomationSupport { supported: boolean; reason?: string }
export interface PersistentGoal {
  title: string; status: string; turnsUsed: number; maxTurns: number; pausedReason?: string;
}
export interface AutomationTask {
  id: string; title: string; body: string; status: string; priority: number;
  assignee: string | null; owner: string; dependencies: string[]; blockedReason?: string;
}
export interface EventSubscription {
  id: string; description: string; events: string[]; routineId: string; enabled: boolean;
  url: string; secretSet: boolean; revision: string;
}
export interface InstalledSkill { name: string; description: string }
export interface PendingSkill { id: string; summary: string; origin: string; revision: string }
export interface SkillContent { name: string; content: string; truncated: boolean }
export interface SkillDiff { id: string; diff: string; revision: string; truncated: boolean }
export interface AutomationOverview {
  botId: string; owner: 'Hermes'; canManageTriggers?: boolean; canManageLearningPolicy?: boolean;
  goals: AutomationSupport & { goal: PersistentGoal | null; interruptionPending?: boolean; resume?: { requestId: string; status: 'accepted' | 'rejected' | 'uncertain'; runId?: string; message?: string } };
  tasks: AutomationSupport & { items: AutomationTask[]; truncated?: boolean; limit?: number };
  triggers: AutomationSupport & { items: EventSubscription[]; platformEnabled: boolean };
  skills: AutomationSupport & { installed: InstalledSkill[]; pending: PendingSkill[]; approvalRequired: boolean };
}
export interface TaskInput { requestId: string; title: string; body?: string; priority?: number; assignee?: string | null; dependencies?: string[] }
export interface TriggerInput { id: string; description: string; events: string[]; routineId: string }
export type AutomationRequest = { profile: string; visibleProfiles?: string[] } & (
  | { operation: 'overview' }
  | { operation: 'goal_set'; title: string; maxTurns: number }
  | { operation: 'goal_pause' | 'goal_clear' }
  | { operation: 'goal_resume'; requestId: string; senderId: string; reviewedInterruption?: boolean }
  | { operation: 'task_create'; task: TaskInput }
  | { operation: 'task_get'; taskId: string }
  | { operation: 'task_update'; taskId: string; title?: string; body?: string; priority?: number; assignee?: string | null }
  | { operation: 'task_action'; taskId: string; action: 'start' | 'block' | 'unblock' | 'request_review'; reason?: string; reviewer?: string }
  | { operation: 'task_dependency'; taskId: string; dependencyId: string; remove: boolean }
  | { operation: 'trigger_create'; trigger: TriggerInput }
  | { operation: 'trigger_update'; trigger: TriggerInput; revision: string }
  | { operation: 'trigger_toggle'; triggerId: string; enabled: boolean; revision: string }
  | { operation: 'trigger_delete'; triggerId: string; revision: string }
  | { operation: 'skill_content'; name: string }
  | { operation: 'skill_diff'; pendingId: string }
  | { operation: 'skill_decide'; pendingId: string; revision: string; decision: 'approve' | 'reject' }
  | { operation: 'skill_policy'; approvalRequired: boolean }
);
export type AutomationResponse = AutomationOverview | AutomationTask | SkillContent | SkillDiff
  | { ok: true } | { subscription: EventSubscription; secret?: string };
