import { InvalidInput } from "../../shared/errors.js";
import {
  BOT_TASK_STATUSES,
  TASK_STATUSES,
  type BotTaskStatus,
  type TaskStatus,
} from "../../shared/tasks.js";
import type { TaskRepository } from "../store-tasks.js";
import type {
  McpBotContext,
  McpToolDefinition,
  McpToolProvider,
  McpToolResult,
} from "./wildbots-mcp.js";

function textResult(value: unknown): McpToolResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
    ...(typeof value === "object" && value !== null && !Array.isArray(value)
      ? { structuredContent: value as Record<string, unknown> }
      : {}),
  };
}

function optionalText(args: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max)
    throw new InvalidInput(`Provide a valid ${key}.`);
  return value;
}

const definitions: readonly McpToolDefinition[] = [
  {
    name: "task_list",
    description: "List this assistant's tracked tasks (open by default, or filtered by status).",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", ...TASK_STATUSES] },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "task_create",
    description:
      "Create a tracked background task visible in Today. Use for multi-step work you are starting or waiting on.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
        notes: { type: "string", maxLength: 10_000 },
        status: { type: "string", enum: [...BOT_TASK_STATUSES] },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "task_update",
    description:
      "Update a task's progress or propose completion by setting status to 'ready_for_review' with a summary. Only a household member can mark a task 'done'.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", minLength: 1, maxLength: 128 },
        title: { type: "string", minLength: 1, maxLength: 200 },
        notes: { type: "string", maxLength: 10_000 },
        status: { type: "string", enum: [...TASK_STATUSES] },
        summary: { type: "string", maxLength: 4_000 },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
];

export function createTaskMcpTools(tasks: TaskRepository): McpToolProvider {
  return {
    listTools: () => definitions,
    callTool(ctx: McpBotContext, name: string, args: Record<string, unknown>): McpToolResult {
      if (name === "task_list") {
        const raw = args.status === undefined ? "open" : args.status;
        if (
          raw !== "open" &&
          (typeof raw !== "string" || !TASK_STATUSES.includes(raw as TaskStatus))
        )
          throw new InvalidInput("Choose a valid task status filter.");
        return textResult({
          tasks: tasks.listForBots([ctx.botId], { status: raw as TaskStatus | "open" }),
        });
      }
      if (name === "task_create") {
        const title = optionalText(args, "title", 200);
        if (!title?.trim()) throw new InvalidInput("Provide a task title.");
        const notes = optionalText(args, "notes", 10_000);
        const status = args.status === undefined ? "working" : (args.status as BotTaskStatus);
        if (!BOT_TASK_STATUSES.includes(status))
          throw new InvalidInput(
            "New tasks must start as working, needs_input, or ready_for_review.",
          );
        const task = tasks.create({
          botId: ctx.botId,
          title,
          notes,
          status,
          createdBy: `bot:${ctx.botId}`,
        });
        return textResult({ task });
      }
      if (name === "task_update") {
        const taskId = optionalText(args, "taskId", 128);
        if (!taskId?.trim()) throw new InvalidInput("Provide a taskId.");
        const status = args.status === undefined ? undefined : (args.status as TaskStatus);
        if (status !== undefined && !TASK_STATUSES.includes(status))
          throw new InvalidInput("Choose a valid task status.");
        const task = tasks.update(
          taskId,
          {
            title: optionalText(args, "title", 200),
            notes: optionalText(args, "notes", 10_000),
            status,
            summary: optionalText(args, "summary", 4_000),
          },
          { id: `bot:${ctx.botId}`, allowComplete: false, expectedBotId: ctx.botId },
        );
        return textResult({ task });
      }
      return { content: [{ type: "text", text: "Unknown task tool." }], isError: true };
    },
  };
}
