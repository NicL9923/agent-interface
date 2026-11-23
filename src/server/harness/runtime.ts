import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import {
  Conflict,
  InvalidInput,
  NotFound,
  assistantNameMessage,
  assistantNotFoundMessage,
  fileNotFoundMessage,
  interruptionPendingMessage,
  nothingToStopMessage,
  runChangedMessage,
  submissionConflictMessage,
} from "../../shared/errors.js";
import { excerpt } from "../../shared/event-copy.js";
import type {
  CredentialRecord,
  ManagedBotRecord,
  NativeHarnessKind,
} from "../../shared/harness.js";
import { HISTORY_PAGE_TURNS, MAX_HISTORY_TURNS } from "../../shared/history.js";
import type { QueueItem } from "../../shared/queue.js";
import {
  type Activity,
  type AttentionRequest,
  type Bot,
  type BotInput,
  type ConversationOptions,
  type FileRef,
  type Inflight,
  type HarnessOption,
  type InferenceSettings,
  type Message,
  type Runtime,
  type RuntimeEvent,
  type Submission,
  type SubmissionReceipt,
  type ToolCall,
  type TurnWatcher,
  botIdFor,
  reasoningLevels,
  serviceTiers,
} from "../../shared/types.js";
import { MAX_ATTACHMENTS, MAX_UPLOAD_BYTES, UPLOAD_MIME_TYPES } from "../../shared/uploads.js";
import { assertCredentialPolicy } from "../credential-policy.js";
import type { FileSigner, RegisteredFile } from "../hermes-files.js";
import { httpError } from "../http-error.js";
import { namespacedEventId } from "../runtime-router.js";
import type { Store } from "../store.js";
import type { TranscriptMessage } from "../store-transcripts.js";
import {
  HARNESS_DRIVER_IDS,
  type HarnessDriver,
  type HarnessDriverId,
  type HarnessEvent,
  type HarnessMcpServerSpec,
  type HarnessProbeResult,
  type HarnessTurnInput,
  normalizeHarnessId,
} from "./driver.js";
import { otherHarnessUser, reservedHarnessEnvironment } from "./process-spawn.js";
import { HarnessSessionCoordinator } from "./session-coordinator.js";

const runtimeId = "harness";
const eventPrefix = `${runtimeId}:`;
const eventId = (runId: string) => namespacedEventId(runtimeId, runId);
const missingBot = () => new NotFound(assistantNotFoundMessage, "assistant_not_found");
const missingFile = () => new NotFound(fileNotFoundMessage, "file_not_found");
const unsupported = () => new Conflict("This harness does not support that action.");
const requestNotPending = () =>
  new Conflict("This question is no longer pending.", "request_not_pending");
const submissionConflict = () => new Conflict(submissionConflictMessage, "submission_conflict");
const now = () => new Date().toISOString();
const supported = (value: boolean) => ({ supported: value });
const userMessageId = (item: { id: string }) => `harness-user-${item.id}`;
const validBotId = (id: string) => /^[a-z0-9_-]+$/.test(id) && !/\s/.test(id);
const extensions: Record<(typeof UPLOAD_MIME_TYPES)[number], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "text/plain": "txt",
};
const vendorEnvironment: Partial<Record<CredentialRecord["vendor"], string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  google: "GEMINI_API_KEY",
};

type Watch = NonNullable<Runtime["watch"]>;
type WatchListener = Parameters<Watch>[1];
type Terminal = Extract<HarnessEvent, { type: "turn.completed" | "turn.failed" }>;
type Outcome = Extract<RuntimeEvent["kind"], "completed" | "failed" | "interrupted">;
type PendingQuestion = { providerId: string; request: AttentionRequest; answering?: boolean };
type ActiveTurn = {
  bot: ManagedBotRecord;
  item: QueueItem;
  runId: string;
  promptSeq: number;
  after: string | null;
  messages: Message[];
  reply: Message;
  tools: Map<string, ToolCall>;
  questions: Map<string, PendingQuestion>;
  activity: Activity;
  terminal?: Terminal;
  stopping?: boolean;
  steering?: { requestId: string; promise: Promise<SubmissionReceipt> };
  driver: HarnessDriver;
  sessionId?: string;
};

type QueueAdmission = Pick<
  QueueItem,
  "id" | "botId" | "senderId" | "text" | "status" | "conversationVersion"
> & {
  runId: string | null;
};
type ManagedBotInput = BotInput & {
  /** Server-owned provisioning fields. The public HTTP bot payload does not supply them. */
  credentialId?: string;
  ownerId?: string;
  ownerOsUser?: string;
};
export interface HarnessRuntimeOptions {
  store: Store;
  drivers: Partial<Record<HarnessDriverId, HarnessDriver>>;
  workspaceRoot: string;
  files: FileSigner;
  defaultMcpServers?: (bot: ManagedBotRecord) => HarnessMcpServerSpec[];
  contextFraction?: number;
}

function directory(path: string, mode = 0o700) {
  try {
    mkdirSync(path, { mode });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!lstatSync(path).isDirectory()) throw new Error("Invalid harness workspace directory.");
}

const runFile = promisify(execFile);
async function allowUser(path: string, user: string, permissions: string) {
  // The server owns the directory or file. Grant only this Unix account access, without
  // exposing uploads or workspaces to the other bot accounts.
  await runFile("/usr/bin/setfacl", ["-m", `u:${user}:${permissions}`, "--", path], {
    env: { PATH: "/usr/bin:/bin" },
  });
}

