import { botIdFor, reasoningLevels, serviceTiers } from "../shared/types.js";
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ActivityState, Avatar, Bot, BotInput, Capabilities, Conversation, ConversationOptions, Inflight, FileRef, Message, Routine, Runtime, RuntimeDiscovery, RuntimeStatus, Skill, Submission, SubmissionReceipt, Tool, ToolCall } from '../shared/types.js';
import { isolatedQualification, qualifiedReceipt } from './hermes-qualification.js';
import ClientWebSocket from 'ws';
import type { ExplicitLoginRequest, SecureRequest } from '../shared/vault.js';
import type { ComputerAttachment, ComputerStatus } from '../shared/computer.js';
import { withMessageOrigins, wireOrigin, messageOrigin } from "../shared/message-origin.js";
import { formatBytes } from '../shared/uploads.js';

// The only Hermes wire boundary. Dynamic records are upstream's versioned JSON-RPC payloads.
type Wire = Record<string, any>;
type RegisteredFile = {path:string;name:string;mime:string;botId:string;kind:'upload'|'artifact';version:1};
const qualifiedRevisions = new Set(['b9cb268deffc97946ec11645aa622a7353dd0591', 'd23cc6b06455b8551fb6f61d3cad040a0e82f5b6']);
const keys = ['chat','steering','approvals','uploads','generatedFiles','botConfiguration','tools','skills','routines','durableEvents','idempotency','imageGeneration','stop','portraitGeneration','avatarMetadata'] as const;
export interface HermesOptions { url?: string; token?: string; authMode?: 'static' | 'service'; qualificationFile?: string; qualification?: {revision:string;home:string} }

