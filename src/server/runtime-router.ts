import type { AutomationRequester } from "../shared/automation.js";
import { Conflict } from "../shared/errors.js";
import type { ExperienceRequester } from "../shared/experience.js";
import type { Runtime } from "../shared/types.js";

/** The runtime ID Hermes is registered under. Its event cursor is the one stored before cursors were kept per runtime. */
export const hermesRuntimeId = "hermes";

export interface RuntimeRoutes {
  /** Every runtime, by an ID that stays the same across releases: it keys the runtime's event cursor. */
  runtimes: Record<string, Runtime>;
  /** Serves calls that name no assistant, creates new assistants, and runs every assistant `runtimeOf` leaves unnamed. */
  defaultRuntime: string;
  /** The ID of the runtime an assistant runs on. Undefined, or absent, means the default runtime. */
  runtimeOf?: (botId: string) => string | undefined;
}

// Optional members a router offers only while a registered runtime has them, so `if (!runtime.x)` checks
// at call sites keep working. With one runtime, the router has exactly that runtime's members.
const optional = [
  "setRoutineEnabled",
  "stopRoutineRun",
  "routineResults",
  "routineOutput",
  "groupRequest",
  "transcribeVoice",
  "synthesizeVoice",
  "automationRequest",
  "experienceRequest",
  "vaultRequest",
  "computerRequest",
  "connectComputerDisplay",
  "inferenceSettings",
  "modelOptions",
  "integrationRequest",
  "connectionRequest",
  "reconnect",
  "canonicalSubmit",
  "botDetail",
  "watchRoster",
  "setAvatar",
  "setVoice",
  "realtimeSession",
  "watch",
  "inflight",
  "turn",
  "followTurns",
  "watchTurns",
  "fileBotId",
  "delegationPolicy",
  "routineDeliveries",
] as const satisfies readonly (keyof Runtime)[];
type Optional = (typeof optional)[number];
// A new optional member of Runtime fails to compile here until it is listed above.
type OptionalOf<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];
// eventSources is the router's own: it always has one, whatever its runtimes have.
const everyOptionalListed: [Exclude<OptionalOf<Runtime>, Optional | "eventSources">] extends [never]
  ? true
  : never = true;
void everyOptionalListed;

/**
 * One `Runtime` over several, chosen per assistant. A call that names an assistant goes to the runtime that assistant
 * runs on. A call that names none goes to the default runtime, or to every runtime where the answer is a union:
 * the roster, routines, roster and turn watchers, a file's assistant, a receipt lookup without an assistant,
 * reconnecting and closing. Each runtime's events are read with its own cursor (`eventSources`).
 *
 * The roster and the routine inventory are all or nothing: one runtime's failure fails the whole answer, as a lone
 * runtime's failure does, because callers reconcile, prune and decide privacy by what an answer leaves out. Keeping
 * the other runtimes' assistants listed through one runtime's outage is step 2 work in docs/RuntimePlan.md.
 *
 * An assistant whose runtime lacks an optional member another runtime has gets a 409 for it, nothing from a
 * synchronous read, and a watcher that never fires.
 */