/** Node's and Bun's file handles keep the checked inode open even if the pathname changes. */
async function openRegular(path: string) {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (stat.isFile() && stat.nlink === 1) return { file, stat };
    } catch (error) {
      await file.close();
      throw error;
    }
    await file.close();
  } catch (error) {
    if (
      !["ENOENT", "ENOTDIR", "ELOOP", "EACCES"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
  }
  throw missingFile();
}

const publicMessage = ({
  seq: _seq,
  updatedAt: _updatedAt,
  sourceRuntime: _source,
  sourceRowId: _row,
  ...message
}: TranscriptMessage): Message => message;

export function createHarnessRuntime({
  store,
  drivers,
  workspaceRoot,
  files,
  defaultMcpServers = () => [],
  contextFraction,
}: HarnessRuntimeOptions) {
  const root = resolve(workspaceRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const workspace = realpathSync(root);
  const workspaces = join(workspace, "workspaces");
  const uploads = join(workspace, "uploads");
  directory(workspaces);
  directory(uploads);

  const coordinator = new HarnessSessionCoordinator<ActiveTurn>(store.transcripts, contextFraction);
  const watching = new Map<string, Set<WatchListener>>();
  const turnWatchers = new Set<TurnWatcher>();
  const rosterWatchers = new Set<() => void>();
  const deleting = new Set<string>();
  const preparations = new Map<string, Set<Promise<void>>>();
  const bootId = randomUUID();
  let closed = false;
  let closing: Promise<void> | undefined;

  function trackPreparation<T>(botId: string, work: Promise<T>): Promise<T> {
    const pending = preparations.get(botId) ?? new Set<Promise<void>>();
    preparations.set(botId, pending);
    const settled = work.then(
      () => {},
      () => {},
    );
    pending.add(settled);
    void settled.then(() => {
      pending.delete(settled);
      if (!pending.size) preparations.delete(botId);
    });
    return work;
  }

  const version = (botId: string) => `${bootId}:0:${store.queue.version(botId)}`;
  const registered = HARNESS_DRIVER_IDS.flatMap((id) => (drivers[id] ? [drivers[id]] : []));
  const driverFor = (bot: ManagedBotRecord) => {
    const id = normalizeHarnessId(bot.harness);
    return id && id !== "hermes" ? drivers[id] : undefined;
  };
  const getBot = (id: string) => {
    const bot = store.managedBots.getManagedBot(id);
    return validBotId(id) &&
      bot &&
      bot.harness !== "hermes" &&
      bot.archivedAt == null &&
      !deleting.has(id)
      ? bot
      : undefined;
  };
  const requireBot = (id: string) => {
    const bot = getBot(id);
    if (!bot) throw missingBot();
    return bot;
  };
  const requireDriver = (bot: ManagedBotRecord) => {
    const driver = driverFor(bot);
    if (!driver) throw new Conflict("This assistant's harness is unavailable.", "not_configured");
    return driver;
  };
  const assertOpen = () => {
    if (closed) throw new Conflict("The harness runtime is closed.", "closed");
  };

  function changed(botId: string, kind?: "inflight", turnVersion?: string) {
    for (const listener of watching.get(botId) ?? []) listener(kind, turnVersion);
  }

  function frame(turn: ActiveTurn, kind: "start" | "text" | "end") {
    if (!turn.sessionId) return;
    for (const watcher of turnWatchers) watcher.frame(turn.sessionId, kind);
  }

  function reportRun(botId: string, sessionId: string, runId: string | undefined) {
    for (const watcher of turnWatchers) watcher.run(sessionId, botId, runId, runId !== undefined);
  }

  function rosterChanged() {
    for (const listener of rosterWatchers) listener();
  }

  function structural(botId: string, turn?: ActiveTurn) {
    const generation = store.queue.bumpVersion(botId);
    changed(botId, undefined, turn ? `${bootId}:0:${generation}` : undefined);
  }

  async function probe(driver: HarnessDriver): Promise<HarnessProbeResult> {
    try {
      return await driver.probe();
    } catch {
      return { available: false, reason: "The harness probe failed." };
    }
  }

  function credentialFor(bot: ManagedBotRecord) {
    const credential = bot.credentialId && store.managedBots.getCredential(bot.credentialId);
    if (!credential) throw new InvalidInput("Choose a credential for this native harness.");
    assertCredentialPolicy(bot, credential, { kind: "configure" });
    if (credential.kind === "subscription" && !bot.ownerOsUser)
      throw new InvalidInput("Set the Unix account that owns this subscription login.");
    if (bot.ownerOsUser) otherHarnessUser(bot.ownerOsUser);
    return credential;
  }

  function credentialsEnv(credential: CredentialRecord): Record<string, string> | undefined {
    if (credential.kind === "subscription") return undefined;
    const source = credential.envVar;
    const key = source && Object.hasOwn(process.env, source) ? process.env[source] : undefined;
    if (!source || !key)
      throw new Conflict("The configured harness API key is unavailable.", "not_configured");
    if (reservedHarnessEnvironment(source))
      throw new InvalidInput("Choose a vendor API-key environment variable.");
    return { [vendorEnvironment[credential.vendor] ?? source]: key };
  }

  const attachmentDirectory = (bot: Pick<ManagedBotRecord, "id">) => join(uploads, bot.id);
  const attachmentName =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif|pdf|txt)$/;
  function ownsFile(file: RegisteredFile, bot: ManagedBotRecord): boolean {
    return (
      file.kind === "upload" &&
      file.botId === bot.id &&
      dirname(file.path) === attachmentDirectory(bot) &&
      attachmentName.test(basename(file.path))
    );
  }

  function verifiedFile(id: string, bot?: ManagedBotRecord) {
    const file = files.fileValue(id);
    const owner = bot ?? getBot(file.botId);
    if (!owner || !ownsFile(file, owner)) throw missingFile();
    return file;
  }

  function normalizedFiles(bot: ManagedBotRecord, supplied: FileRef[]) {
    if (supplied.length > MAX_ATTACHMENTS) throw new InvalidInput("Too many message attachments.");
    return supplied.map(({ id }) => {
      const { name, mime } = verifiedFile(id, bot);
      return { id, name, mime, url: `/api/files/${encodeURIComponent(id)}` };
    });
  }

  async function grantTraversal(path: string, user: string, parent: string) {
    await allowUser(workspace, user, "--x");
    await allowUser(parent, user, "--x");
    await allowUser(path, user, "--x");
  }

  async function cwdFor(bot: ManagedBotRecord) {
    // A changed Unix account gets its own workspace. It cannot inherit the previous owner's files.
    const parent = join(workspaces, bot.id);
    directory(parent);
    const cwd = join(parent, bot.ownerOsUser ? `owner-${bot.ownerOsUser}` : "server");
    directory(cwd);
    const user = otherHarnessUser(bot.ownerOsUser || undefined);
    if (user) {
      await grantTraversal(parent, user, workspaces);
      await allowUser(cwd, user, "rwx");
    }
    return cwd;
  }

  async function driverInput(
    bot: ManagedBotRecord,
    input: {
      text: string;
      files: FileRef[];
      senderName: string;
    },
    runId: string,
  ): Promise<HarnessTurnInput> {
    const user = otherHarnessUser(bot.ownerOsUser || undefined);
    const attachments = await Promise.all(
      input.files.map(async ({ id }) => {
        const { path, name, mime } = verifiedFile(id, bot);
        const { file, stat } = await openAttachment(path);
        await file.close();
        if (stat.size > MAX_UPLOAD_BYTES)
          throw new InvalidInput("Attachment is too large.", "file_too_large");
        if (user) {
          await grantTraversal(attachmentDirectory(bot), user, uploads);
          await allowUser(path, user, "r--");
        }
        return { id, path, name, mime };
      }),
    );
    return { turnId: runId, text: input.text, attachments, senderName: input.senderName };
  }

  async function openAttachment(path: string) {
    // Unlike a workspace, an attachment directory is never writable by the harness.
    for (const parent of [uploads, dirname(path)]) {
      if (!(await lstat(parent).catch(() => undefined))?.isDirectory()) throw missingFile();
    }
    return openRegular(path);
  }

  const active = (botId: string) => coordinator.active(botId);
  const latestSettlement = (botId: string) =>
    store.db
      .prepare(
        `SELECT run_id AS runId, status, settled_at AS at FROM bot_queue
     WHERE bot_id=? AND status IN ('completed','interrupted')
     ORDER BY settled_at DESC, rowid DESC LIMIT 1`,
      )
      .get(botId) as
      | { runId: string | null; status: "interrupted" | "completed"; at: number }
      | undefined;

  function activity(bot: ManagedBotRecord): Activity {
    const current = active(bot.id);
    if (current) return { ...current.activity };
    if (closed || !driverFor(bot)) return { state: "disconnected" };
    const last = latestSettlement(bot.id);
    if (last?.status === "interrupted") {
      const runId = last.runId ?? undefined;
      const outcome = runId && store.events.runOutcome(bot.id, runId);
      return {
        state: outcome === "failed" ? "failed" : "interrupted",
        runId,
        updatedAt: new Date(last.at).toISOString(),
      };
    }
    return { state: "idle" };
  }

  function toBot(bot: ManagedBotRecord, detail = false): Bot {
    const preview = store.transcripts.latestPreview(bot.id);
    return {
      id: bot.id,
      name: bot.name,
      harness: normalizeHarnessId(bot.harness),
      description: bot.description,
      instructions: bot.instructions,
      model: bot.model,
      provider: bot.provider || undefined,
      shared: bot.shared,
      ownerId: bot.ownerId || undefined,
      activity: activity(bot).state,
      sessionId: coordinator.session(bot.id)?.id,
      lastMessage: preview && { text: preview.text, at: preview.at },
      enabledMcpServers: bot.enabledMcpServers,
      enabledSkills: bot.enabledSkills,
      enabledTools: bot.enabledTools,
      ...(detail && { availableMcpServers: defaultMcpServers(bot).map(({ name }) => name) }),
    };
  }

  function recordOutcome(
    bot: ManagedBotRecord,
    runId: string,
    kind: Outcome,
    sessionId?: string,
    body?: string,
  ) {
    const title =
      kind === "completed"
        ? `${bot.name} replied`
        : kind === "failed"
          ? "Reply failed"
          : "Reply interrupted";
    const event: RuntimeEvent = {
      id: eventId(runId),
      botId: bot.id,
      runId,
      sessionId,
      kind,
      title,
      body,
      occurredAt: now(),
    };
    store.events.recordEvents([event], store.events.cursor(runtimeId), runtimeId);
  }

  function append(botId: string, rows: Message[]) {
    if (!rows.length) return;
    store.transcripts.appendMessages(botId, rows, runtimeId);
  }

  function finish(turn: ActiveTurn, kind: Outcome, reason?: string, crashed = false) {
    const botId = turn.bot.id;
    if (active(botId) !== turn) return;
    const reply: Message = { ...turn.reply, id: `harness-reply-${turn.runId}` };
    const unfinishedTools = [...turn.tools.values()]
      .filter(({ status }) => status === "running")
      .map((tool) =>
        toolMessage(turn, {
          ...tool,
          status: "failed",
          completedAt: now(),
          error: "Tool execution ended before it reported a result.",
        }),
      );
    append(botId, [...unfinishedTools, ...(reply.text || reply.reasoning ? [reply] : [])]);
    // Write the outcome before settling the queue. Startup can finish a queue row whose
    // outcome was already recorded, even after a process exit between these writes.
    recordOutcome(
      turn.bot,
      turn.runId,
      kind,
      turn.sessionId,
      kind === "completed" && reply.text ? excerpt(reply.text, 240) : undefined,
    );
    if (crashed) store.queue.markRunningInterrupted(botId);
    else if (kind === "completed") store.queue.complete(botId, turn.item.id);
    else store.queue.fail(botId, turn.item.id, reason ?? "The harness turn ended.");
    coordinator.release(botId, turn);
    frame(turn, "end");
    if (turn.sessionId) reportRun(botId, turn.sessionId, undefined);
    changed(botId);
    rosterChanged();
    if (kind === "completed") queueMicrotask(() => drain(botId));
  }

  function toolMessage(turn: ActiveTurn, toolCall: ToolCall): Message {
    return {
      id: `harness-tool-${turn.runId}-${toolCall.id}`,
      role: "tool",
      runId: turn.runId,
      text: toolCall.result ?? toolCall.error ?? "",
      toolName: toolCall.name,
      toolCall,
      createdAt: toolCall.startedAt ?? toolCall.completedAt,
    };
  }

  function terminal(turn: ActiveTurn, event: Terminal) {
    if (turn.stopping) return;
    if (
      event.type === "turn.completed" &&
      (turn.steering ||
        (turn.questions.size && event.stopReason !== "interrupted" && event.stopReason !== "error"))
    ) {
      turn.terminal = event;
      return;
    }
    if (event.type === "turn.failed" || event.stopReason === "error") {
      finish(turn, "failed", "The harness reported a turn failure.");
    } else if (event.stopReason === "interrupted") {
      finish(turn, "interrupted", "The harness interrupted the reply.");
    } else {
      if (event.text !== undefined) turn.reply.text = event.text;
      finish(turn, "completed");
    }
  }

  function onEvent(botId: string, turn: ActiveTurn | undefined, event: HarnessEvent) {
    if (event.type === "session.closed") {
      if (turn)
        finish(
          turn,
          "interrupted",
          "The harness session closed during the reply.",
          event.unexpected,
        );
      return;
    }
    if (!turn || turn.stopping) return;
    switch (event.type) {
      case "turn.started":
        // startTurn can emit this synchronously. The runtime has already published its start.
        return;
      case "text.delta":
      case "reasoning.delta": {
        if (event.type === "text.delta") turn.reply.text += event.delta;
        else turn.reply.reasoning = (turn.reply.reasoning ?? "") + event.delta;
        if (!turn.questions.size) turn.activity.state = "working";
        frame(turn, "text");
        changed(botId, "inflight");
        return;
      }
      case "tool.started":
        turn.tools.set(event.callId, {
          id: event.callId,
          name: event.name,
          arguments: event.arguments,
          status: "running",
          startedAt: now(),
        });
        if (!turn.questions.size) turn.activity.state = "working";
        structural(botId, turn);
        return;
      case "tool.completed": {
        const tool: ToolCall = {
          ...turn.tools.get(event.callId),
          id: event.callId,
          name: event.name,
          status: event.error ? "failed" : "completed",
          result: event.output,
          error: event.error,
          completedAt: now(),
        };
        turn.tools.set(event.callId, tool);
        const message = toolMessage(turn, tool);
        const previous = turn.messages.findIndex(({ id }) => id === message.id);
        if (previous < 0) turn.messages.push(message);
        else turn.messages[previous] = message;
        append(botId, [message]);
        structural(botId, turn);
        return;
      }
      case "question.asked": {
        const id = `${turn.runId}:${event.requestId}`;
        if (turn.questions.has(id)) return;
        turn.questions.set(id, {
          providerId: event.requestId,
          request: {
            id,
            kind: "clarify",
            title: event.title ?? "Question",
            detail: event.prompt,
            questions: event.questions.map(({ id, question, options, multiple }) => ({
              id,
              prompt: question,
              options,
              multiple,
            })),
          },
        });
        turn.activity.state = "waiting";
        // Question cards require a conversation refetch even if the stream supports live turn rows.
        structural(botId);
        rosterChanged();
        return;
      }
      case "turn.completed":
      case "turn.failed":
        terminal(turn, event);
        return;
      case "usage.reported":
      case "session.ready":
        return;
    }
  }

  async function prepareTurn(turn: ActiveTurn) {
    const { bot, driver, runId } = turn;
    try {
      const credential = credentialFor(bot);
      const env = credentialsEnv(credential);
      const cwd = await cwdFor(bot);
      const input = await driverInput(bot, turn.item, runId);
      if (closed || active(bot.id) !== turn || turn.stopping) return;
      const session = await coordinator.open(
        bot.id,
        turn,
        driver,
        {
          botId: bot.id,
          cwd,
          osUser: bot.ownerOsUser || undefined,
          model: bot.model,
          provider: bot.provider || undefined,
          reasoning: driver.capabilities.supportsReasoning ? bot.reasoning : undefined,
          speed: driver.capabilities.supportsSpeed ? bot.speed : undefined,
          systemPrompt: bot.instructions,
          env,
          mcpServers: driver.capabilities.supportsMcp
            ? defaultMcpServers(bot).filter(({ name }) => bot.enabledMcpServers.includes(name))
            : undefined,
          fullPermissions: true,
        },
        (current, event) => onEvent(bot.id, current, event),
      );
      if (!session || closed || active(bot.id) !== turn || turn.stopping) return;
      turn.sessionId = session.id;
      frame(turn, "start");
      reportRun(bot.id, session.id, runId);
      // Some drivers resolve startTurn on admission and others hold it for the turn.
      void Promise.resolve(session.startTurn(input)).catch(() => failStart(turn));
    } catch {
      await failStart(turn);
    }
  }

  async function failStart(turn: ActiveTurn) {
    if (active(turn.bot.id) !== turn || turn.stopping) return;
    turn.stopping = true;
    const retired = coordinator.retireSession(turn.bot.id).catch(() => {});
    finish(turn, "failed", "The harness could not start the reply.");
    await retired;
  }

  function drain(botId: string, reviewed = false): ActiveTurn | undefined {
    if (closed || active(botId)) return;
    const bot = getBot(botId);
    const driver = bot && driverFor(bot);
    if (!bot || !driver || (!reviewed && activity(bot).state === "interrupted")) return;
    const runId = randomUUID();
    const item = store.queue.claimNext(botId, runId);
    if (!item) return;
    const prompt: Message = {
      id: userMessageId(item),
      runId,
      role: "user",
      text: item.text,
      sender: { id: item.senderId, name: item.senderName },
      files: item.files,
      createdAt: new Date(item.createdAt).toISOString(),
    };
    const after = store.transcripts.listPage(botId, { limit: 1 }).messages[0]?.id ?? null;
    append(botId, [prompt]);
    store.transcripts.markCanonicalLocal(botId);
    store.participate(runId, item.senderId);
    const startedAt = now();
    const turn: ActiveTurn = {
      bot,
      driver,
      item,
      runId,
      after,
      promptSeq: store.transcripts.messageSeq(botId, prompt.id)!,
      messages: [prompt],
      reply: { id: `${runId}-inflight`, runId, role: "assistant", text: "", createdAt: startedAt },
      activity: { state: "thinking", runId, updatedAt: startedAt },
      tools: new Map(),
      questions: new Map(),
    };
    coordinator.reserve(botId, turn);
    void trackPreparation(botId, prepareTurn(turn));
    changed(botId, undefined, version(botId));
    rosterChanged();
    return turn;
  }

  const queueByRequest = store.db.prepare(
    `SELECT id,bot_id AS botId,sender_id AS senderId,text,status,run_id AS runId,
      conversation_version AS conversationVersion FROM bot_queue WHERE request_id=?`,
  );
  const queueAdmission = (id: string) => queueByRequest.get(id) as QueueAdmission | undefined;
  function queuedReceipt(requestId: string, row: QueueAdmission): SubmissionReceipt {
    return {
      requestId,
      status:
        row.status === "interrupted"
          ? "interrupted"
          : row.status === "cancelled"
            ? "rejected"
            : "accepted",
      ...(row.runId && { runId: row.runId }),
      ...(row.status !== "cancelled" && (row.runId || row.status === "queued")
        ? { messageId: userMessageId(row) }
        : {}),
      ...(row.status === "queued"
        ? { turn: "queued" }
        : row.status === "running" || row.status === "completed"
          ? { turn: "started" }
          : {}),
      ...(row.status === "cancelled" ? { message: "The queued message was cancelled." } : {}),
    };
  }

  function senderName(senderId: string): string {
    const sender = store.getUser(senderId);
    if (!sender) throw new InvalidInput("This sender is not registered.");
    return sender.name;
  }

  function recordedInput(input: Submission): Submission {
    return (
      store.submission(input.requestId)?.input ?? {
        requestId: input.requestId,
        botId: input.botId,
        senderId: input.senderId,
        text: input.text,
        attachments: input.attachments,
        ...(input.draftBaseRevision !== undefined && {
          draftBaseRevision: input.draftBaseRevision,
        }),
        ...(input.retryOf !== undefined && { retryOf: input.retryOf }),
      }
    );
  }

  function known(input: Submission): SubmissionReceipt | undefined {
    const found = store.submission(input.requestId);
    const queue = queueAdmission(input.requestId);
    const previous = found?.input ?? queue;
    if (
      previous &&
      (previous.botId !== input.botId ||
        previous.senderId !== input.senderId ||
        previous.text !== input.text ||
        (found &&
          JSON.stringify(found.input.attachments.map(({ id }) => id)) !==
            JSON.stringify(input.attachments.map(({ id }) => id))))
    )
      throw submissionConflict();
    if (queue) {
      const receipt = queuedReceipt(input.requestId, queue);
      return receipt.status === "accepted" && found?.receipt.status === "accepted"
        ? { ...receipt, ...found.receipt, ...(receipt.runId && { runId: receipt.runId }) }
        : receipt;
    }
    if (found?.receipt.status === "accepted" || found?.receipt.status === "interrupted")
      return found.receipt;
    return undefined;
  }

  function history(botId: string, options: ConversationOptions) {
    if (options.history === false) return { messages: [] };
    const window = options.window;
    if (!window) {
      const count = store.transcripts.syncState(botId)?.messageCount ?? 0;
      return {
        messages: count
          ? store.transcripts.listPage(botId, { limit: count }).messages.map(publicMessage)
          : [],
      };
    }

    const boundary = window.before ?? window.start;
    const seq = boundary === undefined ? undefined : store.transcripts.messageSeq(botId, boundary);
    let remaining = Math.min(MAX_HISTORY_TURNS, Math.max(0, window.turns ?? HISTORY_PAGE_TURNS));
    if (window.start && seq === undefined) remaining = Math.max(HISTORY_PAGE_TURNS, remaining);
    if (window.start && seq !== undefined && window.turns === undefined) remaining = 0;
    let from = window.start ? seq : undefined;
    let before = seq;
    while (remaining > 0) {
      const page = store.transcripts.listPage(botId, { limit: 128, beforeSeq: before });
      for (const row of page.messages.reverse()) {
        from = row.seq;
        if (row.role === "user" && !row.steered && --remaining === 0) break;
      }
      if (!page.hasMore) break;
      before = page.oldestSeq ?? undefined;
    }
    const upper = window.before && seq !== undefined ? seq : Number.MAX_SAFE_INTEGER;
    const lower = from ?? upper;
    const { count } = store.db
      .prepare(
        "SELECT count(*) AS count FROM transcript_messages WHERE bot_id=? AND seq>=? AND seq<?",
      )
      .get(botId, lower, upper) as { count: number };
    const messages = count
      ? store.transcripts
          .listPage(botId, { limit: count, beforeSeq: upper })
          .messages.map(publicMessage)
      : [];
    const earlier = (
      store.db
        .prepare("SELECT count(*) AS count FROM transcript_messages WHERE bot_id=? AND seq<?")
        .get(botId, lower) as { count: number }
    ).count;
    const context = (
      store.db
        .prepare(
          "SELECT message_id AS id, role, files_json AS files FROM transcript_messages WHERE bot_id=? AND seq<? AND files_json IS NOT NULL ORDER BY seq",
        )
        .all(botId, lower) as { id: string; role: Message["role"]; files: string }[]
    ).flatMap(({ id, role, files }) => {
      const refs = JSON.parse(files) as FileRef[] | null;
      return refs?.length ? [{ id, role, text: "", files: refs }] : [];
    });
    return {
      messages,
      window: {
        earlier,
        context,
        ...(window.before && seq !== undefined && { before: window.before }),
      },
    };
  }

  function checkedVersion(botId: string, expected?: string | number): number | undefined {
    if (expected === undefined) return;
    const current = store.queue.version(botId);
    if (expected !== current && expected !== version(botId))
      throw new Conflict(
        "The conversation changed before your action was sent.",
        "conversation_changed",
      );
    return current;
  }

  function inflight(botId: string): Inflight | undefined {
    const current = active(botId);
    return (
      current && {
        botId,
        message: { ...current.reply },
        activity: { ...current.activity },
        toolCalls: [...current.tools.values()],
      }
    );
  }

  type HarnessSubmission = Submission & { conversationVersion?: string | number };
  const runtime = {
    async status() {
      if (closed) return { connected: false, code: "closed" };
      if (!registered.length) return { connected: false, code: "not_configured" };
      const results = await Promise.all(registered.map(probe));
      return closed
        ? { connected: false, code: "closed" }
        : {
            connected: true,
            code: "ready",
            ...(!results.some(({ available }) => available) && {
              detail: "No registered harness passed its availability probe.",
            }),
          };
    },
    async harnessOptions(): Promise<HarnessOption[]> {
      return Promise.all(
        registered.map(async (driver) => {
          const { available, reason } = await probe(driver);
          return { id: driver.id, available, reason };
        }),
      );
    },
    async capabilities(botId) {
      const driver = botId === undefined ? registered[0] : driverFor(requireBot(botId));
      const configured = !!driver && !closed;
      return {
        chat: supported(configured),
        steering: supported(configured && driver.capabilities.nativeSteering),
        queueManagement: supported(true),
        approvals: supported(false),
        uploads: supported(configured),
        generatedFiles: supported(false),
        botConfiguration: supported(registered.length > 0 && !closed),
        tools: supported(false),
        skills: supported(false),
        routines: supported(false),
        durableEvents: supported(true),
        idempotency: supported(true),
        imageGeneration: supported(false),
        stop: supported(configured),
        portraitGeneration: supported(false),
        avatarMetadata: supported(false),
        liveVoice: supported(false),
      };
    },
    async listBots() {
      return store.managedBots
        .listManagedBots()
        .filter(({ id }) => getBot(id))
        .map((bot) => toBot(bot));
    },
    async botDetail(botId) {
      return toBot(requireBot(botId), true);
    },
    async saveBot(input: ManagedBotInput, id?: string) {
      assertOpen();
      const botId = id ?? botIdFor(input.name);
      if (!validBotId(botId))
        throw new InvalidInput(assistantNameMessage, "assistant_name_invalid");
      const previous = id === undefined ? undefined : requireBot(id);
      if (id === undefined && store.managedBots.getManagedBot(botId))
        throw new Conflict("An assistant with this name already exists. Choose another name.");
      const driverId = normalizeHarnessId(input.harness ?? previous?.harness ?? registered[0]?.id);
      if (!driverId || driverId === "hermes" || !drivers[driverId])
        throw new InvalidInput("Choose a registered native harness.");
      const harness: NativeHarnessKind = driverId;
      const ownerId = input.ownerId ?? store.presentation(botId).ownerId ?? previous?.ownerId ?? "";
      if (!input.shared && !ownerId)
        throw new InvalidInput("Choose an owner for this personal assistant.");
      const configured = store.managedBots
        .listCredentials()
        .filter(
          (credential) =>
            credential.kind === "api_key" &&
            credential.ownerId === undefined &&
            credential.allowedHarnesses.includes(harness),
        );
      const credentialId =
        input.credentialId ??
        previous?.credentialId ??
        (configured.length === 1 ? configured[0].id : null);
      const credential =
        credentialId === null ? undefined : store.managedBots.getCredential(credentialId);
      const next: ManagedBotRecord = {
        id: botId,
        name: input.name,
        description: input.description ?? "",
        instructions: input.instructions,
        harness,
        model: input.model,
        provider: input.provider ?? previous?.provider ?? "",
        reasoning: previous?.reasoning ?? "none",
        speed: previous?.speed ?? "normal",
        ownerId,
        ownerOsUser: input.ownerOsUser ?? credential?.osUser ?? previous?.ownerOsUser ?? "",
        shared: input.shared,
        credentialId,
        enabledTools: input.enabledTools ?? previous?.enabledTools ?? [],
        enabledSkills: input.enabledSkills ?? previous?.enabledSkills ?? [],
        enabledMcpServers: input.enabledMcpServers ?? previous?.enabledMcpServers ?? [],
        createdAt: previous?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      };
      if (!previous && input.enabledMcpServers === undefined)
        next.enabledMcpServers = defaultMcpServers(next).map(({ name }) => name);
      credentialFor(next);
      if (
        active(botId) &&
        previous &&
        (next.ownerId !== previous.ownerId ||
          next.ownerOsUser !== previous.ownerOsUser ||
          next.shared !== previous.shared)
      )
        throw new Conflict(
          "Wait for the current reply to finish before changing its owner or sharing.",
        );
      const saved = store.managedBots.upsertManagedBot(next);
      rosterChanged();
      return toBot(saved, true);
    },
    async deleteBot(id) {
      assertOpen();
      requireBot(id);
      deleting.add(id);
      try {
        const current = active(id);
        if (current) {
          current.stopping = true;
          finish(current, "interrupted");
        }
        await coordinator.closeBot(id);
        const pending = preparations.get(id);
        if (pending) await Promise.all([...pending]);
        // Reused bot IDs must not reopen an old file, queue, or transcript.
        await rm(join(workspaces, id), { recursive: true, force: true });
        await rm(join(uploads, id), { recursive: true, force: true });
        store.forgetBot(id);
        store.managedBots.deleteManagedBot(id);
        rosterChanged();
      } finally {
        deleting.delete(id);
      }
    },
    async conversation(botId, options = {}) {
      const bot = requireBot(botId);
      const current = options.window?.before === undefined ? active(botId) : undefined;
      const result = history(botId, options);
      const sessionId =
        options.window?.before === undefined
          ? current
            ? current.sessionId
            : coordinator.session(botId)?.id
          : undefined;
      const state =
        options.window?.before === undefined ? activity(bot) : { state: "idle" as const };
      if (sessionId) reportRun(botId, sessionId, current?.runId);
      return {
        ...result,
        botId,
        sessionId,
        requestSessionId: sessionId,
        activity: state,
        version: version(botId),
        approvals: [],
        attention: current && [...current.questions.values()].map(({ request }) => request),
        toolCalls: current && [...current.tools.values()],
        files: [
          ...new Map(
            result.messages.flatMap(({ files }) => files ?? []).map((file) => [file.id, file]),
          ).values(),
        ],
      };
    },
    async submit(input: HarnessSubmission) {
      assertOpen();
      const bot = requireBot(input.botId);
      if (!bot.shared && bot.ownerId !== input.senderId) throw missingBot();
      const previous = known(input);
      if (previous) return previous;
      requireDriver(bot);
      credentialsEnv(credentialFor(bot));
      if (!input.reviewedInterruption && activity(bot).state === "interrupted")
        throw new Conflict(interruptionPendingMessage, "interruption_pending");
      if (!input.text.trim() && !input.attachments.length)
        throw new InvalidInput("Message cannot be empty.");
      const attachments = normalizedFiles(bot, input.attachments);
      const expectedVersion = checkedVersion(bot.id, input.conversationVersion);
      const botId = bot.id;
      store.queue.enqueue({
        botId,
        requestId: input.requestId,
        senderId: input.senderId,
        senderName: senderName(input.senderId),
        text: input.text,
        files: attachments,
        expectedVersion,
      });
      if (!store.submission(input.requestId)) store.intent(recordedInput(input));
      drain(botId, input.reviewedInterruption);
      const receipt = {
        ...queuedReceipt(input.requestId, queueAdmission(input.requestId)!),
        admittedVersion: version(botId),
      };
      store.receipt(receipt, undefined, input.reviewedInterruption);
      if (receipt.turn === "queued") changed(botId);
      return receipt;
    },
    async lookupSubmission(requestId: string, botId?: string) {
      const queue = queueAdmission(requestId);
      if (queue && getBot(queue.botId) && (botId === undefined || queue.botId === botId))
        return queuedReceipt(requestId, queue);
      const found = store.submission(requestId);
      if (
        found?.receipt.steered &&
        getBot(found.input.botId) &&
        (botId === undefined || botId === found.input.botId)
      )
        return found.receipt;
      return null;
    },
    async steer(input: HarnessSubmission) {
      assertOpen();
      const bot = requireBot(input.botId);
      if (!bot.shared && bot.ownerId !== input.senderId) throw missingBot();
      const previous = known(input);
      if (previous) return previous;
      const current = active(bot.id);
      const session = coordinator.session(bot.id);
      if (!requireDriver(bot).capabilities.nativeSteering)
        throw new Conflict("This harness does not support steering.");
      if (
        !current?.driver.capabilities.nativeSteering ||
        !current.sessionId ||
        !session?.steer ||
        current.stopping ||
        current.terminal
      )
        throw new Conflict(nothingToStopMessage, "nothing_to_stop");
      if (current.steering) {
        if (current.steering.requestId === input.requestId) {
          known(input);
          return current.steering.promise;
        }
        throw new Conflict("Another message is being steered into this reply.");
      }
      if (!input.text.trim() && !input.attachments.length)
        throw new InvalidInput("Message cannot be empty.");
      const files = normalizedFiles(bot, input.attachments);
      checkedVersion(bot.id, input.conversationVersion);
      const name = senderName(input.senderId);
      if (!store.submission(input.requestId)) store.intent(recordedInput(input));
      const send = session.steer.bind(session);
      const promise = (async (): Promise<SubmissionReceipt> => {
        const payload = await driverInput(
          current.bot,
          { text: input.text, files, senderName: name },
          current.runId,
        );
        if (active(bot.id) !== current || current.stopping)
          throw new Conflict(runChangedMessage, "run_changed");
        await send(payload);
        if (active(bot.id) !== current || current.stopping)
          throw new Conflict(runChangedMessage, "run_changed");
        const message: Message = {
          id: `harness-steer-${randomUUID()}`,
          role: "user",
          runId: current.runId,
          text: input.text,
          files,
          steered: true,
          sender: { id: input.senderId, name },
          createdAt: now(),
        };
        append(bot.id, [message]);
        current.messages.push(message);
        store.participate(current.runId, input.senderId);
        structural(bot.id, current);
        rosterChanged();
        const receipt: SubmissionReceipt = {
          requestId: input.requestId,
          status: "accepted",
          runId: current.runId,
          messageId: message.id,
          steered: true,
          admittedVersion: version(bot.id),
        };
        store.receipt(receipt);
        return receipt;
      })().finally(() => {
        current.steering = undefined;
        if (active(bot.id) === current && current.terminal) terminal(current, current.terminal);
      });
      current.steering = { requestId: input.requestId, promise };
      return promise;
    },
    async answerRequest(botId, requestId, answers) {
      requireBot(botId);
      const current = active(botId);
      const pending = current?.questions.get(requestId);
      const session = coordinator.session(botId);
      if (!current || current.stopping || !pending || pending.answering || !session)
        throw requestNotPending();
      pending.answering = true;
      try {
        await session.answerQuestion(pending.providerId, answers);
        if (active(botId) !== current || current.stopping) throw requestNotPending();
        current.questions.delete(requestId);
        if (!current.questions.size) current.activity.state = "working";
      } finally {
        pending.answering = false;
      }
      structural(botId);
      rosterChanged();
      if (current.terminal) terminal(current, current.terminal);
    },
    async stop(botId: string, runId?: string) {
      requireBot(botId);
      const current = active(botId);
      if (!current || current.stopping) throw new Conflict(nothingToStopMessage, "nothing_to_stop");
      if (runId !== undefined && current.runId !== runId)
        throw new Conflict(runChangedMessage, "run_changed");
      current.stopping = true;
      const session = current.sessionId ? coordinator.session(botId) : undefined;
      try {
        await session?.interrupt(current.runId);
      } finally {
        // A session.closed event may have settled this run while interrupt was in flight.
        if (active(botId) === current) {
          const retired = coordinator.retireSession(botId);
          finish(current, "interrupted", "The reply was stopped.");
          await retired;
        }
      }
    },
    watch(botId, listener) {
      const listeners = watching.get(botId) ?? new Set<WatchListener>();
      const entry: WatchListener = (...args) => listener(...args);
      watching.set(botId, listeners);
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
        if (!listeners.size && watching.get(botId) === listeners) watching.delete(botId);
      };
    },
    inflight,
    turn(botId) {
      const current = active(botId);
      const live = inflight(botId);
      return (
        current &&
        live && {
          ...live,
          version: version(botId),
          turn: { messages: [...current.messages], after: current.after },
        }
      );
    },
    watchTurns(watcher) {
      turnWatchers.add(watcher);
      return () => {
        turnWatchers.delete(watcher);
      };
    },
    watchRoster(listener) {
      rosterWatchers.add(listener);
      return () => {
        rosterWatchers.delete(listener);
      };
    },
    eventSources: () => [runtimeId],
    async discoverEvents(cursor: string, source?: string) {
      if (source !== undefined && source !== runtimeId) throw unsupported();
      const after = cursor === "" ? 0 : Number(cursor);
      if (!Number.isSafeInteger(after) || after < 0)
        throw new InvalidInput("Invalid harness event cursor.");
      const rows = store.db
        .prepare(
          `SELECT i.id AS seq,e.value FROM notification_ingestion i JOIN notification_events e ON e.id=i.event_id
          WHERE i.id>? AND e.id GLOB ? ORDER BY i.id LIMIT 100`,
        )
        .all(after, `${eventPrefix}*`) as { seq: number; value: string }[];
      return {
        cursor: String(rows.at(-1)?.seq ?? after),
        events: rows.map(({ value }) => JSON.parse(value) as RuntimeEvent),
      };
    },
    async upload(botId, { name, mime, data }) {
      assertOpen();
      const bot = requireBot(botId);
      if (
        !name.trim() ||
        name.length > 255 ||
        Array.from(name).some((char) => char.charCodeAt(0) < 32 || char === "\u007f")
      )
        throw new InvalidInput("Invalid attachment name.");
      if (!Object.hasOwn(extensions, mime)) throw new InvalidInput("Unsupported attachment type.");
      if (data.length > MAX_UPLOAD_BYTES)
        throw new InvalidInput("Attachment is too large.", "file_too_large");
      return trackPreparation(
        botId,
        (async () => {
          const parent = attachmentDirectory(bot);
          directory(parent);
          const path = join(
            parent,
            `${randomUUID()}.${extensions[mime as keyof typeof extensions]}`,
          );
          const file = await open(path, "wx", 0o600);
          try {
            await file.writeFile(data);
          } catch (error) {
            await rm(path, { force: true });
            throw error;
          } finally {
            await file.close();
          }
          if (!getBot(botId)) throw missingBot();
          return {
            ...files.signFile({ path, name, mime, botId, kind: "upload", version: 1 }),
            size: data.length,
          };
        })(),
      );
    },
    fileBotId(id) {
      try {
        return verifiedFile(id).botId;
      } catch (error) {
        if (error instanceof NotFound) return undefined;
        throw error;
      }
    },
    async download(id: string, maxBytes: number, botId?: string) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
        throw new InvalidInput("Invalid download size limit.");
      const owner = botId === undefined ? undefined : getBot(botId);
      if (botId !== undefined && !owner) throw missingFile();
      const { path, name, mime } = verifiedFile(id, owner);
      const { file, stat } = await openAttachment(path);
      if (stat.size > maxBytes) {
        await file.close();
        throw httpError(413, "This attachment exceeds the download size limit.", {
          code: "file_too_large",
        });
      }
      if (stat.size === 0) {
        await file.close();
        return {
          name,
          mime,
          size: 0,
          body: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
        };
      }
      const body = Readable.toWeb(
        file.createReadStream({ end: stat.size - 1 }),
      ) as unknown as ReadableStream<Uint8Array>;
      return { name, mime, size: stat.size, body };
    },
    async modelOptions(botId) {
      if (botId !== undefined) {
        const bot = requireBot(botId);
        return {
          providers: await requireDriver(bot).listModels(),
          provider: bot.provider,
          model: bot.model,
        };
      }
      const catalogues = await Promise.allSettled(registered.map((driver) => driver.listModels()));
      const providers = catalogues.flatMap((catalogue) =>
        catalogue.status === "fulfilled" ? catalogue.value : [],
      );
      return { providers, provider: "", model: "" };
    },
    async inferenceSettings(botId, update) {
      const bot = requireBot(botId);
      const { capabilities } = requireDriver(bot);
      const settings: InferenceSettings = {
        reasoning: reasoningLevels.find((level) => level === bot.reasoning) ?? "none",
        speed: serviceTiers.find((tier) => tier === bot.speed) ?? "normal",
      };
      if (!update) return settings;
      assertOpen();
      if (
        (update.reasoning !== undefined && !capabilities.supportsReasoning) ||
        (update.speed !== undefined && !capabilities.supportsSpeed)
      )
        throw unsupported();
      const next = { ...settings, ...update };
      store.managedBots.upsertManagedBot({ ...bot, ...next, updatedAt: Date.now() });
      rosterChanged();
      return next;
    },
    async approve() {
      throw unsupported();
    },
    async generatePortrait() {
      throw unsupported();
    },
    async tools() {
      throw unsupported();
    },
    async setTools() {
      throw unsupported();
    },
    async skills() {
      throw unsupported();
    },
    async setSkills() {
      throw unsupported();
    },
    async routines(botId) {
      if (botId !== undefined) requireBot(botId);
      return [];
    },
    async saveRoutine() {
      throw unsupported();
    },
    async deleteRoutine() {
      throw unsupported();
    },
    close() {
      return (closing ??= (async () => {
        closed = true;
        for (const bot of store.managedBots.listManagedBots()) {
          const turn = active(bot.id);
          if (turn) finish(turn, "interrupted", "The harness runtime closed.");
        }
        const results = await Promise.allSettled([
          coordinator.close(),
          ...[...preparations.values()].flatMap((pending) => [...pending]),
        ]);
        const driverResults = await Promise.allSettled(
          registered.map(async (driver) => driver.close?.()),
        );
        for (const watcher of turnWatchers) watcher.disconnected();
        watching.clear();
        turnWatchers.clear();
        rosterWatchers.clear();
        const failures = [...results, ...driverResults].flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length) throw new AggregateError(failures, "Harness runtime teardown failed.");
      })());
    },
  } satisfies Runtime & { harnessOptions(): Promise<HarnessOption[]> };

  // A server exit may have left a claimed item behind. Recover its existing outcome or
  // report an interruption. Only unclaimed work can ever be dispatched from the queue.
  for (const bot of store.managedBots.listManagedBots().filter(({ id }) => getBot(id))) {
    for (const item of store.queue.list(bot.id).filter(({ status }) => status === "running")) {
      const row = queueAdmission(item.requestId);
      if (!row?.runId) {
        store.queue.markRunningInterrupted(bot.id);
        continue;
      }
      const outcome = store.events.runOutcome(bot.id, row.runId);
      if (outcome === "completed") store.queue.complete(bot.id, item.id);
      else {
        if (!outcome) recordOutcome(bot, row.runId, "interrupted");
        store.queue.markRunningInterrupted(bot.id);
      }
    }
    queueMicrotask(() => drain(bot.id));
  }

  return runtime;
}

export type HarnessRuntime = ReturnType<typeof createHarnessRuntime>;
