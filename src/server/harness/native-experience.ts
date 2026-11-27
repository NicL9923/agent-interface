import { randomUUID } from "node:crypto";
import { Conflict, InvalidInput, NotFound } from "../../shared/errors.js";
import { excerpt } from "../../shared/event-copy.js";
import type { ManagedBotRecord } from "../../shared/harness.js";
import type { HistoryPage, SearchHit, UsageSummary } from "../../shared/discovery.js";
import type {
  ExperienceRequest,
  ExperienceRequester,
  ExperienceResult,
  MemoryDocument,
  ProfileMemory,
  RoutinePreview,
  RoutineRunReceipt,
} from "../../shared/experience.js";
import type { RoutineOutput, RoutineResult } from "../../shared/collaboration.js";
import type { MemoryKind } from "../../shared/memory.js";
import type { Message, ModelProvider } from "../../shared/types.js";
import {
  firstRoutineTime,
  nextRecurringRoutineTime,
  type NativeRoutineKind,
} from "../native-routine-schedule.js";
import type { NativeRoutineRun } from "../store-native-routines.js";
import { memoryEntryDigest } from "../store-memory.js";
import type { TranscriptMessage } from "../store-transcripts.js";
import type { Store } from "../store.js";

const HISTORY_PAGE_SIZE = 50;
const MAX_PREVIEW_RUNS = 5;

const publicMessage = ({
  seq: _seq,
  updatedAt: _updatedAt,
  sourceRuntime: _source,
  sourceRowId: _row,
  ...message
}: TranscriptMessage): Message => message;

export function parseNativeSchedule(schedule: string): {
  kind: Exclude<NativeRoutineKind, "heartbeat">;
  expression: string;
} {
  const trimmed = schedule.trim();
  if (/^(?:once\b|\d{4}-\d{2}-\d{2}T)/i.test(trimmed))
    return { kind: "once", expression: trimmed.replace(/^once\s+/i, "") };
  const interval = /^(?:every\s+)?(\d+)\s*([mhd])$/i.exec(trimmed);
  if (interval) {
    const multiplier: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
    return {
      kind: "interval",
      expression: String(Number(interval[1]) * multiplier[interval[2]!.toLowerCase()]!),
    };
  }
  return { kind: "cron", expression: trimmed };
}

function previewSchedule(
  botId: string,
  schedule: string,
  timezone: string,
  nowMs: number,
): RoutinePreview {
  const parsed = parseNativeSchedule(schedule);
  const first = firstRoutineTime(parsed.kind, parsed.expression, timezone, nowMs);
  if (parsed.kind === "once") {
    return {
      botId,
      schedule,
      timezone,
      kind: "once",
      nextRuns: [new Date(first).toISOString()],
    };
  }
  const runs: string[] = [new Date(first).toISOString()];
  let cursor = first;
  for (let i = 1; i < MAX_PREVIEW_RUNS; i++) {
    try {
      cursor = nextRecurringRoutineTime(parsed.kind, parsed.expression, timezone, cursor, cursor);
      runs.push(new Date(cursor).toISOString());
    } catch {
      break;
    }
  }
  return {
    botId,
    schedule,
    timezone,
    kind: parsed.kind,
    nextRuns: runs,
  };
}

export interface NativeExperienceOptions {
  store: Store;
  requireBot: (id: string) => ManagedBotRecord;
  isBusy: (botId: string) => boolean;
  runRoutineNow: (routineId: string) => Promise<NativeRoutineRun | undefined>;
  routineResults: (botId: string, routineId: string) => Promise<RoutineResult[]>;
  routineOutput: (botId: string, routineId: string, resultId: string) => Promise<RoutineOutput>;
  modelProviders?: (botId: string) => Promise<ModelProvider[]>;
  now?: () => number;
}

/**
 * Native implementation of `Runtime.experienceRequest` backed by SQLite memory, transcripts,
 * and the native routine scheduler.
 */