export function createRuntimeRouter(routes: RuntimeRoutes): Runtime {
  const ids = Object.keys(routes.runtimes);
  const all = Object.values(routes.runtimes);
  const fallback = routes.runtimes[routes.defaultRuntime];
  if (!fallback) throw new Error(`The default runtime ${routes.defaultRuntime} is not registered.`);
  const byId = (id: string) => {
    const runtime = routes.runtimes[id];
    if (!runtime) throw new Error(`No runtime is registered as ${id}.`);
    return runtime;
  };
  const runtimeIdOf = (botId: string) => routes.runtimeOf?.(botId) ?? routes.defaultRuntime;
  const on = (botId: string | undefined) =>
    botId === undefined ? fallback : byId(runtimeIdOf(botId));
  const unsupported = () => new Conflict("This assistant's runtime doesn't support this yet.");
  // The member on the assistant's runtime, or a refusal when only another runtime has it.
  const member = <K extends Optional>(
    botId: string | undefined,
    key: K,
  ): NonNullable<Runtime[K]> => {
    const runtime = on(botId);
    const found = runtime[key];
    if (found === undefined) throw unsupported();
    return (typeof found === "function" ? found.bind(runtime) : found) as NonNullable<Runtime[K]>;
  };
  // Every stop is tried, even after one throws; the first failure is reported.
  const stopEach = (stops: ((() => void) | undefined)[]) => {
    let failure: { error: unknown } | undefined;
    for (const stop of stops)
      try {
        stop?.();
      } catch (error) {
        failure ??= { error };
      }
    if (failure) throw failure.error;
  };
  // A runtime that refuses its watcher undoes the ones already registered, so the caller, who gets no stop, leaks none.
  const subscribe = (each: (runtime: Runtime) => (() => void) | undefined) => {
    const stops: ((() => void) | undefined)[] = [];
    try {
      for (const runtime of all) stops.push(each(runtime));
    } catch (error) {
      try {
        stopEach(stops);
      } catch {
        /* The registration failure is the one to report. */
      }
      throw error;
    }
    return () => stopEach(stops);
  };
  // Each runtime lists only the assistants that run on it, so no assistant appears twice or from the wrong runtime.
  const mine = <T>(id: string, rows: T[], botIdOf: (row: T) => string) =>
    rows.filter((row) => runtimeIdOf(botIdOf(row)) === id);
  // All or nothing: callers reconcile and prune on this inventory, so one runtime's outage fails the whole answer.
  const fanOut = async <T>(read: (runtime: Runtime) => Promise<T[]>, botIdOf: (row: T) => string) =>
    (await Promise.all(ids.map(async (id) => mine(id, await read(byId(id)), botIdOf)))).flat();

  // Required, so a member added to Runtime fails to compile until the router dispatches it.
  const router: Required<Runtime> = {
    setRoutineEnabled: async (...args) => member(args[0], "setRoutineEnabled")(...args),
    stopRoutineRun: async (...args) => member(args[0], "stopRoutineRun")(...args),
    routineResults: async (...args) => member(args[0], "routineResults")(...args),
    routineOutput: async (...args) => member(args[0], "routineOutput")(...args),
    // Group chats are hosted by the default runtime; a room's members may run anywhere.
    groupRequest: async (input) => member(undefined, "groupRequest")(input),
    transcribeVoice: async (...args) => member(args[0], "transcribeVoice")(...args),
    synthesizeVoice: async (...args) => member(args[0], "synthesizeVoice")(...args),
    automationRequest: (async (input) =>
      member(input.profile, "automationRequest")(input)) as AutomationRequester,
    experienceRequest: (async (input) =>
      member(input.profile, "experienceRequest")(input)) as ExperienceRequester,
    vaultRequest: async (input) => member(input.profile, "vaultRequest")(input),
    // The shared computer belongs to the default runtime. A hand-off or terminal answer goes to its assistant's.
    computerRequest: async (input) =>
      member("profile" in input ? input.profile : undefined, "computerRequest")(input),
    connectComputerDisplay: (attachment) => member(undefined, "connectComputerDisplay")(attachment),
    inferenceSettings: async (...args) => member(args[0], "inferenceSettings")(...args),
    modelOptions: async (...args) => member(args[0], "modelOptions")(...args),
    integrationRequest: async (input) => member(input.profile, "integrationRequest")(input),
    connectionRequest: async (input) => member(input.profile, "connectionRequest")(input),
    // The connection clients see is the default runtime's.
    status: async () => fallback.status(),
    reconnect: async () => {
      const [status] = await Promise.all([
        fallback.reconnect ? fallback.reconnect() : fallback.status(),
        ...all.filter((runtime) => runtime !== fallback).map((runtime) => runtime.reconnect?.()),
      ]);
      return status;
    },
    capabilities: async (...args) => on(args[0]).capabilities(...args),
    canonicalSubmit: async (...args) => (await on(args[0]).canonicalSubmit?.(...args)) === true,
    listBots: async () =>
      fanOut(
        (runtime) => runtime.listBots(),
        (bot) => bot.id,
      ),
    botDetail: async (botId) => member(botId, "botDetail")(botId),
    watchRoster: (changed) => subscribe((runtime) => runtime.watchRoster?.(changed)),
    // A new assistant is created on the default runtime.
    saveBot: async (...args) => on(args[1]).saveBot(...args),
    deleteBot: async (id) => on(id).deleteBot(id),
    stop: async (...args) => on(args[0]).stop(...args),
    generatePortrait: async (...args) => on(args[0]).generatePortrait(...args),
    setAvatar: async (...args) => member(args[0], "setAvatar")(...args),
    setVoice: async (...args) => member(args[0], "setVoice")(...args),
    realtimeSession: async (input) => member(undefined, "realtimeSession")(input),
    conversation: async (...args) => on(args[0]).conversation(...args),
    watch: (...args) => on(args[0]).watch?.(...args) ?? (() => {}),
    inflight: (botId) => on(botId).inflight?.(botId),
    turn: (botId) => on(botId).turn?.(botId),
    followTurns: (...args) => on(args[0]).followTurns?.(...args) ?? (() => {}),
    watchTurns: (watcher) => subscribe((runtime) => runtime.watchTurns?.(watcher)),
    submit: async (input) => on(input.botId).submit(input),
    // A lookup without its assistant asks every runtime: the first receipt wins, and a failure counts only if none has one.
    lookupSubmission: async (...args) => {
      const [requestId, botId] = args;
      if (botId !== undefined || all.length === 1) return on(botId).lookupSubmission(...args);
      let failure: unknown;
      for (const runtime of all) {
        try {
          const receipt = await runtime.lookupSubmission(requestId);
          if (receipt) return receipt;
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== undefined) throw failure;
      return null;
    },
    steer: async (input) => on(input.botId).steer(input),
    answerRequest: async (...args) => on(args[0]).answerRequest(...args),
    approve: async (...args) => on(args[0]).approve(...args),
    upload: async (...args) => on(args[0]).upload(...args),
    // A file ID's signature names its assistant, so a caller that hasn't checked it still reaches the right runtime.
    // An ID no runtime signed goes to the default, which refuses it.
    download: async (...args) => on(args[2] ?? router.fileBotId?.(args[0])).download(...args),
    fileBotId: (id) => {
      for (const runtime of all) {
        const botId = runtime.fileBotId?.(id);
        if (botId !== undefined) return botId;
      }
      return undefined;
    },
    tools: async (botId) => on(botId).tools(botId),
    setTools: async (...args) => on(args[0]).setTools(...args),
    skills: async (botId) => on(botId).skills(botId),
    setSkills: async (...args) => on(args[0]).setSkills(...args),
    routines: async (...args) =>
      args[0] === undefined
        ? fanOut(
            (runtime) => runtime.routines(),
            (routine) => routine.botId,
          )
        : on(args[0]).routines(...args),
    saveRoutine: async (...args) => on(args[0].botId).saveRoutine(...args),
    deleteRoutine: async (...args) => on(args[1]).deleteRoutine(...args),
    // A runtime without durable events has nothing to resume from, so its discovery fails and holds up no other.
    discoverEvents: async (cursor, source) => {
      const runtime = byId(source ?? routes.defaultRuntime);
      const durable = (await runtime.capabilities()).durableEvents;
      if (!durable.supported) throw new Error(durable.reason ?? "Durable events are unavailable");
      return runtime.discoverEvents(cursor);
    },
    eventSources: () => ids,
    // The default runtime holds who each assistant may reach; hand-offs between runtimes go through the app.
    delegationPolicy: async (policies) => member(undefined, "delegationPolicy")(policies),
    routineDeliveries: async (botId) => member(botId, "routineDeliveries")(botId),
    close: async () => {
      await Promise.all(all.map((runtime) => runtime.close()));
    },
  };
  // Read on each access, so a runtime that gains or drops a member later is seen as it is now.
  for (const key of optional) {
    const dispatch = router[key];
    Object.defineProperty(router, key, {
      enumerable: true,
      get: () => (all.some((runtime) => runtime[key] !== undefined) ? dispatch : undefined),
    });
  }
  return router;
}