export function createHermesRuntime(options: HermesOptions = {}): Runtime {
  type DiagnosticCode = NonNullable<RuntimeStatus['code']>;
  class TransportError extends Error {
    constructor(readonly code: DiagnosticCode, message: string, readonly rpcCode?: number, readonly rpcMessage?: string) {
      super(message);
    }
  }
  type Connection = {
    ws: WebSocket;
    verified: boolean;
    lastReceivedAt: number;
    rejectOpening?: (error: Error) => void;
  };
  type Pending = {
    connection: Connection;
    resolve(value: Wire): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  };
  const readMethods = new Set([
    'agent-interface.capabilities', 'agent-interface.receipt', 'agent-interface.discover',
    'profiles.list', 'profiles.describe', 'session.history', 'model.options',
    'groups.capabilities', 'groups.list', 'groups.state', 'groups.log',
  ]);
  let connection: Connection | undefined;
  let connecting: Promise<void> | undefined;
  let reconnecting: Promise<RuntimeStatus> | undefined;
  let serial = 0;
  let closed = false;
  let extension = false;
  let requiredSkills = new Set<string>();
  // An add-on that binds logins requested by address to their member. Earlier ones refuse the extra field.
  let explicitCredentials = false;
  let canonicalSubmit = false;
  let incrementalDiscovery = false;
  let discoveryFull = false;
  let failures = 0;
  let retryAt = 0;
  let lastConnectedAt: string | undefined;
  let botCache: Bot[] = [];
  const pending = new Map<number, Pending>();
  const reads = new Map<string, Promise<Wire>>();
  const live = new Map<string, string>();
  const owners = new Map<string, string>();
  // Assistants with an open in flight, counted, for frames that arrive before its session is known.
  const opening = new Map<string, number>();
  const transient = new Map<string, {text:string;reasoning:string;state:ActivityState;requests:Wire[];tools:ToolCall[];detail?:string}>();
  const rosterWatchers = new Set<() => void>();
  const rosterChanged = () => { for(const listener of rosterWatchers) { try { listener(); } catch { /* Isolate listeners. */ } } };
  const watchers = new Map<string, Set<(kind?: "inflight") => void>>();
  const snapshots = new Map<string, {value: Wire; rows: Message[]; activity: Conversation["activity"]}>();
  let capabilityCache: Capabilities | undefined;
  // Every viewer of an assistant shares one read until Hermes reports a change there, for a few seconds at most.
  const SHARED_READ_MS = 3_000;
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
  // Profile descriptions read files on the Hermes host. Every client's roster poll shares one until this
  // app changes the profile or ten seconds pass, near a client's own poll, so a native dashboard edit is
  // not resent stale by a later save.
  const DESCRIPTION_MS = 10_000;
  const descriptions = new Map<string, {at: number; edit: number; fresh: boolean; pending: boolean; value: Promise<Wire>}>();
  const descriptionEdits = new Map<string, number>();
  let capabilityRequest: Promise<Capabilities> | undefined;
  let rosterRequest: Promise<Bot[]> | undefined;
  const supported = (value:boolean, reason?:string) => ({supported:value,...(!value ? {reason:reason ?? 'The connected Hermes backend does not expose this capability.'}: {})});
  const unavailable = () => new TransportError('unreachable', 'Hermes is disconnected. Check its supervised gateway and connection settings.');
  const serviceAuth = options.authMode === 'service';
  const servicePath = (path: string) => serviceAuth ? '/api/agent-interface/service/' + path.slice('/api/'.length) : path;
  const authHeaders = (): Record<string, string> => serviceAuth ? {'Authorization': `Bearer ${options.token}`} : {'X-Hermes-Session-Token': options.token!};
  // Without a bot, every watched conversation may have changed, as when the connection drops or returns.
  function changed(botId?: string, kind?: "inflight"): void {
    if(!kind)rosterChanged();
    if (botId === undefined) changeEpoch++;
    else touched(botId);
    for (const [watched, listeners] of watchers) {
      if (botId !== undefined && watched !== botId) continue;
      for (const listener of listeners) {
        try { listener(kind); } catch { /* A watcher never stops frame processing. */ }
      }
    }
  }

  let origin: URL | undefined;
  let configurationError: TransportError | undefined;
  if (!options.url && !options.token) {
    configurationError = new TransportError('not_configured', 'Connect an existing supervised Hermes gateway with its server-side session token.');
  } else if (!options.url || !options.token || options.token.trim() !== options.token || /[\x00-\x1f\x7f]/.test(options.token)) {
    configurationError = new TransportError('invalid_config', 'Hermes needs both a gateway origin and a nonempty server-side session token.');
  } else {
    try {
      if (options.url.trim() !== options.url || !/^https?:\/\/[^/?#\\]+\/?$/i.test(options.url)) throw new Error('Invalid origin');
      const candidate = new URL(options.url);
      const hostname = candidate.hostname.toLowerCase();
      const loopback = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(hostname);
      if (!['http:', 'https:'].includes(candidate.protocol) || candidate.username || candidate.password ||
          candidate.search || candidate.hash || candidate.pathname !== '/' ||
          (candidate.protocol === 'http:' && !loopback)) throw new Error('Invalid origin');
      origin = new URL(candidate.origin);
    } catch {
      configurationError = new TransportError('invalid_config', 'Use an HTTP loopback or HTTPS gateway origin, without a path, query, fragment, or embedded credentials.');
    }
  }
  let diagnostic: RuntimeStatus = {connected: false, code: configurationError?.code ?? 'connecting', detail: configurationError?.message};

  function statusSnapshot(): RuntimeStatus {
    return {...diagnostic, ...(origin ? {address: origin.origin} : {}),
      ...(lastConnectedAt ? {lastConnectedAt} : {}),
      ...(retryAt ? {retryAt: new Date(retryAt).toISOString()} : {})};
  }
  function markFailure(error: Error): void {
    if (closed) return;
    const failure = error instanceof TransportError ? error : unavailable();
    failures += 1;
    retryAt = Date.now() + Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5));
    diagnostic = {connected: false, code: failure.code, detail: failure.message};
  }
  function disconnect(current: Connection, error: Error, recordFailure = true): void {
    if (connection !== current) return;
    connection = undefined;
    current.rejectOpening?.(error);
    current.rejectOpening = undefined;
    for (const [id, item] of pending) {
      if (item.connection !== current) continue;
      clearTimeout(item.timer);
      pending.delete(id);
      item.reject(error);
    }
    reads.clear();
    live.clear();
    descriptions.clear();
    capabilityCache = undefined;
    extension = false;
    canonicalSubmit = false;
    incrementalDiscovery = false;
    // A disconnected stream cannot identify which turn is now active. Fresh
    // native snapshots restore current activity, reasoning and tools.
    transient.clear();
    snapshots.clear();
    // A reconnected socket receives a session's frames only after reopening it. Watchers reload,
    // but failed attempts during an outage, which never carried frames, stay quiet.
    if (current.verified) changed();
    if (current.ws.readyState < WebSocket.CLOSING) {
      try { current.ws.close(); } catch { /* Already disconnected. */ }
    }
    if (recordFailure && !connecting && !closed) markFailure(error);
  }
  async function diagnoseOpeningFailure(error: Error): Promise<Error> {
    // WebSocket upgrade failures hide HTTP status. This authenticated native read
    // distinguishes an expired token from an unavailable gateway without paid work.
    if (closed || !origin || !options.token || error instanceof TransportError && ['unauthorized', 'closed'].includes(error.code)) return error;
    try {
      const response = await fetch(new URL(servicePath('/api/profiles'), origin), {
        headers: authHeaders(),
        signal: AbortSignal.timeout(5_000), redirect: 'error',
      });
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403)
        return new TransportError('unauthorized', 'Hermes rejected the session token. Update the server-side token and reconnect.');
    } catch { /* Keep the bounded, sanitized transport diagnosis. */ }
    return error;
  }
  function verifyContract(capabilities: Wire): void {
    const qualified = qualifiedRevisions.has(capabilities.revision) ||
      qualifiedReceipt(options.qualificationFile, capabilities.revision, capabilities.tracked_patch_sha256) ||
      isolatedQualification(options.qualification, origin) === capabilities.revision;
    if (!qualified || capabilities.durable_admission !== true ||
        capabilities.durable_events !== true || capabilities.canonical_open !== true) {
      throw new TransportError('incompatible', 'The verified durable Hermes add-on has an incompatible contract. Install a qualified add-on revision and reconnect.');
    }
    extension = true;
    explicitCredentials = capabilities.explicit_credentials === true;
    canonicalSubmit = capabilities.canonical_submit === true;
    incrementalDiscovery = capabilities.incremental_discovery === true;
    requiredSkills = new Set(Array.isArray(capabilities.essential_skills) ? capabilities.essential_skills.filter((value: unknown) => typeof value === 'string') : []);
  }
  async function connect(): Promise<void> {
    if (closed) throw new TransportError('closed', 'The Hermes connection is closed.');
    if (configurationError) throw configurationError;
    if (connecting) return connecting;
    if (connection?.verified && connection.ws.readyState === WebSocket.OPEN && Date.now() - connection.lastReceivedAt < 15_000) return;
    if (retryAt > Date.now()) throw new TransportError(diagnostic.code ?? 'unreachable', diagnostic.detail ?? unavailable().message);
    const attempt = (async () => {
      diagnostic = {connected: false, code: lastConnectedAt ? 'reconnecting' : 'connecting', detail: 'Checking the Hermes gateway and durable add-on contract.'};
      let current = connection;
      let announced: Promise<Wire> | undefined;
      const handshakeDeadline = setTimeout(() => {
        if (current && connection === current) disconnect(current, new TransportError('unreachable', 'Hermes handshake timed out. Check its supervised gateway and add-on.'));
      }, 10_000);
      try {
        if (!current || current.ws.readyState !== WebSocket.OPEN) {
          if (current) disconnect(current, unavailable(), false);
          const url = new URL('/api/ws', origin);
          url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
          if (serviceAuth) {
            let response: Response;
            try {
              response = await fetch(new URL('/api/agent-interface/service-ticket', origin), {
                method: 'POST', headers: authHeaders(), signal: AbortSignal.timeout(5_000), redirect: 'error',
              });
            } catch { throw unavailable(); }
if (!response.ok) throw new TransportError(response.status === 401 || response.status === 403 ? 'unauthorized' : 'unreachable',
              response.status === 401 || response.status === 403 ? 'Hermes rejected the private service credential.' : 'Hermes service ticket could not be issued.');
            const body = await response.json() as Wire;
            if (typeof body.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.ticket))
              throw new TransportError('incompatible', 'Hermes returned an invalid service upgrade ticket.');
            if (closed) throw new TransportError('closed', 'The Hermes connection is closed.');
            url.searchParams.set('ticket', body.ticket);
          } else url.searchParams.set('token', options.token!);
          let ws: WebSocket;
          try { ws = new WebSocket(url); } catch { throw unavailable(); }
          current = {ws, verified: false, lastReceivedAt: Date.now()};
          connection = current;
          const owned = current;
          try {
            await new Promise<void>((resolve, reject) => {
              let settled = false;
              const settle = (error?: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(deadline);
                owned.rejectOpening = undefined;
                error ? reject(error) : resolve();
              };
              owned.rejectOpening = error => settle(error);
              const deadline = setTimeout(() => {
                const error = new TransportError('unreachable', 'Hermes connection timed out. Check its gateway address and supervised process.');
                settle(error);
                disconnect(owned, error);
              }, 10_000);
              ws.addEventListener('open', () => { if (connection === owned) settle(); });
              ws.addEventListener('error', () => {
                if (connection !== owned) return;
                const error = unavailable();
                settle(error);
                disconnect(owned, error);
              });
              ws.addEventListener('close', event => {
                if (connection !== owned) return;
                const code = (event as CloseEvent).code;
                const error = [4401, 4403].includes(code) || code === 1008 && /auth|token|unauthor/i.test((event as CloseEvent).reason ?? '')
                  ? new TransportError('unauthorized', 'Hermes rejected the session token. Update the server-side token and reconnect.')
                  : new TransportError('unreachable', 'Hermes disconnected during the request. Its outcome may be uncertain.');
                settle(error);
                disconnect(owned, error);
              });
              ws.addEventListener('message', event => receive(owned, String((event as MessageEvent).data)));
            });
          } catch (error) {
            throw await diagnoseOpeningFailure(error instanceof Error ? error : unavailable());
          }
          announced = rawRpc(current, 'client.capabilities', {server_requests: true});
        }
        // One round trip: the contract check follows the client announcement on the same socket.
        const checked = rawRpc(current, 'agent-interface.capabilities');
        checked.catch(() => { /* Settled below, after the announcement. */ });
        if (announced) await announced;
        let capabilities: Wire;
        try { capabilities = await checked; }
        catch (error) {
          if (error instanceof TransportError && error.rpcCode === -32601)
            throw new TransportError('addon_missing', 'Install the verified durable Hermes add-on before using this app, then reconnect.');
          throw error;
        }
        if (connection !== current || current.ws.readyState !== WebSocket.OPEN) throw unavailable();
        verifyContract(capabilities);
        const fresh = !current.verified;
        if (fresh) lastConnectedAt = new Date().toISOString();
        current.verified = true;
        failures = 0;
        retryAt = 0;
        diagnostic = {connected: true, code: 'ready', version: capabilities.revision, detail: 'The Hermes gateway and durable add-on contract are verified.'};
        if (fresh) changed();
        startHeartbeat();
      } catch (error) {
        const failure = error instanceof TransportError ? error : unavailable();
        if (current && connection === current) disconnect(current, failure);
        markFailure(failure);
        throw failure;
      } finally { clearTimeout(handshakeDeadline); }
    })();
    connecting = attempt;
    try { await attempt; } finally { if (connecting === attempt) connecting = undefined; }
  }
  // A quiet socket is checked in the background, so no request waits on a dead one,
  // and open chats reconnect without waiting for a request.
  const HEARTBEAT_MS = 10_000;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  function startHeartbeat(): void {
    if (heartbeat || closed) return;
    heartbeat = setInterval(() => {
      if (closed || connecting) return;
      const current = connection;
      if (current?.verified && current.ws.readyState === WebSocket.OPEN) {
        if (Date.now() - current.lastReceivedAt >= HEARTBEAT_MS) void rpc('agent-interface.capabilities').catch(() => {});
      } else if ((watchers.size||rosterWatchers.size) && retryAt <= Date.now()) void connect().catch(() => {});
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
  }
  function receive(current: Connection, data: string): void {
    if (connection !== current) return;
    for (const line of data.split('\n').filter(Boolean)) {
      let frame: Wire;
      try { frame = JSON.parse(line); } catch { continue; }
      if (!frame || typeof frame !== 'object') continue;
      current.lastReceivedAt = Date.now();
      if (typeof frame.id === 'number' && !frame.method) {
        const item = pending.get(frame.id);
        if (item?.connection === current) {
          clearTimeout(item.timer);
          pending.delete(frame.id);
          if (frame.error) {
            const code = frame.error.code;
            const unauthorized = [401, 403].includes(code);
            const error = new TransportError(unauthorized ? 'unauthorized' : 'incompatible',
              unauthorized ? 'Hermes rejected the session token. Update the server-side token and reconnect.' : `Hermes refused the request (code ${typeof code === 'number' ? code : 'unknown'}). Review before retrying.`,
              typeof code === 'number' ? code : undefined,
              typeof frame.error.message === 'string' ? frame.error.message.slice(0, 500) : undefined);
            item.reject(error);
            if (unauthorized) disconnect(current, error);
          } else item.resolve(frame.result ?? {});
        }
        continue;
      }
      const params = frame.params ?? {};
      const sid = params.session_id;
      if (!sid) continue;
      const state = transient.get(sid) ?? {text: '', reasoning: '', state: 'idle' as ActivityState, requests: [], tools: []};
      const previousActivity=state.state;
      transient.set(sid, state);
      if (frame.method === 'event') {
        const payload = params.payload ?? {};
        if (params.type === 'message.start') {state.text = ''; state.reasoning = ''; state.detail = undefined; state.tools = []; state.state = 'thinking';}
        if (params.type === 'message.delta') {state.text += payload.delta ?? payload.text ?? ''; if (!state.tools.some(tool => tool.status === 'running')) state.state = 'thinking';}
        if (['reasoning.delta', 'reasoning.available'].includes(params.type) && typeof payload.text === 'string') {
          if (params.type !== 'reasoning.available' || !state.reasoning.endsWith(payload.text)) state.reasoning += payload.text;
        }
        if (params.type === 'thinking.delta' && typeof payload.text === 'string') state.detail = payload.text;
        if (params.type === 'tool.start' || params.type === 'tool.complete') {
          const id = typeof payload.tool_id === 'string' ? payload.tool_id : `live-tool-${params.seq ?? serial}`;
          const existing = state.tools.find(tool => tool.id === id);
          const tool = toolDetails(payload, id, params.type === 'tool.start' ? 'running' : 'completed', existing);
          if (existing) Object.assign(existing, tool); else state.tools.push(tool);
          state.state = state.tools.some(tool => tool.status === 'running') ? 'working' : 'thinking';
          state.detail = typeof payload.summary === 'string' ? payload.summary : params.type === 'tool.start' ? `Using ${tool.name}` : undefined;
        }
        if (params.type === 'tool.generating' && typeof payload.name === 'string') state.detail = `Preparing ${payload.name}`;
        if (params.type === 'status.update' && typeof payload.text === 'string') state.detail = payload.text;
        if (params.type === 'message.complete') {state.text = ''; state.reasoning = ''; state.detail = undefined; state.state = payload.status === 'error' ? 'failed' : payload.status === 'interrupted' ? 'interrupted' : 'done'; state.tools = [];}
        if (params.type === 'error') state.state = 'failed';
        if (params.type === 'request.cancel') state.requests = state.requests.filter(x => x.id !== payload.id);
      } else if (frame.id && frame.method) {
        if (frame.method === 'approval') {state.requests = state.requests.filter(x => x.id !== frame.id); state.requests.push(frame); state.state = 'waiting';}
        else if (['clarify', 'sudo', 'secret', 'vault.save_login', 'vault.code', 'vault.unlock_prompt', 'connection'].includes(frame.method)) {state.requests.push(frame); state.state = 'blocked';}
        else if (current.ws.readyState === WebSocket.OPEN) {
          try { current.ws.send(JSON.stringify({jsonrpc: '2.0', id: frame.id, error: {code: -32601, message: 'This client does not implement this official-client bridge.'}})); }
          catch { disconnect(current, unavailable()); }
        }
      }
      // Opening a conversation attaches this socket to its session, so its frames arrive here.
      const botId = owners.get(sid);
      if (botId !== undefined) {
        const delta=frame.method === "event" && ["message.delta", "reasoning.delta", "thinking.delta", "tool.generating", "status.update", "tool.start"].includes(params.type);
        if(delta&&state.state!==previousActivity)rosterChanged();
        if(!delta)snapshots.delete(botId);
        changed(botId,delta?"inflight":undefined);
      }
      // Hermes attaches the socket before it answers a first open, so early frames name no assistant yet.
      else for (const pending of opening.keys()) changed(pending);
    }
  }
  /**
   * Removes persisted segments from the front of accumulated live text. Whitespace
   * is ignored while matching, because streamed and stored separators differ. A
   * mismatch keeps the remainder.
   */
  function unseen(live: string | undefined, segments: (string | undefined)[]): string | undefined {
    if (!live) return live;
    let offset = 0;
    for (const segment of segments) {
      const end = matchedPrefix(live, offset, segment ?? '');
      if (end === undefined) break;
      offset = end;
    }
    if (!offset) return live;
    const rest = live.slice(offset);
    // Drop only the separator before the tail, keeping a code block's indentation.
    const lead = /^\s*/.exec(rest)![0];
    return rest.slice(lead.includes('\n') ? lead.lastIndexOf('\n') + 1 : lead.length);
  }
  /** End offset in `text` after `segment`'s non-whitespace characters, starting at `from`. */
  function matchedPrefix(text: string, from: number, segment: string): number | undefined {
    let i = from, matched = false;
    // UTF-16 units on both sides, so emoji compare correctly.
    for (let k = 0; k < segment.length; k++) {
      const char = segment[k];
      if (/\s/.test(char)) continue;
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] !== char) return undefined;
      i++; matched = true;
    }
    return matched ? i : from;
  }
  function exposedText(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (value !== undefined && value !== null) return JSON.stringify(value, null, 2);
    return undefined;
  }
  // Tool search runs deferred and connector tools through one bridge tool, tool_call. Show the tools it
  // ran, accepting every form Hermes's own normalizer does. One call shows as itself, arguments included.
  function bridged(name: unknown, args: unknown): {name: unknown; args: unknown} {
    if (name !== 'tool_call') return {name, args};
    const parse = (value: unknown) => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return value; } };
    const value = parse(args);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {name, args};
    let calls = (value as Wire).calls === undefined ? (value as Wire).name ? [{name: (value as Wire).name, arguments: (value as Wire).arguments}] : [] : parse((value as Wire).calls);
    if (calls && typeof calls === 'object' && !Array.isArray(calls)) calls = [calls];
    const entries = (Array.isArray(calls) ? calls : []).filter((call): call is Wire => !!call && typeof call === 'object' && typeof call.name === 'string' && !!call.name);
    if (!entries.length) return {name, args};
    if (entries.length === 1) return {name: entries[0].name, args: parse(entries[0].arguments) ?? {}};
    return {name: [...new Set(entries.map(call => call.name))].join(', '), args};
  }
  function unbridged(call: ToolCall): ToolCall {
    const shown = bridged(call.name, call.arguments);
    return shown.name === call.name ? call : {...call, name: shown.name as string, arguments: exposedText(shown.args)};
  }
  function toolDetails(payload: Wire, id: string, status: ToolCall['status'], previous?: ToolCall): ToolCall {
    let result = payload.result;
    if (typeof result === 'string') { try { result = JSON.parse(result); } catch { /* Original text remains inspectable. */ } }
    const failed = result && typeof result === 'object' && (result.success === false || result.ok === false ||
      typeof result.error === 'string' && result.error.length > 0 || typeof result.exit_code === 'number' && result.exit_code !== 0);
    const shown = bridged(payload.name, payload.args ?? payload.args_text);
    return {...previous, id, name: typeof shown.name === 'string' ? shown.name : previous?.name ?? 'Tool',
      status: status === 'completed' && failed ? 'failed' : status,
      arguments: exposedText(shown.args) ?? previous?.arguments,
      ...(status !== 'running' ? {result: exposedText(payload.result) ?? payload.result_text,
        error: failed && typeof result.error === 'string' ? result.error : undefined} : {}),
      ...(status === 'running' ? {startedAt: previous?.startedAt ?? new Date().toISOString()} : {completedAt: new Date().toISOString()})};
  }
  /** share=false never joins an in-flight read, as a read that must see a just-made edit needs. */
  async function rpc(method: string, params: Wire = {}, share = true): Promise<Wire> {
    await connect();
    const current = connection;
    if (!current?.verified || current.ws.readyState !== WebSocket.OPEN) {
      if (current) disconnect(current, unavailable());
      throw unavailable();
    }
    const key = share && (readMethods.has(method) || method === 'image.generate' && params.probe === true) ? `${method}:${JSON.stringify(params)}` : undefined;
    if (key && reads.has(key)) return reads.get(key)!;
    const request = rawRpc(current, method, params);
    if (key) reads.set(key, request);
    try { return await request; }
    finally { if (key && reads.get(key) === request) reads.delete(key); }
  }
  function rawRpc(current: Connection, method: string, params: Wire = {}): Promise<Wire> {
    if (connection !== current || current.ws.readyState !== WebSocket.OPEN) {
      if (connection === current) disconnect(current, unavailable());
      return Promise.reject(unavailable());
    }
    const id = ++serial;
    const timeout = readMethods.has(method) || method === 'client.capabilities' || method === 'image.generate' && params.probe === true ? 10_000 : 45_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new TransportError('unreachable', `Hermes ${method} timed out. Do not replay an uncertain submission.`);
        disconnect(current, error);
      }, timeout);
      pending.set(id, {connection: current, resolve, reject, timer});
      try { current.ws.send(JSON.stringify({jsonrpc: '2.0', id, method, params})); }
      catch { disconnect(current, new TransportError('unreachable', 'Hermes disconnected while sending. Its outcome may be uncertain.')); }
    });
  }
  async function http(path: string, init: RequestInit = {}): Promise<Response> {
    if (closed) throw new TransportError('closed', 'The Hermes connection is closed.');
    if (configurationError) throw configurationError;
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      const credential = path === '/api/agent-interface/credentials' || path === '/api/agent-interface/experience';
      for (const [name, value] of Object.entries(credential ? {'Authorization': `Bearer ${options.token}`} : authHeaders())) headers.set(name, value);
      const target = credential ? '/api/agent-interface/service/' + path.slice('/api/'.length) : servicePath(path);
      response = await fetch(new URL(target, origin), {...init,
        headers,
        signal: AbortSignal.timeout(45_000), redirect: 'error'});
    } catch { throw new TransportError('unreachable', 'Hermes HTTP request failed or timed out. A mutation outcome may be uncertain.'); }
    // Hermes refusing this server's own token is a server configuration problem. Never pass
    // it on as a 401 or 403, which clients read as the end of the person's own sign-in.
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw Object.assign(new Error("Hermes rejected this server's credential. You are still signed in. Ask whoever runs the server to update its Hermes token, then reconnect."), {statusCode: 502, code: 'hermes_unauthorized', expose: true});
    }
    if (!response.ok && path.startsWith('/api/audio/') && response.status === 400) {
      await response.body?.cancel();
      throw Object.assign(new Error('Voice is unavailable. Check the speech provider in the native Hermes dashboard.'), { statusCode: 409 });
    }
    if (!response.ok && path === '/api/agent-interface/credentials') {
      await response.body?.cancel();
      throw Object.assign(new Error('Hermes could not confirm this credential operation. Refresh its status before trying again.'), { statusCode: response.status });
    }
    if (!response.ok && ['/api/agent-interface/integrations', '/api/agent-interface/experience'].includes(path)) {
      const detail = await response.json().catch(() => ({})) as {error?:unknown};
      throw Object.assign(new Error(typeof detail.error === 'string' ? detail.error.slice(0,1000) : 'Hermes could not finish this connection operation.'), {statusCode:response.status});
    }
    if (!response.ok) throw new TransportError('unreachable', `Hermes HTTP ${response.status}: request failed.`);
    return response;
  }
  async function voiceReply(path: string, payload: Wire): Promise<Wire> {
    const response = await http(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.body) throw new Error('Hermes returned no voice response.');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 12 * 1024 * 1024) { await reader.cancel(); throw new Error('Hermes returned oversized voice data.'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Wire;
    if (value.ok !== true) throw Object.assign(new Error('Hermes voice is unavailable. Check the speech provider in the native dashboard.'), { statusCode: 409 });
    return value;
  }
  async function runtimeStatus(): Promise<RuntimeStatus> {
    try { await connect(); } catch { /* Expose the sanitized connection diagnosis. */ }
    return statusSnapshot();
  }
  async function reconnect(): Promise<RuntimeStatus> {
    if (closed || configurationError) return statusSnapshot();
    if (reconnecting) return reconnecting;
    const attempt = (async () => {
      if (connection?.verified && connection.ws.readyState === WebSocket.OPEN) {
        // Force a read-only contract check while keeping admitted work on its socket.
        connection.lastReceivedAt = 0;
      } else if (connection) {
        disconnect(connection, new TransportError('unreachable', 'Hermes connection replaced. Review any uncertain mutation before retrying.'), false);
      }
      if (connecting) await connecting.catch(() => {});
      retryAt = 0;
      return runtimeStatus();
    })();
    reconnecting = attempt;
    try { return await attempt; } finally { if (reconnecting === attempt) reconnecting = undefined; }
  }
  // Most callers need only the session, its run state and open requests, so they skip the history read.
  async function open(botId:string,read:{history?:boolean;window?:ConversationOptions['window']}={history:false}):Promise<Wire>{
    await connect();
    if(extension){opening.set(botId,(opening.get(botId)??0)+1);let value:Wire;try{value=await rpc('agent-interface.open',{profile:botId,...(read.history===false?{omit_messages:true}:read.window?{window:read.window}:{})});}finally{const count=(opening.get(botId)??1)-1;if(count)opening.set(botId,count);else opening.delete(botId);}live.set(botId,value.session_id);owners.set(value.session_id,botId);if(!transient.has(value.session_id))transient.set(value.session_id,{text:value.inflight?.assistant??'',reasoning:value.inflight?.reasoning??'',state:value.info?.running?'thinking':'idle',requests:[],tools:[]});const state=transient.get(value.session_id);if(state){state.requests=Array.isArray(value.open_requests)?value.open_requests:[];if(state.state==='disconnected'){state.state=value.app_interruption?'interrupted':value.info?.running?'thinking':'idle';state.text='';state.tools=[];}else if(!state.requests.length&&['waiting','blocked'].includes(state.state)){state.state=value.info?.running?'thinking':'idle';}}return value;}
    throw new Error('The verified durable Hermes add-on is required before opening a conversation.');
  }
  // fresh reads Hermes again, as settings and this app's own edits need. Fresh reads share only
  // with reads started after this app's last edit to the profile, never with one from before it.
  function describe(name:string,fresh=false):Promise<Wire>{
    const now=Date.now(),cached=descriptions.get(name),edit=descriptionEdits.get(name)??0;
    if(!fresh&&cached&&now-cached.at<DESCRIPTION_MS)return cached.value;
    if(fresh&&cached&&cached.edit===edit&&cached.fresh&&cached.pending)return cached.value;
    const entry={at:now,edit,fresh,pending:true,value:rpc('profiles.describe',{name},false)};
    descriptions.set(name,entry);
    entry.value.then(()=>{entry.pending=false;},()=>{entry.pending=false;if(descriptions.get(name)===entry)descriptions.delete(name);});
    return entry.value;
  }
  function edited(name:string):void{descriptions.delete(name);descriptionEdits.set(name,(descriptionEdits.get(name)??0)+1);}
  function preview(session?:Wire):Bot['lastMessage']{
    const text=typeof session?.preview==='string'?session.preview.replace(/\s+/g,' ').trim().slice(0,160):'';
    if(!text || messageOrigin({id:"preview",role:"user",text})?.visibility === "activity")return undefined;
    const at=typeof session?.last_active==='number'&&Number.isFinite(session.last_active)?new Date(session.last_active*1000).toISOString():undefined;
    return at?{text,at}:{text};
  }
  function bot(row:Wire,detail?:Wire):Bot{
    const meta=row.ui_meta?.agent_interface??{};
    return {id:row.name,name:meta.name||row.display_name||row.ui_meta?.['hermes-bots']?.title||row.name,description:row.description,instructions:detail?detail.soul??'':undefined,model:row.model??detail?.model?.default??'Inherited',provider:row.provider??detail?.model?.provider,shared:meta.shared??true,avatar:meta.avatar,enabledTools:detail?.toolsets?.filter((x:Wire)=>x.enabled).map((x:Wire)=>x.name),enabledSkills:detail?.skills?.filter((x:Wire)=>x.enabled).map((x:Wire)=>x.name),enabledMcpServers:detail?.mcp_servers?.filter((x:Wire)=>x.enabled).map((x:Wire)=>x.name),sessionId:row.canonical_session?.resolved_id,activity:transient.get(live.get(row.name)??'')?.state??'idle',lastMessage:preview(row.canonical_session)};
  }
  function signFile(value:RegisteredFile):FileRef{
    if(!options.token)throw unavailable();const body=Buffer.from(JSON.stringify(value)).toString('base64url');const signature=createHmac('sha256',options.token).update(body).digest('base64url');
    const id=`${body}.${signature}`;return {id,name:value.name,mime:value.mime,url:`/api/files/${encodeURIComponent(id)}`};
  }
  function fileValue(id:string):RegisteredFile{
    if(!options.token)throw unavailable();const [body,signature,...extra]=id.split('.');if(!body||!signature||extra.length)throw new Error('Invalid file identifier.');
    const expected=createHmac('sha256',options.token).update(body).digest();const actual=Buffer.from(signature,'base64url');if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new Error('Invalid file identifier.');const value=JSON.parse(Buffer.from(body,'base64url').toString());if(value.version!==1||!['upload','artifact'].includes(value.kind)||typeof value.path!=='string'||!value.path.startsWith('/')||value.path.includes('\0')||value.path.split('/').includes('..')||typeof value.botId!=='string'||typeof value.name!=='string'||typeof value.mime!=='string')throw new Error('Unregistered file identifier.');return value;
  }
  // The add-on's context for a login requested by address. Every field is assistant text except the requester.
  function explicitLogin(value:unknown):{explicit?:ExplicitLoginRequest}{
    const row=value as Wire;
    if(!row||typeof row!=='object'||!['label','purpose','profile'].every(key=>typeof row[key]==='string'&&row[key]))return {};
    return {explicit:{label:row.label.slice(0,80),purpose:row.purpose.slice(0,300),profile:row.profile.slice(0,200),
      ...(typeof row.requesterId==='string'&&row.requesterId?{requestedBy:{id:row.requesterId}}:{})}};
  }
  function receipt(value:Wire):SubmissionReceipt{return {requestId:value.requestId,status:value.status,runId:value.runId,...(value.userRowId!=null?{messageId:String(value.userRowId)}:{}),message:value.message};}
  function artifacts(botId:string,row:Wire):FileRef[]{
    // Only the revision-bound executor can attest output provenance and path policy.
    // Never turn message text or a tool's unverified JSON path into a download capability.
    const descriptors=row.role==='user'?row.app_attachments:row.app_artifacts;
    if(!Array.isArray(descriptors))return [];
    const seen=new Set<string>();
    return descriptors.flatMap((file:Wire)=>{if(typeof file.path!=='string'||!file.path.startsWith('/')||file.path.includes('\0')||file.path.split('/').includes('..')||seen.has(file.path))return [];seen.add(file.path);const name=typeof file.name==='string'?file.name:file.path.split('/').pop()??'file';const extension=name.split('.').pop()?.toLowerCase();const mime=typeof file.mime==='string'?file.mime:({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',pdf:'application/pdf',txt:'text/plain',md:'text/markdown'} as Record<string,string>)[extension??'']??'application/octet-stream';return [signFile({path:file.path,name,mime,botId,kind:row.role==='user'?'upload':'artifact',version:1})];});
  }
  async function submit(input:Submission,steer=false):Promise<SubmissionReceipt>{
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
    await connect();if(!extension)throw new Error('Durable Hermes admission add-on is required before sending.');
    const fast=canonicalSubmit,state=fast?undefined:await open(input.botId);
    if((steer||state?.info?.running)&&attachments.some(x=>x.mime.startsWith('image/')))return {requestId:input.requestId,status:'rejected',message:'Images cannot be added while Hermes is working. Keep this draft and send it after the task settles.'};
    const references=attachments.filter(x=>!x.mime.startsWith('image/')).map(x=>`@file:${JSON.stringify(x.path)}`).join('\n');
    try{
      const value=await rpc('agent-interface.submit',{profile:input.botId,...(state?{session_id:state.session_id}:{}),request_id:input.requestId,sender_id:input.senderId,text:input.text+(references?'\n'+references:''),attachments,steer,reviewed_interruption:input.reviewedInterruption===true});
      // A misadvertised older add-on must not be retried after possible admission.
      // Fall back to its old read checks for future sends, and recover participation now.
      if(fast&&(typeof value.running!=='boolean'||typeof value.interruption_pending!=='boolean')){
        canonicalSubmit=false;
        const prior=await open(input.botId).catch(()=>undefined);
        return {...receipt(value),runId:value.runId??prior?.app_run_id};
      }
      return receipt(value);
    }catch(error){
      if(error instanceof TransportError&&error.rpcCode===4094)throw Object.assign(new Error('Review the interrupted task before starting another message.'),{statusCode:409,code:'interruption_pending'});
      return {requestId:input.requestId,status:'uncertain',message:error instanceof Error?error.message:'Hermes response lost. Review before retrying.'};
    }
  }

  async function scanRoutines():Promise<void>{
    discoveryFull=true;
    try{await connect();if(incrementalDiscovery){await rpc('agent-interface.discover',{cursor:'0',full:true});discoveryFull=false;}}
    catch{/* A saved routine stays saved. The next discovery tick retries its scan. */}
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
    await scanRoutines();
    return { ...input, id: jobId, enabled: isEnabled(job) };
  }
  function inflightMessage(value:Wire,rows:Message[]):Message{
      const sid=value.session_id;
      const state=transient.get(sid);const inflight=value.inflight??{};
      const active=!!value.info?.running||!!value.app_run_id;
      // Live text and reasoning accumulate across the whole turn, while each segment
      // before a tool call is already a history row. Show only the unpersisted tail.
      // The run ID proves rows belong to this task, and queued follow-ups share it, so
      // only rows after the latest prompt count. Without a run ID, nothing is removed.
      const run=active&&typeof value.app_run_id==='string'?value.app_run_id:undefined;
      const lastPrompt=rows.findLastIndex(row=>row.role==='user');
      const lastTurn=rows.slice(lastPrompt+1).filter(row=>row.role==='assistant');
      // A finished turn can leave its whole reply in the snapshot after history saved it. Remove
      // the saved turn too, unless the snapshot names a newer prompt than the last saved one.
      // The snapshot's prompt keeps file references that the saved display text drops.
      const prompt=typeof inflight.user==='string'?inflight.user.replace(/(?:\n@file:"(?:[^"\\]|\\.)*")+\s*$/,'').trim():'';
      const savedPrompt=!prompt||prompt===rows[lastPrompt]?.text.trim();
      const persisted=run?lastTurn.filter(row=>row.runId===run):!active&&savedPrompt?lastTurn:[];
      const text=unseen(inflight.assistant||(active?state?.text:undefined),persisted.map(row=>row.text));
      const reasoning=unseen(typeof inflight.reasoning==='string'?inflight.reasoning:active?state?.reasoning:undefined,persisted.map(row=>row.reasoning));
      let message:Message={id:`${sid}-inflight`,role:"assistant",text:""};
      if(text||reasoning) {
        const origin = !savedPrompt ? wireOrigin({id:'inflight-prompt',role:'user',text:prompt},inflight) ?? {kind:'human' as const,visibility:'conversation' as const} : undefined;
        message={id:`${sid}-inflight`,role:'assistant',text:text??'',reasoning,...(origin ? {origin:{...origin,visibility:origin.kind==='agent'||origin.kind==='diagnostic'?'activity':'conversation'}} : {})};
      }
      // Inherit the saved prompt origin exactly as a conversation read does.
      return withMessageOrigins([...rows,message]).at(-1)!;
  }
  async function readConversation(botId:string,options:ConversationOptions):Promise<Conversation>{await connect();const value=await open(botId,options.history===false?{history:false}:{window:options.window});const sid=value.session_id;const history=value.messages??(await rpc('session.history',{session_id:sid,profile:botId})).messages;
      const rows:Message[]=history.filter((x:Wire)=>x.display_kind!=='hidden').map((row:Wire,listed:number)=>{
        // A windowed read keeps each row's position among all visible rows, so positional IDs never change.
        const index=typeof row.app_index==='number'?row.app_index:listed;
        const text=exposedText(row.app_tool_result)??(typeof row.app_display_text==='string'?row.app_display_text:row.text??(typeof row.content==='string'?row.content:row.context??''));
        const reasoning=typeof row.reasoning==='string'&&row.reasoning?row.reasoning:typeof row.reasoning_content==='string'?row.reasoning_content:undefined;
        const createdAt=typeof row.timestamp==='number'&&Number.isFinite(row.timestamp)?new Date(row.timestamp*1000).toISOString():undefined;
        let toolCall:ToolCall|undefined;
        if(row.role==='tool') {
          if(row.app_tool_call&&typeof row.app_tool_call.id==='string'&&typeof row.app_tool_call.name==='string') toolCall=unbridged(row.app_tool_call);
          else {
            const result = row.app_tool_result ?? row.content;
            toolCall=toolDetails({name:row.name,args:row.args,...(result!==undefined?{result}:{})},String(row.tool_call_id??row.row_id??`${sid}-${index}`),'completed');
            toolCall.completedAt=createdAt;
          }
        }
        const message: Message = {id:String(row.app_request_id??row.row_id??`${sid}-${index}`),runId:typeof row.app_run_id==='string'?row.app_run_id:undefined,role:['user','assistant','tool'].includes(row.role)?row.role:'system',text,createdAt,reasoning,toolName:typeof bridged(row.name,row.args).name === 'string' ? String(bridged(row.name,row.args).name) : undefined,toolCall,files:artifacts(botId,row)};
        const origin = wireOrigin(message, row);
        return origin ? { ...message, origin } : message;
      });
      const state=transient.get(sid),inflight=value.inflight??{},active=!!value.info?.running||!!value.app_run_id;
      // Seed a socket attached mid-turn, without replacing text that already advanced during the read.
      if(active&&state&&typeof inflight.assistant==='string'&&(!state.text||inflight.assistant.startsWith(state.text)))state.text=inflight.assistant;
      if(active&&state&&typeof inflight.reasoning==='string'&&(!state.reasoning||inflight.reasoning.startsWith(state.reasoning)))state.reasoning=inflight.reasoning;
      const tail=inflightMessage(value,rows);
      if(tail.text||tail.reasoning)rows.push(tail);
      if(!active&&state){state.text='';state.reasoning='';state.tools=[];}
      if(active&&state&&['done','failed','interrupted'].includes(state.state))settleSoon(botId);
      const requests=Array.isArray(value.open_requests)?value.open_requests:[];
      const approvals=requests.filter((x:Wire)=>x.method==='approval').map((x:Wire)=>({id:String(x.id),title:'Action approval',detail:x.params?.description??x.params?.command??'Hermes requests approval.',status:'pending' as const}));
      const attention=requests.filter((x:Wire)=>x.method!=='approval').map((x:Wire)=>{
        const params=x.params??{};
        let secure:SecureRequest|undefined;
        const owner={epoch:value.executor_epoch,sessionId:sid};
        if(x.app_local_secure===true&&typeof owner.epoch==='string'&&typeof owner.sessionId==='string') {
          if(x.method==='vault.save_login'&&typeof params.origin==='string'&&typeof params.site==='string')secure={...owner,method:x.method,origin:params.origin,site:params.site,...explicitLogin(x.app_credential)};
          if(x.method==='vault.code')secure={...owner,method:x.method,site:typeof params.site==='string'?params.site:undefined,hint:typeof params.hint==='string'?params.hint:undefined};
          if(x.method==='vault.unlock_prompt'&&['onepassword','bitwarden'].includes(params.backend)&&typeof params.display_name==='string')secure={...owner,method:x.method,backend:params.backend,displayName:params.display_name};
          if(x.method==='secret'&&typeof params.env_var==='string'&&typeof params.prompt==='string')secure={...owner,method:x.method,envVar:params.env_var,prompt:params.prompt};
        }
        const explicit=secure?.method==='vault.save_login'&&!!secure.explicit;
        return {id:String(x.id),kind:secure?'secure' as const:x.method==='clarify'?'clarify' as const:'official' as const,
          title:explicit?'Hermes asks to save a login':secure?'Hermes needs secure input':x.method==='clarify'?'Hermes needs your answer':'Continue in the official Hermes client',
          detail:explicit?'Check the address and reason first. The password goes directly to the encrypted Hermes vault, never into this chat or to the assistant.':secure?'Enter this value securely. It will go directly to Hermes without becoming a chat message.':x.method==='clarify'?'Answer the questions to continue this task.':`Hermes is waiting for ${x.method}. Use the official client to complete credential or service setup.`,
          secure,questions:x.method==='clarify'?(params.questions??[]).map((q:Wire)=>({id:q.qid,prompt:q.question??'',options:q.choices})):undefined};
      });
      const toolCalls:ToolCall[]=Array.isArray(value.app_tool_calls)?value.app_tool_calls.map(unbridged):state?.tools??[];
      if(active&&state)state.tools=toolCalls;
      const runningTool=toolCalls.find(tool=>tool.status==='running');
      const activity:ActivityState=value.app_interruption?'interrupted':approvals.length?'waiting':active?(runningTool||state?.state==='working'&&value.app_tool_calls===undefined?'working':'thinking'):inflight.error?'failed':inflight.interrupted?'interrupted':['done','failed','interrupted'].includes(value.app_task_state)?value.app_task_state:state&&['done','failed','interrupted'].includes(state.state)?state.state:'idle';
      if(options.history!==false)snapshots.set(botId,{value,rows:rows.filter(row=>row.id!==`${sid}-inflight`),activity:{state:attention.length?'blocked':activity,detail:active?(runningTool?`Using ${runningTool.name}`:state?.detail):undefined,runId:value.app_run_id??value.app_interruption?.runId??undefined}});
      // Hermes returns a window's earlier rows first: those the app needs for files and origins.
      const cut=value.app_window&&Number.isInteger(value.app_window.earlier)&&Number.isInteger(value.app_window.context)?value.app_window as {earlier:number;context:number}:undefined;
      const shown=withMessageOrigins(rows);
      return {botId,sessionId:value.canonical_stored_session_id??value.stored_session_id??value.info?.stored_session_id??sid,messages:cut?shown.slice(cut.context):shown,
        ...(cut?{window:{earlier:cut.earlier,context:shown.slice(0,cut.context)}}:{}),activity:{state:value.app_interruption?'interrupted':attention.length?'blocked':activity,detail:active?(runningTool?`Using ${runningTool.name}`:state?.detail):undefined,runId:value.app_run_id??value.app_interruption?.runId??undefined},toolCalls:active?toolCalls:[],approvals,attention,files:rows.flatMap(x=>x.files??[])};}
  return {
    async routineResults(botId, routineId) {
      return await this.experienceRequest!({ operation: 'routine_results', profile: botId, routineId }) as import('../shared/collaboration.js').RoutineResult[];
    },
    async routineOutput(botId, routineId, resultId) {
      return await this.experienceRequest!({ operation: 'routine_output', profile: botId, routineId, resultId }) as import('../shared/collaboration.js').RoutineOutput;
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
      if (catalog.protocol_version !== 2 || catalog.driver !== true) throw Object.assign(new Error('The Hermes group coordinator is unavailable. Refresh before trying again.'), { statusCode: 409 });
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
            models: [...new Set(row.models.filter((value: unknown): value is string => typeof value === 'string' && value.length > 0))].map(model => ({id: model as string, name: model as string, available: row.authenticated !== false && !unavailable.has(model)})),
          }];
        }),
      };
    },
    status: runtimeStatus,
    reconnect,
    async capabilities() {
      if (capabilityRequest) return capabilityRequest;
      const request = (async () => {
        let connected = false;
        try { await connect(); connected = true; } catch { /* Diagnostic supplies the reason. */ }
        if (connected && capabilityCache) return capabilityCache;
        const current = connection;
        const result = Object.fromEntries(keys.map(key => [key, supported(connected && extension, diagnostic.detail ?? 'Hermes is disconnected.')])) as Capabilities;
        result.idempotency = supported(connected && extension, 'The verified durable admission add-on is required.');
        result.chat = result.idempotency;
        result.steering = result.idempotency;
        result.durableEvents = supported(connected && extension, 'The durable lifecycle journal add-on is required.');
        let image = false;
        if (connected) try { image = (await rpc('image.generate', {probe: true})).available === true; } catch { /* A failed probe never enables generation. */ }
        const usable = connected && connection === current && current?.verified === true && current.ws.readyState === WebSocket.OPEN && extension;
        if (!usable) {
          for (const key of keys) result[key] = supported(false, diagnostic.detail ?? 'Hermes is disconnected.');
        } else {
          result.imageGeneration = result.portraitGeneration = supported(image, 'A verified Hermes add-on and a usable image-generation provider are required.');
          capabilityCache = result;
        }
        return result;
      })();
      capabilityRequest = request;
      try { return await request; } finally { if (capabilityRequest === request) capabilityRequest = undefined; }
    },
    async canonicalSubmit(){await connect();return canonicalSubmit;},
    async listBots() {
      if (rosterRequest) return rosterRequest;
      const request = (async () => {
        try {
          const roster = await rpc('profiles.list', {include_sessions: true});
          const names = new Set(roster.profiles.map((row: Wire) => row.name));
          for (const name of descriptions.keys()) if (!names.has(name)) descriptions.delete(name);
          const bots = roster.profiles.map((row: Wire) => bot(row));
          botCache = bots;
          return bots;
        } catch { return botCache.map(row => ({...row, activity: 'disconnected' as const})); }
      })();
      rosterRequest = request;
      try { return await request; } finally { if (rosterRequest === request) rosterRequest = undefined; }
    },
    watchRoster(listener){rosterWatchers.add(listener);return ()=>{rosterWatchers.delete(listener);};},
    async botDetail(botId){const roster=await rpc('profiles.list',{include_sessions:true});const row=roster.profiles.find((row:Wire)=>row.name===botId);if(!row)throw new Error('Unknown Hermes bot.');return bot(row,await describe(botId));},
    async saveBot(input:BotInput,id?:string){await connect();const name=id??botIdFor(input.name);if(!name)throw new Error('Bot name needs letters or numbers.');
      let created=false;try{if(!id){await rpc('profiles.create',{name,description:input.description,soul:input.instructions,mirror_credentials:true,no_alias:true});created=true;}
      const rosterBefore=await rpc('profiles.list',{include_sessions:false});const previous=rosterBefore.profiles.find((x:Wire)=>x.name===name);
      const config:Wire={name,soul:input.instructions,description:input.description??'',ui_meta:{'hermes-bots':{...previous?.ui_meta?.['hermes-bots'],title:input.name},agent_interface:{...previous?.ui_meta?.agent_interface,name:input.name,shared:input.shared}},ui_meta_expected_revisions:{'hermes-bots':previous?.ui_meta_revisions?.['hermes-bots']??0,agent_interface:previous?.ui_meta_revisions?.agent_interface??0}};
      if(input.model && input.model!=='Inherited'){config.model=input.model;config.provider=input.provider??(await rpc('profiles.describe',{name})).model.provider;if(input.confirmModel)config.confirm_expensive_model=true;}if(input.enabledMcpServers)config.enabled_mcp_servers=input.enabledMcpServers;
      if(input.enabledSkills){const all=await rpc('profiles.describe',{name});config.disabled_skills=all.skills.filter((x:Wire)=>!input.enabledSkills!.includes(x.name)).map((x:Wire)=>x.name);}
      const result=await rpc('profiles.configure',config);if(result.confirm_required)throw Object.assign(new Error(typeof result.confirm_message === 'string' ? result.confirm_message.slice(0, 2000) : 'Hermes requires confirmation for this model.'),{statusCode:409,code:'MODEL_CONFIRMATION_REQUIRED',confirmRequired:true});if(!result.ok)throw new Error('Hermes applied only some profile changes: '+Object.entries(result.applied??{}).filter(([_,value])=>value===false).map(([key])=>key).join(', '));if(input.enabledTools)await this.setTools(name,input.enabledTools);
      const roster=await rpc('profiles.list',{include_sessions:true});edited(name);return bot(roster.profiles.find((x:Wire)=>x.name===name),await describe(name,true));}catch(error){edited(name);if(created){try{await http(`/api/profiles/${encodeURIComponent(name)}`,{method:'DELETE'});live.delete(name);}catch{throw Object.assign(new Error('Hermes created the bot but configuration failed and automatic cleanup was refused. Review bot '+name+'.'),{createdBotId:name,cause:error});}}throw error;}},
    async deleteBot(id){try{await http(`/api/profiles/${encodeURIComponent(id)}`,{method:'DELETE'});live.delete(id);}finally{edited(id);}},
    async stop(botId){const state=await open(botId);try{await rpc('session.interrupt',{session_id:state.session_id,profile:botId});}finally{touched(botId);}},
    async generatePortrait(botId,prompt){await open(botId);const result=await rpc('image.generate',{prompt,aspect_ratio:'square',max_bytes:2_000_000});if(!result.success||!result.image_data)throw new Error(typeof result.error==='string'&&/no image generation backend configured/i.test(result.error)?'No image generation backend configured.':'Hermes image generation did not deliver image bytes. Review the provider settings before retrying.');const [,mime,base64]=/^data:([^;]+);base64,(.*)$/.exec(result.image_data)??[];if(!mime||!base64)throw new Error('Hermes returned an invalid generated image.');return this.upload(botId,{name:'generated-portrait.png',mime,data:Buffer.from(base64,'base64')});},
    async setAvatar(botId,avatar:Avatar){
      const roster=await rpc('profiles.list',{include_sessions:false});const row=roster.profiles.find((x:Wire)=>x.name===botId);if(!row)throw new Error('Unknown Hermes bot.');
      let portraitData:string|undefined;
      if(avatar.mode==='portrait'){
        if(!avatar.src.startsWith('/api/files/')||/[?#]/.test(avatar.src))throw new Error('Choose an image uploaded or generated through this app.');
        const id=decodeURIComponent(avatar.src.slice('/api/files/'.length));const file=fileValue(id);if(file.botId!==botId)throw new Error('Portrait belongs to a different Hermes bot.');if(!['image/png','image/jpeg','image/webp'].includes(file.mime))throw new Error('Hermes portraits support PNG, JPEG, and WebP.');
        const chunks:Uint8Array[]=[];
        try{for await(const chunk of (await this.download(id,2_000_000)).body)chunks.push(chunk);}
        catch(error){throw (error as {code?:string}).code==='file_too_large'?new Error('Hermes portraits must be 2 MB or smaller.'):error;}
        portraitData=`data:${file.mime};base64,${Buffer.concat(chunks).toString('base64')}`;
      }
      const meta=row.ui_meta?.agent_interface??{};const result=await rpc('profiles.configure',{name:botId,ui_meta:{agent_interface:{...meta,avatar}},ui_meta_expected_revisions:{agent_interface:row.ui_meta_revisions?.agent_interface??0}});if(!result.ok||result.applied?.ui_meta===false||Object.keys(result.applied?.ui_meta_conflicts??{}).length)throw new Error('The Hermes avatar changed on another client. Reload before saving.');
      // Native assets do not support CAS. Never overwrite one after a rejected metadata revision.
      if(portraitData){try{const stored=await rpc('profiles.set_asset',{name:botId,asset:'avatar',data:portraitData});if(!stored.ok)throw new Error('Asset save refused.');}catch{throw new Error('The app portrait metadata was saved, but Hermes could not save its native portrait asset. Retry to finish saving.');}}
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
    submit(input){return submit(input).finally(()=>touched(input.botId));},steer(input){return submit(input,true).finally(()=>touched(input.botId));},
    async lookupSubmission(requestId){await connect();if(!extension)return null;const result=await rpc('agent-interface.receipt',{request_id:requestId});return result.receipt?receipt(result.receipt):null;},
    // Routes verify profile and request kind with one light read. Native answers prove
    // final staleness, so do not repeat that read here.
    async approve(botId,approvalId,decision,_senderId){const result=await rpc('request.answer',{id:approvalId,profile:botId,result:{choice:decision==='approved'?'once':'deny'}}).finally(()=>touched(botId));if(result.status==='expired'||result.resolved===false)throw new Error('That approval expired before it was answered.');},
    async answerRequest(botId,requestId,answers){const result=await rpc('request.answer',{id:requestId,profile:botId,result:{answers}}).finally(()=>touched(botId));if(result.status==='expired'||result.resolved===false)throw new Error('That question expired before it was answered.');},
    async upload(botId,input){const state=await open(botId);const result=await rpc('file.attach',{session_id:state.session_id,profile:botId,name:input.name,data_url:`data:${input.mime};base64,${input.data.toString('base64')}`});const path=result.path;if(typeof path!=='string'||!path.startsWith('/')||path.includes('\0')||path.split('/').includes('..'))throw new Error('Hermes did not return a staged file path.');return {...signFile({path,name:input.name,mime:input.mime,botId,kind:'upload',version:1}),size:input.data.length};},
    fileBotId(id){try{return fileValue(id).botId;}catch{return undefined;}},
    async download(id,maxBytes){
      const file=fileValue(id);const response=await http(`/api/files/download?path=${encodeURIComponent(file.path)}`);
      const tooLarge=()=>Object.assign(new Error(`${file.name} is larger than ${formatBytes(maxBytes)}, the most this app opens. Ask the assistant for a smaller file.`),{statusCode:502,code:'file_too_large',expose:true});
      // fetch decodes a compressed body, so the declared length counts encoded bytes.
      // Trust it only for an unencoded body; the cap always counts what is sent on.
      const encoding=response.headers.get('content-encoding');
      const declared=!encoding||encoding==='identity'?Number(response.headers.get('content-length')??NaN):NaN;
      if(declared>maxBytes){await response.body?.cancel();throw tooLarge();}
      if(!response.body)throw new Error('Hermes returned no file content.');
      let size=0;
      // Cancelling the result, as when the person disconnects, cancels the Hermes read.
      const body=response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){
        size+=chunk.byteLength;if(size>maxBytes)controller.error(tooLarge());else controller.enqueue(chunk);
      }}));
      return {name:file.name,mime:file.mime,...(Number.isSafeInteger(declared)?{size:declared}:{}),body};
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
      if(input.operation==='run')await scanRoutines();
      if (input.operation === 'history') {
        const seed = value.app_prior_prompt;
        const seedOrigin = seed ? wireOrigin({ id: 'prior', role: 'user', text: seed.text ?? '' }, seed) : undefined;
        value.messages = withMessageOrigins(value.messages.map((row: Wire) => {
          // Expose the app contract only. Raw native metadata can duplicate private message content.
          const message: Message & { app_sender_id?: string } = {
            id:String(row.id), role:row.role, text:exposedText(row.app_tool_result) ?? row.app_display_text ?? row.text ?? '',
            createdAt:row.createdAt, reasoning:row.reasoning, toolName:row.toolName, files:artifacts(input.profile,row),
            ...(typeof row.app_sender_id === 'string' ? {app_sender_id:row.app_sender_id} : {}),
            ...(row.role==='tool'?{toolCall:toolDetails({name:row.name,args:row.args,result:row.app_tool_result ?? row.text},String(row.tool_call_id ?? row.id),'completed')}:{})
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
      const {actor:_actor,...legacy}=input as Extract<typeof input,{operation:'answer'}>;
      const payload=input.operation==='answer'&&!explicitCredentials?legacy:input;
      const response=await http('/api/agent-interface/credentials',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).finally(()=>{if(input.operation==='answer')touched(input.profile);});
      if(!response.body)throw new Error('Hermes returned no credential status.');
      const chunks:Uint8Array[]=[];let size=0;
      for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>){size+=chunk.byteLength;if(size>1024*1024)throw new Error('Hermes returned an invalid credential status.');chunks.push(chunk);}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    },
    // Connections can change a profile's MCP servers; a later save must not resend the old list.
    async integrationRequest(input){try{return await (await http('/api/agent-interface/integrations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})).json();}finally{if(!['list','check'].includes(input.operation))edited(input.profile);}},
    async computerRequest(input) {
      try {
        return await rpc('agent-interface.computer', {...input, ...(serviceAuth ? {service_key: options.token} : {})}) as ComputerStatus | ComputerAttachment;
      } catch (error) {
        // This add-on's 409 responses are deliberate, user-facing ComputerError
        // messages. Preserve busy/control/recovery explanations at this boundary.
        if (error instanceof TransportError && error.rpcCode === 409)
          throw Object.assign(new Error(error.rpcMessage || error.message), {statusCode: 409});
        throw error;
      }
    },
    connectComputerDisplay(attachment) {
      if (!origin || attachment.path !== '/api/display/ws' || !/^[A-Za-z0-9_-]{20,200}$/.test(attachment.ticket))
        throw new Error('Hermes returned an invalid computer attachment.');
      const url = new URL(attachment.path, origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('display_ticket', attachment.ticket);
      return new ClientWebSocket(url, {maxPayload: 4 * 1024 * 1024, followRedirects: false, handshakeTimeout: 10_000});
    },
    async tools(botId):Promise<Tool[]>{const result=await describe(botId,true);return result.toolsets.map((x:Wire)=>({id:x.name,name:x.label||x.name,description:x.description,enabled:x.enabled}));},
    async setTools(botId,ids){const state=await open(botId);const catalog=await rpc('profiles.describe',{name:botId});const known=new Set(catalog.toolsets.map((x:Wire)=>x.name));if(ids.some(x=>!known.has(x)))throw new Error('Unknown Hermes toolset selected.');const disabling=catalog.toolsets.filter((x:Wire)=>x.enabled&&!ids.includes(x.name)).map((x:Wire)=>x.name);const enabling=catalog.toolsets.filter((x:Wire)=>!x.enabled&&ids.includes(x.name)).map((x:Wire)=>x.name);try{for(const [action,names] of [['disable',disabling],['enable',enabling]] as const){if(names.length){const result=await rpc('tools.configure',{session_id:state.session_id,action,names});if(result.unknown?.length||result.missing_servers?.length)throw new Error('Hermes could not apply all tool selections.');}}}finally{edited(botId);}},
    async skills(botId):Promise<Skill[]>{const result=await describe(botId,true);return result.skills.map((x:Wire)=>({id:x.name,name:x.name,description:requiredSkills.has(x.name)?'Required by Hermes':'Hermes profile skill',enabled:x.enabled,required:requiredSkills.has(x.name)}));},
    async setSkills(botId,ids){const all=await rpc('profiles.describe',{name:botId});const result=await rpc('profiles.configure',{name:botId,disabled_skills:all.skills.filter((x:Wire)=>!ids.includes(x.name)).map((x:Wire)=>x.name)}).finally(()=>edited(botId));if(!result.ok)throw new Error('Hermes refused the skill selection.');},
    async routines(): Promise<Routine[]> {
      const roster = await rpc('profiles.list', {include_sessions:false});
      const all: Routine[] = [];
      for (const row of roster.profiles) {
        // Dashboard listing reads native jobs directly. The tool-facing list also
        // probes machine-wide gateway processes, which is unsuitable for polling.
        const jobs = await (await http(`/api/cron/jobs?profile=${encodeURIComponent(row.name)}`)).json() as Wire[];
        for (const job of jobs) {
          const prefix = `[bot:${row.name}] `;
          all.push({id:job.id ?? job.job_id,botId:row.name,
            name:job.name.startsWith(prefix) ? job.name.slice(prefix.length) : job.name,
            prompt:job.prompt ?? '',schedule:job.schedule_display,
            enabled:job.enabled !== false && job.state !== 'paused',
            nextRunAt:job.next_run_at ?? undefined,lastRunAt:job.last_run_at ?? undefined,
            lastStatus:job.last_status ?? undefined,lastError:job.last_error ?? undefined,lastDeliveryError:job.last_delivery_error ?? undefined});
        }
      }
      return all;
    },
    async setRoutineEnabled(botId, id, enabled) {
      const response = await (await http(`/api/cron/jobs/${encodeURIComponent(id)}/${enabled?'resume':'pause'}?profile=${encodeURIComponent(botId)}`,{method:'POST'})).json() as Wire;
      const job=response.job ?? response;
      if(job.error || (job.enabled !== false && job.state !== 'paused') !== enabled) throw new Error('Hermes did not confirm the routine state. Reload before retrying.');
      await scanRoutines();
    },
    saveRoutine: routineMutation,
    async deleteRoutine(id){await http(`/api/cron/jobs/${encodeURIComponent(id)}`,{method:'DELETE'});await scanRoutines();},
    async discoverEvents(cursor):Promise<RuntimeDiscovery>{await connect();if(!extension)throw new Error('Durable discovery requires the verified Hermes add-on.');const full=incrementalDiscovery&&discoveryFull;const result=await rpc('agent-interface.discover',{cursor,...(full?{full:true}:{})}) as RuntimeDiscovery;if(full)discoveryFull=false;
      // Routine deliveries settle outside the open session's frames; the journal names their bot.
      for(const event of result.events??[])if(typeof event.botId==='string')changed(event.botId);
      return result;},
    inflight(botId):Inflight|undefined {
      const saved=snapshots.get(botId),sid=live.get(botId),state=sid?transient.get(sid):undefined;
      if(!saved||!sid||!state||saved.value.session_id!==sid)return undefined;
      const message=inflightMessage({...saved.value,inflight:{...saved.value.inflight,assistant:state.text,reasoning:state.reasoning}},saved.rows);
      return {botId,message,activity:{...saved.activity,state:["waiting","blocked","interrupted"].includes(saved.activity.state)?saved.activity.state:state.state,detail:state.detail},toolCalls:state.tools};
    },
    watch(botId, listener) {
      const listeners = watchers.get(botId) ?? new Set();
      watchers.set(botId, listeners);
      listeners.add(listener);
      return () => { listeners.delete(listener); if (!listeners.size && watchers.get(botId) === listeners) watchers.delete(botId); };
    },
    async close() {
      closed = true;
      clearInterval(heartbeat);
      retryAt = 0;
      diagnostic = {connected: false, code: 'closed', detail: 'The Hermes connection is closed.'};
      if (connection) disconnect(connection, new TransportError('closed', 'The Hermes connection is closed.'));
    },
  };
}
