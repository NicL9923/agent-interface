import { botIdFor, reasoningLevels, serviceTiers } from "../shared/types.js";
import type { ActivityState, Avatar, Bot, BotInput, Capabilities, Conversation, ConversationOptions, Inflight, Message, Routine, Runtime, RuntimeDiscovery, Skill, Submission, SubmissionReceipt, Tool, ToolCall } from '../shared/types.js';
import ClientWebSocket from 'ws';
import type { ComputerAttachment, ComputerStatus } from '../shared/computer.js';
import type { RoutineOutput, RoutineResult } from '../shared/collaboration.js';
import { withMessageOrigins, wireOrigin } from "../shared/message-origin.js";
import { formatBytes } from '../shared/uploads.js';
import { interruptionPendingMessage } from '../shared/errors.js';
import { httpError } from './http-error.js';
import { createHermesTransport, TransportError, type Connection, type HermesOptions, type Wire } from './hermes-transport.js';
import { fileSigner, safeStagedPath, type RegisteredFile } from './hermes-files.js';
import { applyFrame, bot, emptyLiveState, exposedText, historyMessages, inflightMessage, openRequests, receipt, toolDetails, unbridged, type LiveState } from './hermes-mapping.js';

export type { HermesOptions } from './hermes-transport.js';

const keys = ['chat', 'steering', 'approvals', 'uploads', 'generatedFiles', 'botConfiguration', 'tools', 'skills', 'routines', 'durableEvents', 'idempotency', 'imageGeneration', 'stop', 'portraitGeneration', 'avatarMetadata'] as const;
const supported = (value: boolean, reason?: string) => ({supported: value,
  ...(!value ? {reason: reason ?? 'The connected Hermes backend does not expose this capability.'} : {})});
// Frames that only extend a running turn. Anything else changes the conversation's structure.
const deltaEvents = ['message.delta', 'reasoning.delta', 'thinking.delta', 'tool.generating', 'status.update', 'tool.start'];
const settledStates = ['done', 'failed', 'interrupted'];
// Every viewer of an assistant shares one read until Hermes reports a change there, for a few seconds at most.
const SHARED_READ_MS = 3_000;
// Lazy detail reads share expensive profile files for ten seconds. This app's
// profile edits invalidate them, and settings catalog reads ask for fresh detail.
const DESCRIPTION_MS = 10_000;

