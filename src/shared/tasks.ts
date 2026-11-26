export const TASK_STATUSES = ["working", "needs_input", "ready_for_review", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const BOT_TASK_STATUSES = ["working", "needs_input", "ready_for_review"] as const;
export type BotTaskStatus = (typeof BOT_TASK_STATUSES)[number];

export interface NativeTask {
  id: string;
  botId: string;
  botName?: string;
  title: string;
  notes: string;
  status: TaskStatus;
  summary: string | null;
  sourceMessageId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  completedBy: string | null;
}

export interface CreateTaskInput {
  botId: string;
  title: string;
  notes?: string;
  status?: BotTaskStatus;
}

export interface UpdateTaskInput {
  title?: string;
  notes?: string;
  status?: TaskStatus;
  summary?: string | null;
  feedback?: string;
}

export interface TaskListResponse {
  tasks: NativeTask[];
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  working: "Working",
  needs_input: "Needs input",
  ready_for_review: "Ready for review",
  done: "Done",
};