export function createNativeExperienceHandler({
  store,
  requireBot,
  isBusy,
  runRoutineNow,
  routineResults,
  routineOutput,
  modelProviders,
  now = Date.now,
}: NativeExperienceOptions): ExperienceRequester {
  const trials = new Map<string, RoutineRunReceipt>();

  function buildMemoryDocument(botId: string, kind: MemoryKind): MemoryDocument {
    const settings = store.memory.settings(botId);
    const active = store.memory.listEntries(botId, "active").filter((entry) => entry.kind === kind);
    const entries = active.map((entry) => ({
      id: memoryEntryDigest(entry.id),
      text: entry.content,
    }));
    const charCount = entries.reduce((sum, entry) => sum + Array.from(entry.text).length, 0);
    return {
      target: kind,
      label: kind === "memory" ? "Assistant memory" : "About the people",
      revision: store.memory.documentRevision(botId, kind),
      enabled: true,
      entries,
      charLimit: settings.memoryCharBudget,
      charCount,
    };
  }

  function buildProfileMemory(bot: ManagedBotRecord, refreshTarget?: MemoryKind): ProfileMemory {
    const documents = [buildMemoryDocument(bot.id, "memory"), buildMemoryDocument(bot.id, "user")];
    const busy = isBusy(bot.id);
    const refreshed = refreshTarget
      ? documents.find((doc) => doc.target === refreshTarget)
      : undefined;
    return {
      botId: bot.id,
      profile: bot.id,
      scope: "profile",
      owner: "WildBots",
      documents,
      notice:
        "Saved in WildBots for this assistant. Changes apply at the next turn without resetting chat history.",
      ...(refreshed
        ? {
            refresh: {
              revision: refreshed.revision,
              state: busy ? "pending" : "next_turn",
              busy,
              message: busy
                ? "Saved. The current reply will finish first, then the next turn uses this updated memory."
                : "Saved. The next turn will use this updated memory.",
            },
          }
        : {}),
    };
  }

  function readAllMessages(botId: string): Message[] {
    const count = store.transcripts.syncState(botId)?.messageCount ?? 0;
    if (!count) return [];
    return store.transcripts.listPage(botId, { limit: count }).messages.map(publicMessage);
  }

  function buildUsage(botId: string, days: number): UsageSummary {
    const cutoff = now() - days * 86_400_000;
    const row = store.db
      .prepare(
        `SELECT count(DISTINCT COALESCE(run_id, message_id)) AS sessions
         FROM transcript_messages
         WHERE bot_id=? AND role='assistant' AND updated_at>=?`,
      )
      .get(botId, cutoff) as { sessions: number };
    return {
      botId,
      days,
      sessions: row.sessions,
      inputTokens: 0,
      outputTokens: 0,
      actualCost: null,
      estimatedCost: null,
      partial: true,
      notice:
        "Token and cost totals are not yet metered for native harness turns. Turn counts come from local history.",
    };
  }

  return (async <R extends ExperienceRequest>(
    input: R,
  ): Promise<ExperienceResult<R["operation"]>> => {
    const bot = requireBot(input.profile);
    switch (input.operation) {
      case "memory":
        return buildProfileMemory(bot) as ExperienceResult<R["operation"]>;

      case "save_memory": {
        store.memory.replaceEntriesByKind(
          bot.id,
          input.target,
          input.entries,
          input.revision,
          "human",
        );
        return buildProfileMemory(bot, input.target) as ExperienceResult<R["operation"]>;
      }

      case "delete_memory": {
        store.memory.retireEntryByDigest(
          bot.id,
          input.target,
          input.entryId,
          input.revision,
          "human",
        );
        return buildProfileMemory(bot, input.target) as ExperienceResult<R["operation"]>;
      }

      case "search": {
        const hits = store.transcripts.search([bot.id], input.query, {
          limit: 20,
          highlight: false,
        });
        const results: SearchHit[] = hits.map((hit) => ({
          botId: bot.id,
          botName: bot.name,
          sessionId: bot.id,
          title: bot.name,
          snippet: store.secrets.redactForBot(bot.id, hit.snippet),
          messageId: hit.messageId,
          ...(hit.createdAt ? { updatedAt: hit.createdAt } : {}),
        }));
        return results as ExperienceResult<R["operation"]>;
      }

      case "history": {
        const all = readAllMessages(bot.id);
        let offset = input.offset;
        let targetMessageId: string | undefined;
        if (input.messageId) {
          const idx = all.findIndex((msg) => msg.id === input.messageId);
          if (idx >= 0) {
            offset = Math.floor(idx / HISTORY_PAGE_SIZE) * HISTORY_PAGE_SIZE;
            targetMessageId = input.messageId;
          }
        }
        const slice = all.slice(offset, offset + HISTORY_PAGE_SIZE);
        const page: HistoryPage = {
          botId: bot.id,
          sessionId: input.sessionId,
          messages: slice,
          offset,
          hasMore: offset + HISTORY_PAGE_SIZE < all.length,
          ...(targetMessageId ? { targetMessageId } : {}),
        };
        return page as ExperienceResult<R["operation"]>;
      }

      case "preview": {
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        return previewSchedule(bot.id, input.schedule, timezone, now()) as ExperienceResult<
          R["operation"]
        >;
      }

      case "run": {
        const existing = trials.get(input.requestId);
        if (existing) {
          if (existing.botId !== bot.id || existing.routineId !== input.routineId)
            throw new Conflict("This trial request ID belongs to a different routine.");
          return { ...existing } as ExperienceResult<R["operation"]>;
        }
        const routine = store.nativeRoutines.get(input.routineId);
        if (!routine || routine.botId !== bot.id) throw new NotFound("Routine not found.");
        const executionId = randomUUID();
        const receipt: RoutineRunReceipt = {
          requestId: input.requestId,
          routineId: routine.id,
          botId: bot.id,
          status: "accepted",
          startedAt: new Date(now()).toISOString(),
          executionId,
          message: "Routine trial started.",
        };
        trials.set(input.requestId, receipt);
        void Promise.resolve()
          .then(() => runRoutineNow(routine.id))
          .then(
            (run) => {
              const finishedAt = new Date(now()).toISOString();
              if (!run || run.status === "failed" || run.status === "interrupted") {
                trials.set(input.requestId, {
                  ...receipt,
                  status: "failed",
                  finishedAt,
                  message: run?.error || "Routine trial did not complete.",
                });
                return;
              }
              trials.set(input.requestId, {
                ...receipt,
                status: "completed",
                finishedAt,
                message: run.outputText ? excerpt(run.outputText, 240) : "Routine trial finished.",
              });
            },
            (error) => {
              trials.set(input.requestId, {
                ...receipt,
                status: "failed",
                finishedAt: new Date(now()).toISOString(),
                message: error instanceof Error ? error.message : "Routine trial failed.",
              });
            },
          );
        return { ...receipt } as ExperienceResult<R["operation"]>;
      }

      case "run_receipt": {
        const receipt = trials.get(input.requestId);
        if (!receipt || receipt.botId !== bot.id || receipt.routineId !== input.routineId)
          throw new NotFound("Trial receipt not found.");
        return { ...receipt } as ExperienceResult<R["operation"]>;
      }

      case "routine_results":
        return (await routineResults(bot.id, input.routineId)) as ExperienceResult<R["operation"]>;

      case "routine_output":
        return (await routineOutput(bot.id, input.routineId, input.resultId)) as ExperienceResult<
          R["operation"]
        >;

      case "usage":
        return buildUsage(bot.id, input.days) as ExperienceResult<R["operation"]>;

      case "model_names": {
        const displayMap = new Map<string, string>();
        if (modelProviders) {
          try {
            for (const provider of await modelProviders(bot.id)) {
              for (const model of provider.models) {
                if (model.name) displayMap.set(`${provider.id}\0${model.id}`, model.name);
              }
            }
          } catch {
            /* Fall back to null names when provider catalogues are unavailable. */
          }
        }
        return {
          names: input.models.map(({ provider, model }) => ({
            provider,
            model,
            name: displayMap.get(`${provider}\0${model}`) ?? null,
          })),
        } as ExperienceResult<R["operation"]>;
      }

      case "accounts":
        return { accounts: [] } as unknown as ExperienceResult<R["operation"]>;

      case "account_usage":
      case "account_reset":
        throw new NotFound("Account usage is not configured for this assistant.");

      default:
        throw new InvalidInput("Unknown experience operation.");
    }
  }) as ExperienceRequester;
}