export function createHermesRuntime(options: HermesOptions = {}): Runtime {
  let discoveryFull = false;
  let discoveryGeneration = 0;
  let botCache: Bot[] = [];
  const live = new Map<string, string>();
  const owners = new Map<string, string>();
  // Assistants with an open in flight, counted, for frames that arrive before its session is known.
  const opening = new Map<string, number>();
  const transient = new Map<string, LiveState>();
  const rosterWatchers = new Set<() => void>();
  const rosterChanged = () => {
    rosterRequest = undefined;
    for (const listener of rosterWatchers) {
      try { listener(); } catch { /* Isolate listeners. */ }
    }
  };
  const watchers = new Map<string, Set<(kind?: "inflight") => void>>();
  const structuralGenerations = new Map<string, number>();
  const structuralGenerationOf = (botId: string) => `${changeEpoch}:${structuralGenerations.get(botId) ?? 0}`;
  const structurallyChanged = (botId: string) => { structuralGenerations.set(botId, (structuralGenerations.get(botId) ?? 0) + 1); };
  const snapshots = new Map<string, {value: Wire; rows: Message[]; activity: Conversation["activity"]}>();
  let capabilityCache: Capabilities | undefined;
  let changeEpoch = 0;
  const changeGenerations = new Map<string, number>();
  const sharedReads = new Map<string, {generation: string; at: number; value: Promise<Conversation>}>();
  const generationOf = (botId: string) => `${changeEpoch}:${changeGenerations.get(botId) ?? 0}`;
  const settling = new Set<string>();
  function settleSoon(botId: string): void {
    if (settling.has(botId)) return;
    settling.add(botId);
    setTimeout(() => { settling.delete(botId); changed(botId); }, 1_000).unref?.();
  }
  // This app's own writes change a conversation before Hermes reports it.
  const touched = (botId: string) => { changeGenerations.set(botId, (changeGenerations.get(botId) ?? 0) + 1); };
  const descriptions = new Map<string, {at: number; edit: number; fresh: boolean; pending: boolean; value: Promise<Wire>}>();
  const descriptionEdits = new Map<string, number>();
  let capabilityRequest: Promise<Capabilities> | undefined;
  let rosterRequest: Promise<Bot[]> | undefined;
  const serviceAuth = options.authMode === 'service';
  // Without a bot, every watched conversation may have changed, as when the connection drops or returns.
  function changed(botId?: string, kind?: "inflight"): void {
    if (!kind) {
      rosterChanged();
      if (botId) structurallyChanged(botId);
    }
    if (botId === undefined) changeEpoch++;
    else touched(botId);
    for (const [watched, listeners] of watchers) {
      if (botId !== undefined && watched !== botId) continue;
      for (const listener of listeners) {
        try { listener(kind); } catch { /* A watcher never stops frame processing. */ }
      }
    }
  }
  const transport = createHermesTransport(options, {
    frame: sessionFrame,
    disconnected(verified) {
      live.clear();
      descriptions.clear();
      capabilityCache = undefined;
      // A disconnected stream cannot identify which turn is now active. Fresh
      // native snapshots restore current activity, reasoning and tools.
      transient.clear();
      snapshots.clear();
      if (verified) changed();
    },
    connected: () => changed(),
    watching: () => watchers.size > 0 || rosterWatchers.size > 0,
  });
  const {contract, connect, rpc, http} = transport;
  const {signFile, fileValue, artifacts} = fileSigner(options.token);
  const toBot = (row: Wire, detail?: Wire) => bot(row, transient.get(live.get(row.name) ?? '')?.state ?? 'idle', detail);

  function sessionFrame(frame: Wire, current: Connection): void {
    const params = frame.params ?? {};
    const sid = params.session_id;
    // Native display-lineage changes include other clients and sessions this socket
    // has never opened. Refresh the cheap roster without refetching every open chat.
    if (!sid && frame.method === 'event' && params.type === 'sessions.changed') rosterChanged();
    if (!sid) return;
    const state = transient.get(sid) ?? emptyLiveState();
    const previousActivity = state.state;
    transient.set(sid, state);
    if (!applyFrame(state, frame, transport.serial)) transport.refuse(current, frame.id);
    // Opening a conversation attaches this socket to its session, so its frames arrive here.
    const botId = owners.get(sid);
    const delta = frame.method === "event" && deltaEvents.includes(params.type);
    if (botId !== undefined) {
      if (delta && state.state !== previousActivity) rosterChanged();
      if (!delta) snapshots.delete(botId);
      if (delta && params.type === 'tool.start') structurallyChanged(botId);
      changed(botId, delta ? "inflight" : undefined);
    }
    // Hermes attaches the socket before it answers a first open, so early frames name no assistant yet.
    else for (const pending of opening.keys()) changed(pending, delta && params.type !== 'tool.start' ? "inflight" : undefined);
  }
  async function voiceReply(path: string, payload: Wire): Promise<Wire> {
    const response = await http(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
    if (!response.body) throw new Error('Hermes returned no voice response.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 12 * 1024 * 1024) { await reader.cancel(); throw new Error('Hermes returned oversized voice data.'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Wire;
    if (value.ok !== true) throw httpError(409, 'Hermes voice is unavailable. Check the speech provider in the native dashboard.');
    return value;
  }
  // Most callers need only the session, its run state and open requests, so they skip the history read.
  async function open(botId: string, read: {history?: boolean; window?: ConversationOptions['window']} = {history: false}): Promise<Wire> {
    await connect();
    if (!contract.extension) throw new Error('The verified durable Hermes add-on is required before opening a conversation.');
    opening.set(botId, (opening.get(botId) ?? 0) + 1);
    let value: Wire;
    try {
      value = await rpc('agent-interface.open', {profile: botId,
        ...(read.history === false ? {omit_messages: true} : read.window ? {window: read.window} : {})});
    } finally {
      const count = (opening.get(botId) ?? 1) - 1;
      if (count) opening.set(botId, count);
      else opening.delete(botId);
    }
    live.set(botId, value.session_id);
    owners.set(value.session_id, botId);
    if (!transient.has(value.session_id)) {
      transient.set(value.session_id, {text: value.inflight?.assistant ?? '', reasoning: value.inflight?.reasoning ?? '',
        state: value.info?.running ? 'thinking' : 'idle', requests: [], tools: []});
    }
    const state = transient.get(value.session_id);
    if (state) {
      state.requests = Array.isArray(value.open_requests) ? value.open_requests : [];
      if (state.state === 'disconnected') {
        state.state = value.app_interruption ? 'interrupted' : value.info?.running ? 'thinking' : 'idle';
        state.text = '';
        state.tools = [];
      } else if (!state.requests.length && ['waiting', 'blocked'].includes(state.state)) {
        state.state = value.info?.running ? 'thinking' : 'idle';
      }
    }
    return value;
  }
  // fresh reads Hermes again, as settings and this app's own edits need. Fresh reads share only
  // with reads started after this app's last edit to the profile, never with one from before it.
  function describe(name: string, fresh = false): Promise<Wire> {
    const now = Date.now(), cached = descriptions.get(name), edit = descriptionEdits.get(name) ?? 0;
    if (!fresh && cached && now - cached.at < DESCRIPTION_MS) return cached.value;
    if (fresh && cached && cached.edit === edit && cached.fresh && cached.pending) return cached.value;
    const entry = {at: now, edit, fresh, pending: true, value: rpc('profiles.describe', {name}, false)};
    descriptions.set(name, entry);
    entry.value.then(() => { entry.pending = false; }, () => {
      entry.pending = false;
      if (descriptions.get(name) === entry) descriptions.delete(name);
    });
    return entry.value;
  }
  function edited(name: string): void {
    rosterRequest = undefined;
    descriptions.delete(name);
    descriptionEdits.set(name, (descriptionEdits.get(name) ?? 0) + 1);
  }
  async function submit(input: Submission, steer = false): Promise<SubmissionReceipt> {
    let attachments: RegisteredFile[];
    try {
      attachments = input.attachments.map(file => fileValue(file.id));
      if (attachments.some(file => file.botId !== input.botId))
        throw new Error('Attachment belongs to a different Hermes bot.');
    } catch (error) {
      // Validation has not contacted native admission. The caller can edit this draft.
      return { requestId: input.requestId, status: 'rejected', message:
        `${error instanceof Error ? error.message : 'Invalid attachment.'} Remove it and attach the file again. Your draft is saved.` };
    }
    await connect();
    if (!contract.extension) throw new Error('Durable Hermes admission add-on is required before sending.');
    const fast = contract.canonicalSubmit, state = fast ? undefined : await open(input.botId);
    if ((steer || state?.info?.running) && attachments.some(x => x.mime.startsWith('image/')))
      return {requestId: input.requestId, status: 'rejected', message: 'Images cannot be added while Hermes is working. Keep this draft and send it after the task settles.'};
    const references = attachments.filter(x => !x.mime.startsWith('image/')).map(x => `@file:${JSON.stringify(x.path)}`).join('\n');
    try {
      const value = await rpc('agent-interface.submit', {profile: input.botId, ...(state ? {session_id: state.session_id} : {}),
        request_id: input.requestId, sender_id: input.senderId, text: input.text + (references ? '\n' + references : ''),
        attachments, steer, reviewed_interruption: input.reviewedInterruption === true});
      // A misadvertised older add-on must not be retried after possible admission.
      // Fall back to its old read checks for future sends, and recover participation now.
      if (fast && value.admission !== 'canonical') {
        contract.canonicalSubmit = false;
        const prior = await open(input.botId).catch(() => undefined);
        return {...receipt(value), runId: value.runId ?? prior?.app_run_id};
      }
      return receipt(value);
    } catch (error) {
      if (error instanceof TransportError && error.rpcCode === 4094) throw httpError(409, interruptionPendingMessage, {code: 'interruption_pending'});
      return {requestId: input.requestId, status: 'uncertain', message: error instanceof Error ? error.message : 'Hermes response lost. Review before retrying.'};
    }
  }
  async function checkRequest(botId: string, id: string, method: string): Promise<void> {
    const state = transient.get(live.get(botId) ?? '');
    const requests = state?.requests ?? (await open(botId)).open_requests ?? [];
    if (!requests.some((request: Wire) => String(request.id) === id && request.method === method))
      throw new Error(method === 'approval' ? 'That approval is stale or already resolved.' : 'That question is stale or already resolved.');
  }
  async function routineMutation(input: Omit<Routine, 'id'>, id?: string): Promise<Routine> {
    const profile = `?profile=${encodeURIComponent(input.botId)}`;
    const body = {
      name: `[bot:${input.botId}] ${input.name}`, prompt: input.prompt,
      schedule: input.schedule, deliver: `bot-chat:${input.botId}`, context_from: ['self'],
    };
    const path = `/api/cron/jobs${id ? `/${encodeURIComponent(id)}` : ''}`;
    let job = await (await http(path + profile, {
      method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(id ? { updates: body } : { ...body, paused: !input.enabled }),
    })).json() as Wire;
    if (job.error || job.success === false) throw new Error('Hermes refused the routine. Reload before retrying.');
    job = job.job ?? job;
    const jobId = job.id ?? job.job_id ?? id;
    if (!jobId) throw new Error('Hermes did not return a routine ID.');
    const isEnabled = (value: Wire) => value.enabled !== false && value.state !== 'paused';
    if (isEnabled(job) !== input.enabled) {
      // Hermes pause/resume maintains enabled, state, timestamps and next-run time together.
      job = await (await http(`/api/cron/jobs/${encodeURIComponent(jobId)}/${input.enabled ? 'resume' : 'pause'}${profile}`, { method: 'POST' })).json() as Wire;
    }
    if (isEnabled(job) !== input.enabled) throw new Error('Hermes did not apply the routine state. Reload before retrying.');
    discoveryFull = true;
    discoveryGeneration++;
    return { ...input, id: jobId, enabled: isEnabled(job) };
  }
  async function readConversation(botId: string, options: ConversationOptions): Promise<Conversation> {
    await connect();
    const generation = structuralGenerationOf(botId);
    const value = await open(botId, options.history === false ? {history: false} : {window: options.window});
    const sid = value.session_id;
    const history = value.messages ?? (await rpc('session.history', {session_id: sid, profile: botId})).messages;
    const rows = historyMessages(sid, history, row => artifacts(botId, row));
    const state = transient.get(sid), inflight = value.inflight ?? {}, active = !!value.info?.running || !!value.app_run_id;
    // Seed a socket attached mid-turn, without replacing text that already advanced during the read.
    if (active && state && typeof inflight.assistant === 'string' &&
        (!state.text || inflight.assistant.startsWith(state.text) || inflight.assistant.endsWith(state.text)))
      state.text = inflight.assistant;
    if (active && state && typeof inflight.reasoning === 'string' &&
        (!state.reasoning || inflight.reasoning.startsWith(state.reasoning) || inflight.reasoning.endsWith(state.reasoning)))
      state.reasoning = inflight.reasoning;
    const tail = inflightMessage(value, rows, state);
    if (tail.text || tail.reasoning) rows.push(tail);
    if (!active && state) {
      state.text = '';
      state.reasoning = '';
      state.tools = [];
    }
    if (active && state && settledStates.includes(state.state)) settleSoon(botId);
    const {approvals, attention} = openRequests(value, sid);
    const toolCalls: ToolCall[] = Array.isArray(value.app_tool_calls) ? value.app_tool_calls.map(unbridged) : state?.tools ?? [];
    if (active && state && generation === structuralGenerationOf(botId)) state.tools = toolCalls;
    const runningTool = toolCalls.find(tool => tool.status === 'running');
    const activity: ActivityState = value.app_interruption ? 'interrupted'
      : approvals.length ? 'waiting'
      : active ? (runningTool || state?.state === 'working' && value.app_tool_calls === undefined ? 'working' : 'thinking')
      : inflight.error ? 'failed'
      : inflight.interrupted ? 'interrupted'
      : settledStates.includes(value.app_task_state) ? value.app_task_state
      : state && settledStates.includes(state.state) ? state.state
      : 'idle';
    const detail = active ? (runningTool ? `Using ${runningTool.name}` : state?.detail) : undefined;
    const runId = value.app_run_id ?? value.app_interruption?.runId ?? undefined;
    // Live patches need only the last prompt and its persisted assistant segments,
    // never a second retained copy of an older client's full transcript.
    if (options.history !== false && generation === structuralGenerationOf(botId)) {
      snapshots.set(botId, {
        value: {session_id: sid, info: {running: value.info?.running}, app_run_id: value.app_run_id,
          inflight: {user: inflight.user, display_kind: inflight.display_kind, display_metadata: inflight.display_metadata}},
        rows: rows.slice(Math.max(0, rows.findLastIndex(row => row.role === 'user')))
          .filter(row => row.id !== `${sid}-inflight` && (row.role === 'user' || row.role === 'assistant')),
        activity: {state: attention.length ? 'blocked' : activity, detail, runId},
      });
    }
    // Hermes returns a window's earlier rows first: those the app needs for files and origins.
    const cut = value.app_window && Number.isInteger(value.app_window.earlier) && Number.isInteger(value.app_window.context)
      ? value.app_window as {earlier: number; context: number}
      : undefined;
    const shown = withMessageOrigins(rows);
    return {
      botId,
      sessionId: value.canonical_stored_session_id ?? value.stored_session_id ?? value.info?.stored_session_id ?? sid,
      messages: cut ? shown.slice(cut.context) : shown,
      ...(cut ? {window: {earlier: cut.earlier, context: shown.slice(0, cut.context)}} : {}),
      activity: {state: value.app_interruption ? 'interrupted' : attention.length ? 'blocked' : activity, detail, runId},
      toolCalls: active ? toolCalls : [],
      approvals,
      attention,
      files: rows.flatMap(x => x.files ?? []),
    };
  }
  return {
    async routineResults(botId, routineId) {
      return await this.experienceRequest!({ operation: 'routine_results', profile: botId, routineId }) as RoutineResult[];
    },
    async routineOutput(botId, routineId, resultId) {
      return await this.experienceRequest!({ operation: 'routine_output', profile: botId, routineId, resultId }) as RoutineOutput;
    },
    async groupRequest(input) {
      if (input.operation === 'list') {
        let capability: Wire;
        try { capability = await rpc('groups.capabilities', {}); }
        catch (error) {
          if (error instanceof TransportError && error.rpcCode === -32601) return { supported: false, canSend: false, rooms: [], reason: 'This Hermes version does not expose hosted group chats.' };
          throw error;
        }
        if (capability.protocol_version !== 2 || !['groups.list', 'groups.state', 'groups.log'].every(method => capability.methods?.includes(method)))
          return { supported: false, canSend: false, rooms: [], reason: 'This Hermes group protocol is not supported by this app.' };
        const rooms: Wire[] = [];
        let offset = 0;
        for (let page = 0; page < 10; page++) {
          const value = await rpc('groups.list', { limit: 100, offset });
          rooms.push(...value.rooms);
          if (value.next_offset == null) break;
          offset = value.next_offset;
        }
        const canSend = capability.driver === true && ['groups.create', 'groups.send', 'groups.stop', 'groups.approve'].every(method => capability.methods?.includes(method));
        return { supported: true, canSend, rooms, ...(!canSend ? { reason: 'Hermes group history is available. Its group coordinator must be running to create rooms or send messages.' } : {}) };
      }
      const room_id = input.roomId;
      if (input.operation === 'state') return rpc('groups.state', { room_id });
      if (input.operation === 'log') return rpc('groups.log', { room_id, since_seq: input.since, limit: 200 });
      const catalog = await rpc('groups.capabilities', {});
      if (catalog.protocol_version !== 2 || catalog.driver !== true) throw httpError(409, 'The Hermes group coordinator is unavailable. Refresh before trying again.');
      if (input.operation === 'create') return rpc('groups.create', { room_id, name: input.name, members: input.members });
      if (input.operation === 'send') return rpc('groups.send', { room_id, event_id: input.requestId, payload: { text: input.text, thread_id: input.threadId } });
      if (input.operation === 'stop') return rpc('groups.stop', { room_id, cancel_id: input.requestId });
      return rpc('groups.approve', { room_id, member_id: input.memberId, task_id: input.taskId, execution_generation: input.generation, choice: input.choice, request_id: input.requestId });
    },
    async inferenceSettings(botId, update) {
      const session = await open(botId);
      const scope = { profile: botId, session_id: session.session_id };
      for (const [key, value] of Object.entries(update || {})) {
        await rpc('config.set', { ...scope, key: key === 'speed' ? 'fast' : 'reasoning', value });
      }
      const [reasoning, speed] = await Promise.all([
        rpc('config.get', { ...scope, key: 'reasoning' }), rpc('config.get', { ...scope, key: 'fast' }),
      ]);
      if (!reasoningLevels.includes(reasoning.value) || !serviceTiers.includes(speed.value))
        throw new Error('Hermes returned unreadable inference settings.');
      return { reasoning: reasoning.value, speed: speed.value };
    },
    async modelOptions(profile) {
      // Use Hermes's account-aware catalog, including custom provider aliases.
      // This native RPC already runs under authenticated profile scope.
      const result = await rpc('model.options', { ...(profile ? {profile} : {}), explicit_only: true });
      if (!Array.isArray(result.providers)) throw new Error('Hermes returned an unreadable model catalog.');
      return {
        provider: typeof result.provider === 'string' ? result.provider : '',
        model: typeof result.model === 'string' ? result.model : '',
        providers: result.providers.flatMap((row: Wire) => {
          if (typeof row.slug !== 'string' || !row.slug || !Array.isArray(row.models)) return [];
          const unavailable = new Set(Array.isArray(row.unavailable_models) ? row.unavailable_models : []);
          return [{ id: row.slug, name: typeof row.name === 'string' ? row.name : row.slug,
            aliases: Array.isArray(row.aliases) ? row.aliases.filter((value: unknown) => typeof value === 'string') : [],
            authenticated: row.authenticated !== false,
            ...(typeof row.warning === 'string' ? { warning: row.warning } : {}),
            models: [...new Set(row.models.filter((value: unknown): value is string => typeof value === 'string' && value.length > 0))]
              .map(model => ({id: model as string, name: model as string, available: row.authenticated !== false && !unavailable.has(model)})),
          }];
        }),
      };
    },
    status: transport.status,
    reconnect: transport.reconnect,
    async capabilities() {
      if (capabilityRequest) return capabilityRequest;
      const request = (async () => {
        let connected = false;
        try { await connect(); connected = true; } catch { /* Diagnostic supplies the reason. */ }
        if (connected && capabilityCache) return capabilityCache;
        const current = transport.connection;
        const result = Object.fromEntries(keys.map(key => [key, supported(connected && contract.extension, transport.detail ?? 'Hermes is disconnected.')])) as Capabilities;
        result.idempotency = supported(connected && contract.extension, 'The verified durable admission add-on is required.');
        result.chat = result.idempotency;
        result.steering = result.idempotency;
        result.durableEvents = supported(connected && contract.extension, 'The durable lifecycle journal add-on is required.');
        let image = false;
        if (connected) try { image = (await rpc('image.generate', {probe: true})).available === true; } catch { /* A failed probe never enables generation. */ }
        const usable = connected && transport.connection === current && current?.verified === true &&
          current.ws.readyState === WebSocket.OPEN && contract.extension;
        if (!usable) {
          for (const key of keys) result[key] = supported(false, transport.detail ?? 'Hermes is disconnected.');
        } else {
          result.imageGeneration = result.portraitGeneration = supported(image, 'A verified Hermes add-on and a usable image-generation provider are required.');
          capabilityCache = result;
        }
        return result;
      })();
      capabilityRequest = request;
      try { return await request; } finally { if (capabilityRequest === request) capabilityRequest = undefined; }
    },
    async canonicalSubmit() {
      await connect();
      return contract.canonicalSubmit;
    },
    async listBots() {
      try { await connect(); } catch { return botCache.map(row => ({...row, activity: 'disconnected' as const})); }
      if (rosterRequest) return rosterRequest;
      let request!: Promise<Bot[]>;
      request = (async () => {
        try {
          const roster = await rpc('profiles.list', {include_sessions: true}, false);
          const names = new Set(roster.profiles.map((row: Wire) => row.name));
          for (const name of descriptions.keys()) if (!names.has(name)) descriptions.delete(name);
          const bots = roster.profiles.map((row: Wire) => toBot(row));
          if (rosterRequest === request) botCache = bots;
          return bots;
        } catch { return botCache.map(row => ({...row, activity: 'disconnected' as const})); }
      })();
      rosterRequest = request;
      try { return await request; } finally { if (rosterRequest === request) rosterRequest = undefined; }
    },
    watchRoster(listener) {
      rosterWatchers.add(listener);
      return () => { rosterWatchers.delete(listener); };
    },
    async botDetail(botId) {
      const roster = await rpc('profiles.list', {include_sessions: true});
      const row = roster.profiles.find((row: Wire) => row.name === botId);
      if (!row) throw new Error('Unknown Hermes bot.');
      return toBot(row, await describe(botId));
    },
    async saveBot(input: BotInput, id?: string) {
      await connect();
      const name = id ?? botIdFor(input.name);
      if (!name) throw new Error('Bot name needs letters or numbers.');
      let created = false;
      try {
        if (!id) {
          await rpc('profiles.create', {name, description: input.description, soul: input.instructions, mirror_credentials: true, no_alias: true});
          created = true;
        }
        const rosterBefore = await rpc('profiles.list', {include_sessions: false});
        const previous = rosterBefore.profiles.find((x: Wire) => x.name === name);
        const config: Wire = {
          name,
          soul: input.instructions,
          description: input.description ?? '',
          ui_meta: {
            'hermes-bots': {...previous?.ui_meta?.['hermes-bots'], title: input.name},
            agent_interface: {...previous?.ui_meta?.agent_interface, name: input.name, shared: input.shared},
          },
          ui_meta_expected_revisions: {
            'hermes-bots': previous?.ui_meta_revisions?.['hermes-bots'] ?? 0,
            agent_interface: previous?.ui_meta_revisions?.agent_interface ?? 0,
          },
        };
        if (input.model && input.model !== 'Inherited') {
          config.model = input.model;
          config.provider = input.provider ?? (await rpc('profiles.describe', {name})).model.provider;
          if (input.confirmModel) config.confirm_expensive_model = true;
        }
        if (input.enabledMcpServers) config.enabled_mcp_servers = input.enabledMcpServers;
        if (input.enabledSkills) {
          const all = await rpc('profiles.describe', {name});
          config.disabled_skills = all.skills.filter((x: Wire) => !input.enabledSkills!.includes(x.name)).map((x: Wire) => x.name);
        }
        const result = await rpc('profiles.configure', config);
        if (result.confirm_required) {
          throw httpError(409, typeof result.confirm_message === 'string' ? result.confirm_message.slice(0, 2000) : 'Hermes requires confirmation for this model.',
            {code: 'MODEL_CONFIRMATION_REQUIRED', confirmRequired: true});
        }
        if (!result.ok) {
          throw new Error('Hermes applied only some profile changes: ' +
            Object.entries(result.applied ?? {}).filter(([_, value]) => value === false).map(([key]) => key).join(', '));
        }
        if (input.enabledTools) await this.setTools(name, input.enabledTools);
        const roster = await rpc('profiles.list', {include_sessions: true});
        edited(name);
        return toBot(roster.profiles.find((x: Wire) => x.name === name), await describe(name, true));
      } catch (error) {
        edited(name);
        if (created) {
          try {
            await http(`/api/profiles/${encodeURIComponent(name)}`, {method: 'DELETE'});
            live.delete(name);
          } catch {
            throw Object.assign(new Error('Hermes created the bot but configuration failed and automatic cleanup was refused. Review bot ' + name + '.'),
              {createdBotId: name, cause: error});
          }
        }
        throw error;
      }
    },
    async deleteBot(id) {
      try {
        await http(`/api/profiles/${encodeURIComponent(id)}`, {method: 'DELETE'});
        live.delete(id);
      } finally { edited(id); }
    },
    async stop(botId) {
      const state = await open(botId);
      try { await rpc('session.interrupt', {session_id: state.session_id, profile: botId}); }
      finally { touched(botId); }
    },
    async generatePortrait(botId, prompt) {
      await open(botId);
      const result = await rpc('image.generate', {prompt, aspect_ratio: 'square', max_bytes: 2_000_000});
      if (!result.success || !result.image_data) {
        throw new Error(typeof result.error === 'string' && /no image generation backend configured/i.test(result.error)
          ? 'No image generation backend configured.'
          : 'Hermes image generation did not deliver image bytes. Review the provider settings before retrying.');
      }
      const [, mime, base64] = /^data:([^;]+);base64,(.*)$/.exec(result.image_data) ?? [];
      if (!mime || !base64) throw new Error('Hermes returned an invalid generated image.');
      return this.upload(botId, {name: 'generated-portrait.png', mime, data: Buffer.from(base64, 'base64')});
    },
    async setAvatar(botId, avatar: Avatar) {
      const roster = await rpc('profiles.list', {include_sessions: false});
      const row = roster.profiles.find((x: Wire) => x.name === botId);
      if (!row) throw new Error('Unknown Hermes bot.');
      let portraitData: string | undefined;
      if (avatar.mode === 'portrait') {
        if (!avatar.src.startsWith('/api/files/') || /[?#]/.test(avatar.src)) throw new Error('Choose an image uploaded or generated through this app.');
        const id = decodeURIComponent(avatar.src.slice('/api/files/'.length));
        const file = fileValue(id);
        if (file.botId !== botId) throw new Error('Portrait belongs to a different Hermes bot.');
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mime)) throw new Error('Hermes portraits support PNG, JPEG, and WebP.');
        const chunks: Uint8Array[] = [];
        try {
          for await (const chunk of (await this.download(id, 2_000_000)).body) chunks.push(chunk);
        } catch (error) {
          throw (error as {code?: string}).code === 'file_too_large' ? new Error('Hermes portraits must be 2 MB or smaller.') : error;
        }
        portraitData = `data:${file.mime};base64,${Buffer.concat(chunks).toString('base64')}`;
      }
      const meta = row.ui_meta?.agent_interface ?? {};
      const result = await rpc('profiles.configure', {name: botId, ui_meta: {agent_interface: {...meta, avatar}},
        ui_meta_expected_revisions: {agent_interface: row.ui_meta_revisions?.agent_interface ?? 0}});
      if (!result.ok || result.applied?.ui_meta === false || Object.keys(result.applied?.ui_meta_conflicts ?? {}).length)
        throw new Error('The Hermes avatar changed on another client. Reload before saving.');
      // Native assets do not support CAS. Never overwrite one after a rejected metadata revision.
      if (portraitData) {
        try {
          const stored = await rpc('profiles.set_asset', {name: botId, asset: 'avatar', data: portraitData});
          if (!stored.ok) throw new Error('Asset save refused.');
        } catch {
          throw new Error('The app portrait metadata was saved, but Hermes could not save its native portrait asset. Retry to finish saving.');
        }
      }
    },
    conversation(botId, options = {}) {
      // Write checks and activity summaries need current state, not history. Never shared.
      if (options.history === false) return readConversation(botId, options);
      const now = Date.now(), generation = generationOf(botId);
      for (const [key, entry] of sharedReads) if (now - entry.at >= SHARED_READ_MS) sharedReads.delete(key);
      const key = botId + '\0' + JSON.stringify(options.window ?? null);
      const hit = sharedReads.get(key);
      const copy = (value: Conversation) => ({...value});
      if (hit && hit.generation === generation) return hit.value.then(copy);
      const entry = {generation, at: now, value: readConversation(botId, options)};
      sharedReads.set(key, entry);
      entry.value.then(value => {
        // A running task can settle without a frame, so only settled state is kept for later readers.
        if (value.activity.runId || ['thinking', 'working', 'waiting', 'blocked'].includes(value.activity.state)) {
          if (sharedReads.get(key) === entry) sharedReads.delete(key);
          return;
        }
        // A reader polls next from its window's first message, which is this same read until something changes.
        const first = value.messages[0]?.id;
        if (first && options.window && generationOf(botId) === generation) sharedReads.set(botId + '\0' + JSON.stringify({start: first}), entry);
      }, () => { if (sharedReads.get(key) === entry) sharedReads.delete(key); });
      return entry.value.then(copy);
    },
    submit(input) {
      return submit(input).finally(() => touched(input.botId));
    },
    steer(input) {
      return submit(input, true).finally(() => touched(input.botId));
    },
    async lookupSubmission(requestId) {
      await connect();
      if (!contract.extension) return null;
      const result = await rpc('agent-interface.receipt', {request_id: requestId});
      return result.receipt ? receipt(result.receipt) : null;
    },
    // Routes verify profile and request kind with one light read. Native answers prove
    // final staleness, so do not repeat that read here.
    async approve(botId, approvalId, decision, _senderId) {
      await checkRequest(botId, approvalId, 'approval');
      const result = await rpc('request.answer', {id: approvalId, profile: botId, result: {choice: decision === 'approved' ? 'once' : 'deny'}})
        .finally(() => touched(botId));
      if (result.status === 'expired') throw new Error('That approval expired before it was answered.');
    },
    async answerRequest(botId, requestId, answers) {
      await checkRequest(botId, requestId, 'clarify');
      const result = await rpc('request.answer', {id: requestId, profile: botId, result: {answers}}).finally(() => touched(botId));
      if (result.status === 'expired') throw new Error('That question expired before it was answered.');
    },
    async upload(botId, input) {
      const state = await open(botId);
      const result = await rpc('file.attach', {session_id: state.session_id, profile: botId, name: input.name,
        data_url: `data:${input.mime};base64,${input.data.toString('base64')}`});
      const path = result.path;
      if (!safeStagedPath(path)) throw new Error('Hermes did not return a staged file path.');
      return {...signFile({path, name: input.name, mime: input.mime, botId, kind: 'upload', version: 1}), size: input.data.length};
    },
    fileBotId(id) {
      try { return fileValue(id).botId; } catch { return undefined; }
    },
    async download(id, maxBytes) {
      const file = fileValue(id);
      const response = await http(`/api/files/download?path=${encodeURIComponent(file.path)}`);
      const tooLarge = () => httpError(502, `${file.name} is larger than ${formatBytes(maxBytes)}, the most this app opens. Ask the assistant for a smaller file.`,
        {code: 'file_too_large', expose: true});
      // fetch decodes a compressed body, so the declared length counts encoded bytes.
      // Trust it only for an unencoded body; the cap always counts what is sent on.
      const encoding = response.headers.get('content-encoding');
      const declared = !encoding || encoding === 'identity' ? Number(response.headers.get('content-length') ?? NaN) : NaN;
      if (declared > maxBytes) { await response.body?.cancel(); throw tooLarge(); }
      if (!response.body) throw new Error('Hermes returned no file content.');
      let size = 0;
      // Cancelling the result, as when the person disconnects, cancels the Hermes read.
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > maxBytes) controller.error(tooLarge());
        else controller.enqueue(chunk);
      }}));
      return {name: file.name, mime: file.mime, ...(Number.isSafeInteger(declared) ? {size: declared} : {}), body};
    },
    async transcribeVoice(botId, input) {
      await open(botId);
      const value = await voiceReply(`/api/audio/transcribe?profile=${encodeURIComponent(botId)}`, { data_url: `data:${input.mime};base64,${input.data.toString('base64')}`, mime_type: input.mime });
      if (typeof value.transcript !== 'string' || value.transcript.length > 50000) throw new Error('Hermes returned an invalid transcript.');
      return { text: value.transcript, ...(typeof value.provider === 'string' ? { provider: value.provider.slice(0, 100) } : {}) };
    },
    async synthesizeVoice(botId, text) {
      await open(botId);
      const value = await voiceReply(`/api/audio/speak?profile=${encodeURIComponent(botId)}`, { text });
      const match = typeof value.data_url === 'string' && /^data:(audio\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value.data_url);
      if (!match || match[2].length > 12 * 1024 * 1024) throw new Error('Hermes returned invalid speech data.');
      const data = Buffer.from(match[2], 'base64');
      if (!data.length || data.length > 8 * 1024 * 1024) throw new Error('Hermes returned oversized speech audio.');
      return { data, mime: match[1], ...(typeof value.provider === 'string' ? { provider: value.provider.slice(0, 100) } : {}) };
    },
    async experienceRequest(input) {
      const value = await (await http('/api/agent-interface/experience', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).json();
      if (input.operation === 'run') {
        discoveryFull = true;
        discoveryGeneration++;
      }
      if (input.operation === 'history') {
        const seed = value.app_prior_prompt;
        const seedOrigin = seed ? wireOrigin({ id: 'prior', role: 'user', text: seed.text ?? '' }, seed) : undefined;
        value.messages = withMessageOrigins(value.messages.map((row: Wire) => {
          // Expose the app contract only. Raw native metadata can duplicate private message content.
          const message: Message & { app_sender_id?: string } = {
            id: String(row.id), role: row.role, text: exposedText(row.app_tool_result) ?? row.app_display_text ?? row.text ?? '',
            createdAt: row.createdAt, reasoning: row.reasoning, toolName: row.toolName, files: artifacts(input.profile, row),
            ...(typeof row.app_sender_id === 'string' ? {app_sender_id: row.app_sender_id} : {}),
            ...(row.role === 'tool' ? {toolCall: toolDetails({name: row.name, args: row.args, result: row.app_tool_result ?? row.text}, String(row.tool_call_id ?? row.id), 'completed')} : {}),
          };
          const origin = wireOrigin(message, row);
          return origin ? { ...message, origin } : message;
        }), seedOrigin?.kind === 'human' ? undefined : seedOrigin);
        delete value.app_prior_prompt;
      }
      return value;
    },
    async vaultRequest(input) {
      // An earlier add-on has no address-only logins and refuses the member field; it fails closed for them.
      const {actor: _actor, ...legacy} = input as Extract<typeof input, {operation: 'answer'}>;
      const payload = input.operation === 'answer' && !contract.explicitCredentials ? legacy : input;
      const response = await http('/api/agent-interface/credentials', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)})
        .finally(() => { if (input.operation === 'answer') touched(input.profile); });
      if (!response.body) throw new Error('Hermes returned no credential status.');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > 1024 * 1024) throw new Error('Hermes returned an invalid credential status.');
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    },
    // Connections can change a profile's MCP servers; a later save must not resend the old list.
    async integrationRequest(input) {
      try {
        return await (await http('/api/agent-interface/integrations', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input)})).json();
      } finally {
        if (!['list', 'check'].includes(input.operation)) edited(input.profile);
      }
    },
    async computerRequest(input) {
      try {
        return await rpc('agent-interface.computer', {...input, ...(serviceAuth ? {service_key: options.token} : {})}) as ComputerStatus | ComputerAttachment;
      } catch (error) {
        // This add-on's 409 responses are deliberate, user-facing ComputerError
        // messages. Preserve busy/control/recovery explanations at this boundary.
        if (error instanceof TransportError && error.rpcCode === 409)
          throw httpError(409, error.rpcMessage || error.message);
        throw error;
      }
    },
    connectComputerDisplay(attachment) {
      const origin = transport.origin;
      if (!origin || attachment.path !== '/api/display/ws' || !/^[A-Za-z0-9_-]{20,200}$/.test(attachment.ticket))
        throw new Error('Hermes returned an invalid computer attachment.');
      const url = new URL(attachment.path, origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('display_ticket', attachment.ticket);
      return new ClientWebSocket(url, {maxPayload: 4 * 1024 * 1024, followRedirects: false, handshakeTimeout: 10_000});
    },
    async tools(botId): Promise<Tool[]> {
      const result = await describe(botId, true);
      return result.toolsets.map((x: Wire) => ({id: x.name, name: x.label || x.name, description: x.description, enabled: x.enabled}));
    },
    async setTools(botId, ids) {
      const state = await open(botId);
      const catalog = await rpc('profiles.describe', {name: botId});
      const known = new Set(catalog.toolsets.map((x: Wire) => x.name));
      if (ids.some(x => !known.has(x))) throw new Error('Unknown Hermes toolset selected.');
      const disabling = catalog.toolsets.filter((x: Wire) => x.enabled && !ids.includes(x.name)).map((x: Wire) => x.name);
      const enabling = catalog.toolsets.filter((x: Wire) => !x.enabled && ids.includes(x.name)).map((x: Wire) => x.name);
      try {
        for (const [action, names] of [['disable', disabling], ['enable', enabling]] as const) {
          if (!names.length) continue;
          const result = await rpc('tools.configure', {session_id: state.session_id, action, names});
          if (result.unknown?.length || result.missing_servers?.length) throw new Error('Hermes could not apply all tool selections.');
        }
      } finally { edited(botId); }
    },
    async skills(botId): Promise<Skill[]> {
      const result = await describe(botId, true);
      return result.skills.map((x: Wire) => ({id: x.name, name: x.name,
        description: contract.requiredSkills.has(x.name) ? 'Required by Hermes' : 'Hermes profile skill',
        enabled: x.enabled, required: contract.requiredSkills.has(x.name)}));
    },
    async setSkills(botId, ids) {
      const all = await rpc('profiles.describe', {name: botId});
      const result = await rpc('profiles.configure', {name: botId, disabled_skills: all.skills.filter((x: Wire) => !ids.includes(x.name)).map((x: Wire) => x.name)})
        .finally(() => edited(botId));
      if (!result.ok) throw new Error('Hermes refused the skill selection.');
    },
    async routines(): Promise<Routine[]> {
      const roster = await rpc('profiles.list', {include_sessions: false});
      const all: Routine[] = [];
      for (const row of roster.profiles) {
        // Dashboard listing reads native jobs directly. The tool-facing list also
        // probes machine-wide gateway processes, which is unsuitable for polling.
        const jobs = await (await http(`/api/cron/jobs?profile=${encodeURIComponent(row.name)}`)).json() as Wire[];
        for (const job of jobs) {
          const prefix = `[bot:${row.name}] `;
          all.push({id: job.id ?? job.job_id, botId: row.name,
            name: job.name.startsWith(prefix) ? job.name.slice(prefix.length) : job.name,
            prompt: job.prompt ?? '', schedule: job.schedule_display,
            enabled: job.enabled !== false && job.state !== 'paused',
            nextRunAt: job.next_run_at ?? undefined, lastRunAt: job.last_run_at ?? undefined,
            lastStatus: job.last_status ?? undefined, lastError: job.last_error ?? undefined, lastDeliveryError: job.last_delivery_error ?? undefined});
        }
      }
      return all;
    },
    async setRoutineEnabled(botId, id, enabled) {
      const response = await (await http(`/api/cron/jobs/${encodeURIComponent(id)}/${enabled ? 'resume' : 'pause'}?profile=${encodeURIComponent(botId)}`, {method: 'POST'})).json() as Wire;
      const job = response.job ?? response;
      if (job.error || (job.enabled !== false && job.state !== 'paused') !== enabled) throw new Error('Hermes did not confirm the routine state. Reload before retrying.');
      discoveryFull = true;
      discoveryGeneration++;
    },
    saveRoutine: routineMutation,
    async deleteRoutine(id) {
      await http(`/api/cron/jobs/${encodeURIComponent(id)}`, {method: 'DELETE'});
      discoveryFull = true;
      discoveryGeneration++;
    },
    async discoverEvents(cursor): Promise<RuntimeDiscovery> {
      await connect();
      if (!contract.extension) throw new Error('Durable discovery requires the verified Hermes add-on.');
      const full = contract.incrementalDiscovery && discoveryFull, generation = discoveryGeneration;
      const result = await rpc('agent-interface.discover', {cursor, ...(full ? {full: true} : {})}) as RuntimeDiscovery;
      if (full && generation === discoveryGeneration) discoveryFull = false;
      // Routine deliveries settle outside the open session's frames; the journal names their bot.
      for (const event of result.events ?? []) if (typeof event.botId === 'string') changed(event.botId);
      return result;
    },
    inflight(botId): Inflight | undefined {
      const saved = snapshots.get(botId), sid = live.get(botId), state = sid ? transient.get(sid) : undefined;
      if (!saved || !sid || !state || saved.value.session_id !== sid) return undefined;
      const message = inflightMessage({...saved.value, inflight: {...saved.value.inflight, assistant: state.text, reasoning: state.reasoning}}, saved.rows, state);
      const activity = ["waiting", "blocked", "interrupted"].includes(saved.activity.state) ? saved.activity.state
        : state.tools.some(tool => tool.status === 'running') ? 'working'
        : ["idle", "disconnected"].includes(state.state) ? saved.activity.state
        : state.state;
      return {botId, message, activity: {...saved.activity, state: activity, detail: state.detail ?? saved.activity.detail}, toolCalls: state.tools};
    },
    watch(botId, listener) {
      const listeners = watchers.get(botId) ?? new Set();
      watchers.set(botId, listeners);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size && watchers.get(botId) === listeners) watchers.delete(botId);
      };
    },
    async close() {
      transport.close();
    },
  };
}
