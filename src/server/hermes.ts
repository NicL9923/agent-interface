import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ActivityState, Avatar, Bot, BotInput, Capabilities, Conversation, FileRef, Message, Routine, Runtime, RuntimeDiscovery, RuntimeStatus, Skill, Submission, SubmissionReceipt, Tool, ToolCall } from '../shared/types.js';
import { isolatedQualification, qualifiedReceipt } from './hermes-qualification.js';

// The only Hermes wire boundary. Dynamic records are upstream's versioned JSON-RPC payloads.
type Wire = Record<string, any>;
type RegisteredFile = {path:string;name:string;mime:string;botId:string;kind:'upload'|'artifact';version:1};
const qualifiedRevisions = new Set(['b9cb268deffc97946ec11645aa622a7353dd0591', 'd23cc6b06455b8551fb6f61d3cad040a0e82f5b6']);
const keys = ['chat','steering','approvals','uploads','generatedFiles','botConfiguration','tools','skills','routines','durableEvents','idempotency','imageGeneration','stop','portraitGeneration','avatarMetadata'] as const;
export interface HermesOptions { url?: string; token?: string; authMode?: 'static' | 'service'; qualificationFile?: string; qualification?: {revision:string;home:string} }

export function createHermesRuntime(options: HermesOptions = {}): Runtime {
  type DiagnosticCode = NonNullable<RuntimeStatus['code']>;
  class TransportError extends Error {
    constructor(readonly code: DiagnosticCode, message: string, readonly rpcCode?: number) {
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
    'profiles.list', 'profiles.describe', 'session.history',
  ]);
  let connection: Connection | undefined;
  let connecting: Promise<void> | undefined;
  let reconnecting: Promise<RuntimeStatus> | undefined;
  let serial = 0;
  let closed = false;
  let extension = false;
  let requiredSkills = new Set<string>();
  let failures = 0;
  let retryAt = 0;
  let lastConnectedAt: string | undefined;
  let botCache: Bot[] = [];
  const pending = new Map<number, Pending>();
  const reads = new Map<string, Promise<Wire>>();
  const live = new Map<string, string>();
  const owners = new Map<string, string>();
  const transient = new Map<string, {text:string;reasoning:string;state:ActivityState;requests:Wire[];tools:ToolCall[];detail?:string}>();
  let capabilityCache: Capabilities | undefined;
  let capabilityRequest: Promise<Capabilities> | undefined;
  let rosterRequest: Promise<Bot[]> | undefined;
  const supported = (value:boolean, reason?:string) => ({supported:value,...(!value ? {reason:reason ?? 'The connected Hermes backend does not expose this capability.'}: {})});
  const unavailable = () => new TransportError('unreachable', 'Hermes is disconnected. Check its supervised gateway and connection settings.');
  const serviceAuth = options.authMode === 'service';
  const servicePath = (path: string) => serviceAuth ? '/api/agent-interface/service/' + path.slice('/api/'.length) : path;
  const authHeaders = (): Record<string, string> => serviceAuth ? {'Authorization': `Bearer ${options.token}`} : {'X-Hermes-Session-Token': options.token!};

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
    capabilityCache = undefined;
    extension = false;
    // A disconnected stream cannot identify which turn is now active. Fresh
    // native snapshots restore current activity, reasoning and tools.
    transient.clear();
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
          await rawRpc(current, 'client.capabilities', {server_requests: true});
        }
        let capabilities: Wire;
        try { capabilities = await rawRpc(current, 'agent-interface.capabilities'); }
        catch (error) {
          if (error instanceof TransportError && error.rpcCode === -32601)
            throw new TransportError('addon_missing', 'Install the verified durable Hermes add-on before using this app, then reconnect.');
          throw error;
        }
        if (connection !== current || current.ws.readyState !== WebSocket.OPEN) throw unavailable();
        verifyContract(capabilities);
        if (!current.verified) lastConnectedAt = new Date().toISOString();
        current.verified = true;
        failures = 0;
        retryAt = 0;
        diagnostic = {connected: true, code: 'ready', version: capabilities.revision, detail: 'The Hermes gateway and durable add-on contract are verified.'};
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
              typeof code === 'number' ? code : undefined);
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
        else if (['clarify', 'sudo', 'secret', 'vault.code', 'vault.unlock_prompt', 'connection'].includes(frame.method)) {state.requests.push(frame); state.state = 'blocked';}
        else if (current.ws.readyState === WebSocket.OPEN) {
          try { current.ws.send(JSON.stringify({jsonrpc: '2.0', id: frame.id, error: {code: -32601, message: 'This client does not implement this official-client bridge.'}})); }
          catch { disconnect(current, unavailable()); }
        }
      }
    }
  }
  function exposedText(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (value !== undefined && value !== null) return JSON.stringify(value, null, 2);
    return undefined;
  }
  function toolDetails(payload: Wire, id: string, status: ToolCall['status'], previous?: ToolCall): ToolCall {
    let result = payload.result;
    if (typeof result === 'string') { try { result = JSON.parse(result); } catch { /* Original text remains inspectable. */ } }
    const failed = result && typeof result === 'object' && (result.success === false || result.ok === false ||
      typeof result.error === 'string' && result.error.length > 0 || typeof result.exit_code === 'number' && result.exit_code !== 0);
    return {...previous, id, name: typeof payload.name === 'string' ? payload.name : previous?.name ?? 'Tool',
      status: status === 'completed' && failed ? 'failed' : status,
      arguments: exposedText(payload.args) ?? (typeof payload.args_text === 'string' ? payload.args_text : previous?.arguments),
      ...(status !== 'running' ? {result: exposedText(payload.result) ?? payload.result_text,
        error: failed && typeof result.error === 'string' ? result.error : undefined} : {}),
      ...(status === 'running' ? {startedAt: previous?.startedAt ?? new Date().toISOString()} : {completedAt: new Date().toISOString()})};
  }
  async function rpc(method: string, params: Wire = {}): Promise<Wire> {
    await connect();
    const current = connection;
    if (!current?.verified || current.ws.readyState !== WebSocket.OPEN) {
      if (current) disconnect(current, unavailable());
      throw unavailable();
    }
    const key = readMethods.has(method) || method === 'image.generate' && params.probe === true ? `${method}:${JSON.stringify(params)}` : undefined;
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
      for (const [name, value] of Object.entries(authHeaders())) headers.set(name, value);
      response = await fetch(new URL(servicePath(path), origin), {...init,
        headers,
        signal: AbortSignal.timeout(45_000), redirect: 'error'});
    } catch { throw new TransportError('unreachable', 'Hermes HTTP request failed or timed out. A mutation outcome may be uncertain.'); }
    if (!response.ok) throw new TransportError(response.status === 401 || response.status === 403 ? 'unauthorized' : 'unreachable',
      response.status === 401 || response.status === 403 ? 'Hermes rejected the session token. Update the server-side token and reconnect.' : `Hermes HTTP ${response.status}: request failed.`);
    return response;
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
  async function open(botId:string):Promise<Wire>{
    await connect();
    if(extension){const value=await rpc('agent-interface.open',{profile:botId});live.set(botId,value.session_id);owners.set(value.session_id,botId);const state=transient.get(value.session_id);if(state){state.requests=Array.isArray(value.open_requests)?value.open_requests:[];if(state.state==='disconnected'){state.state=value.app_interruption?'interrupted':value.info?.running?'thinking':'idle';state.text='';state.tools=[];}else if(!state.requests.length&&['waiting','blocked'].includes(state.state)){state.state=value.info?.running?'thinking':'idle';}}return value;}
    throw new Error('The verified durable Hermes add-on is required before opening a conversation.');
  }
  function bot(row:Wire,detail?:Wire):Bot{
    const meta=row.ui_meta?.agent_interface??{};
    return {id:row.name,name:meta.name||row.display_name||row.ui_meta?.['hermes-bots']?.title||row.name,description:row.description,instructions:detail?.soul,model:row.model??detail?.model?.default??'Inherited',provider:row.provider??detail?.model?.provider,shared:meta.shared??true,avatar:meta.avatar,enabledTools:detail?.toolsets?.filter((x:Wire)=>x.enabled).map((x:Wire)=>x.name),enabledSkills:detail?.skills?.filter((x:Wire)=>x.enabled).map((x:Wire)=>x.name),enabledMcpServers:detail?.mcp_servers?.filter((x:Wire)=>x.enabled).map((x:Wire)=>x.name),sessionId:row.canonical_session?.resolved_id,activity:transient.get(live.get(row.name)??'')?.state??'idle'};
  }
  function signFile(value:RegisteredFile):FileRef{
    if(!options.token)throw unavailable();const body=Buffer.from(JSON.stringify(value)).toString('base64url');const signature=createHmac('sha256',options.token).update(body).digest('base64url');
    const id=`${body}.${signature}`;return {id,name:value.name,mime:value.mime,url:`/api/files/${encodeURIComponent(id)}`};
  }
  function fileValue(id:string):RegisteredFile{
    if(!options.token)throw unavailable();const [body,signature,...extra]=id.split('.');if(!body||!signature||extra.length)throw new Error('Invalid file identifier.');
    const expected=createHmac('sha256',options.token).update(body).digest();const actual=Buffer.from(signature,'base64url');if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new Error('Invalid file identifier.');const value=JSON.parse(Buffer.from(body,'base64url').toString());if(value.version!==1||!['upload','artifact'].includes(value.kind)||typeof value.path!=='string'||!value.path.startsWith('/')||value.path.includes('\0')||value.path.split('/').includes('..')||typeof value.botId!=='string'||typeof value.name!=='string'||typeof value.mime!=='string')throw new Error('Unregistered file identifier.');return value;
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
    await connect();if(!extension)throw new Error('Durable Hermes admission add-on is required before sending.');const state=await open(input.botId);
    if((steer||state.info?.running)&&attachments.some(x=>x.mime.startsWith('image/')))return {requestId:input.requestId,status:'rejected',message:'Images cannot be added while Hermes is working. Keep this draft and send it after the task settles.'};
    const references=attachments.filter(x=>!x.mime.startsWith('image/')).map(x=>`@file:${JSON.stringify(x.path)}`).join('\n');
    try{return receipt(await rpc('agent-interface.submit',{profile:input.botId,session_id:state.session_id,request_id:input.requestId,sender_id:input.senderId,text:input.text+(references?'\n'+references:''),attachments,steer,reviewed_interruption:input.reviewedInterruption===true}));}catch(error){return {requestId:input.requestId,status:'uncertain',message:error instanceof Error?error.message:'Hermes response lost. Review before retrying.'};}
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
    return { ...input, id: jobId, enabled: isEnabled(job) };
  }
  return {
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
    async listBots() {
      if (rosterRequest) return rosterRequest;
      const request = (async () => {
        try {
          const roster = await rpc('profiles.list', {include_sessions: true});
          const bots = await Promise.all(roster.profiles.map(async (row: Wire) => bot(row, await rpc('profiles.describe', {name: row.name}))));
          botCache = bots;
          return bots;
        } catch { return botCache.map(row => ({...row, activity: 'disconnected' as const})); }
      })();
      rosterRequest = request;
      try { return await request; } finally { if (rosterRequest === request) rosterRequest = undefined; }
    },
    async saveBot(input:BotInput,id?:string){await connect();const name=id??input.name.toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-|-$/g,'');if(!name)throw new Error('Bot name needs letters or numbers.');
      let created=false;try{if(!id){await rpc('profiles.create',{name,description:input.description,soul:input.instructions,mirror_credentials:true,no_alias:true});created=true;}
      const rosterBefore=await rpc('profiles.list',{include_sessions:false});const previous=rosterBefore.profiles.find((x:Wire)=>x.name===name);
      const config:Wire={name,soul:input.instructions,description:input.description??'',ui_meta:{'hermes-bots':{...previous?.ui_meta?.['hermes-bots'],title:input.name},agent_interface:{...previous?.ui_meta?.agent_interface,name:input.name,shared:input.shared}},ui_meta_expected_revisions:{'hermes-bots':previous?.ui_meta_revisions?.['hermes-bots']??0,agent_interface:previous?.ui_meta_revisions?.agent_interface??0}};
      if(input.model && input.model!=='Inherited'){config.model=input.model;config.provider=input.provider??(await rpc('profiles.describe',{name})).model.provider;if(input.confirmModel)config.confirm_expensive_model=true;}if(input.enabledMcpServers)config.enabled_mcp_servers=input.enabledMcpServers;
      if(input.enabledSkills){const all=await rpc('profiles.describe',{name});config.disabled_skills=all.skills.filter((x:Wire)=>!input.enabledSkills!.includes(x.name)).map((x:Wire)=>x.name);}
      const result=await rpc('profiles.configure',config);if(result.confirm_required)throw Object.assign(new Error('Hermes requires confirmation for this model.'),{statusCode:409,code:'MODEL_CONFIRMATION_REQUIRED',confirmRequired:true});if(!result.ok)throw new Error('Hermes applied only some profile changes: '+Object.entries(result.applied??{}).filter(([_,value])=>value===false).map(([key])=>key).join(', '));if(input.enabledTools)await this.setTools(name,input.enabledTools);
      const roster=await rpc('profiles.list',{include_sessions:true});return bot(roster.profiles.find((x:Wire)=>x.name===name),await rpc('profiles.describe',{name}));}catch(error){if(created){try{await http(`/api/profiles/${encodeURIComponent(name)}`,{method:'DELETE'});live.delete(name);}catch{throw Object.assign(new Error('Hermes created the bot but configuration failed and automatic cleanup was refused. Review bot '+name+'.'),{createdBotId:name,cause:error});}}throw error;}},
    async deleteBot(id){await http(`/api/profiles/${encodeURIComponent(id)}`,{method:'DELETE'});live.delete(id);},
    async stop(botId){const state=await open(botId);await rpc('session.interrupt',{session_id:state.session_id,profile:botId});},
    async generatePortrait(botId,prompt){await open(botId);const result=await rpc('image.generate',{prompt,aspect_ratio:'square',max_bytes:2_000_000});if(!result.success||!result.image_data)throw new Error(typeof result.error==='string'&&/no image generation backend configured/i.test(result.error)?'No image generation backend configured.':'Hermes image generation did not deliver image bytes. Review the provider settings before retrying.');const [,mime,base64]=/^data:([^;]+);base64,(.*)$/.exec(result.image_data)??[];if(!mime||!base64)throw new Error('Hermes returned an invalid generated image.');return this.upload(botId,{name:'generated-portrait.png',mime,data:Buffer.from(base64,'base64')});},
    async setAvatar(botId,avatar:Avatar){
      const roster=await rpc('profiles.list',{include_sessions:false});const row=roster.profiles.find((x:Wire)=>x.name===botId);if(!row)throw new Error('Unknown Hermes bot.');
      let portraitData:string|undefined;
      if(avatar.mode==='portrait'){
        if(!avatar.src.startsWith('/api/files/')||/[?#]/.test(avatar.src))throw new Error('Choose an image uploaded or generated through this app.');
        const id=decodeURIComponent(avatar.src.slice('/api/files/'.length));const file=fileValue(id);if(file.botId!==botId)throw new Error('Portrait belongs to a different Hermes bot.');if(!['image/png','image/jpeg','image/webp'].includes(file.mime))throw new Error('Hermes portraits support PNG, JPEG, and WebP.');
        const image=await this.download(id);if(image.data.length>2_000_000)throw new Error('Hermes portraits must be 2 MB or smaller.');
        portraitData=`data:${image.mime};base64,${image.data.toString('base64')}`;
      }
      const meta=row.ui_meta?.agent_interface??{};const result=await rpc('profiles.configure',{name:botId,ui_meta:{agent_interface:{...meta,avatar}},ui_meta_expected_revisions:{agent_interface:row.ui_meta_revisions?.agent_interface??0}});if(!result.ok||result.applied?.ui_meta===false||Object.keys(result.applied?.ui_meta_conflicts??{}).length)throw new Error('The Hermes avatar changed on another client. Reload before saving.');
      // Native assets do not support CAS. Never overwrite one after a rejected metadata revision.
      if(portraitData){try{const stored=await rpc('profiles.set_asset',{name:botId,asset:'avatar',data:portraitData});if(!stored.ok)throw new Error('Asset save refused.');}catch{throw new Error('The app portrait metadata was saved, but Hermes could not save its native portrait asset. Retry to finish saving.');}}
    },
    async conversation(botId):Promise<Conversation>{await connect();const value=await open(botId);const sid=value.session_id;const history=value.messages??(await rpc('session.history',{session_id:sid,profile:botId})).messages;
      const rows:Message[]=history.filter((x:Wire)=>x.display_kind!=='hidden').map((row:Wire,index:number)=>{
        const text=exposedText(row.app_tool_result)??(typeof row.app_display_text==='string'?row.app_display_text:row.text??(typeof row.content==='string'?row.content:row.context??''));
        const reasoning=typeof row.reasoning==='string'&&row.reasoning?row.reasoning:typeof row.reasoning_content==='string'?row.reasoning_content:undefined;
        const createdAt=typeof row.timestamp==='number'&&Number.isFinite(row.timestamp)?new Date(row.timestamp*1000).toISOString():undefined;
        let toolCall:ToolCall|undefined;
        if(row.role==='tool') {
          if(row.app_tool_call&&typeof row.app_tool_call.id==='string'&&typeof row.app_tool_call.name==='string') toolCall=row.app_tool_call;
          else {
            const result = row.app_tool_result ?? row.content;
            toolCall=toolDetails({name:row.name,args:row.args,...(result!==undefined?{result}:{})},String(row.tool_call_id??row.row_id??`${sid}-${index}`),'completed');
            toolCall.completedAt=createdAt;
          }
        }
        return {id:String(row.app_request_id??row.row_id??`${sid}-${index}`),role:['user','assistant','tool'].includes(row.role)?row.role:'system',text,createdAt,reasoning,toolName:row.name,toolCall,files:artifacts(botId,row)};
      });
      const state=transient.get(sid);const inflight=value.inflight??{};
      const active=!!value.info?.running||!!value.app_run_id;
      const text=inflight.assistant||(active?state?.text:undefined);
      const reasoning=typeof inflight.reasoning==='string'?inflight.reasoning:active?state?.reasoning:undefined;
      if(!active&&state){state.text='';state.reasoning='';state.tools=[];}
      if(text||reasoning)rows.push({id:`${sid}-inflight`,role:'assistant',text:text??'',reasoning});
      const requests=Array.isArray(value.open_requests)?value.open_requests:[];
      const approvals=requests.filter((x:Wire)=>x.method==='approval').map((x:Wire)=>({id:String(x.id),title:'Action approval',detail:x.params?.description??x.params?.command??'Hermes requests approval.',status:'pending' as const}));
      const attention=requests.filter((x:Wire)=>x.method!=='approval').map((x:Wire)=>({id:String(x.id),kind:x.method==='clarify'?'clarify' as const:'official' as const,title:x.method==='clarify'?'Hermes needs your answer':'Continue in the official Hermes client',detail:x.method==='clarify'?'Answer the questions to continue this task.':`Hermes is waiting for ${x.method}. Use the official client to complete credential or service setup.`,questions:x.method==='clarify'?(x.params?.questions??[]).map((q:Wire)=>({id:q.qid,prompt:q.question??'',options:q.choices})):undefined}));
      const toolCalls:ToolCall[]=Array.isArray(value.app_tool_calls)?value.app_tool_calls:state?.tools??[];
      const runningTool=toolCalls.find(tool=>tool.status==='running');
      const activity:ActivityState=value.app_interruption?'interrupted':approvals.length?'waiting':active?(runningTool||state?.state==='working'&&value.app_tool_calls===undefined?'working':'thinking'):inflight.error?'failed':inflight.interrupted?'interrupted':['done','failed','interrupted'].includes(value.app_task_state)?value.app_task_state:state&&['done','failed','interrupted'].includes(state.state)?state.state:'idle';
      return {botId,sessionId:value.canonical_stored_session_id??value.stored_session_id??value.info?.stored_session_id??sid,messages:rows,activity:{state:value.app_interruption?'interrupted':attention.length?'blocked':activity,detail:active?(runningTool?`Using ${runningTool.name}`:state?.detail):undefined,runId:value.app_run_id??value.app_interruption?.runId??undefined},toolCalls:active?toolCalls:[],approvals,attention,files:rows.flatMap(x=>x.files??[])};},
    submit(input){return submit(input);},steer(input){return submit(input,true);},
    async lookupSubmission(requestId){await connect();if(!extension)return null;const result=await rpc('agent-interface.receipt',{request_id:requestId});return result.receipt?receipt(result.receipt):null;},
    async approve(botId,approvalId,decision,_senderId){const state=await open(botId);const requests=state.open_requests??[];if(!requests.some((x:Wire)=>String(x.id)===approvalId&&x.method==='approval'))throw new Error('That approval is stale or already resolved.');const result=await rpc('request.answer',{id:approvalId,result:{choice:decision==='approved'?'once':'deny'}});if(result.status==='expired'||result.resolved===false)throw new Error('That approval expired before it was answered.');},
    async answerRequest(botId,requestId,answers){const state=await open(botId);if(!(state.open_requests??[]).some((x:Wire)=>String(x.id)===requestId&&x.method==='clarify'))throw new Error('That question is stale or already resolved.');const result=await rpc('request.answer',{id:requestId,profile:botId,result:{answers}});if(result.status==='expired')throw new Error('That question expired before it was answered.');},
    async upload(botId,input){const state=await open(botId);const result=await rpc('file.attach',{session_id:state.session_id,profile:botId,name:input.name,data_url:`data:${input.mime};base64,${input.data.toString('base64')}`});const path=result.path;if(typeof path!=='string'||!path.startsWith('/')||path.includes('\0')||path.split('/').includes('..'))throw new Error('Hermes did not return a staged file path.');return {...signFile({path,name:input.name,mime:input.mime,botId,kind:'upload',version:1}),size:input.data.length};},
    async download(id){const file=fileValue(id);const response=await http(`/api/files/download?path=${encodeURIComponent(file.path)}`);return {data:Buffer.from(await response.arrayBuffer()),name:file.name,mime:file.mime};},
    async tools(botId):Promise<Tool[]>{const result=await rpc('profiles.describe',{name:botId});return result.toolsets.map((x:Wire)=>({id:x.name,name:x.label||x.name,description:x.description,enabled:x.enabled}));},
    async setTools(botId,ids){const state=await open(botId);const catalog=await rpc('profiles.describe',{name:botId});const known=new Set(catalog.toolsets.map((x:Wire)=>x.name));if(ids.some(x=>!known.has(x)))throw new Error('Unknown Hermes toolset selected.');const disabling=catalog.toolsets.filter((x:Wire)=>x.enabled&&!ids.includes(x.name)).map((x:Wire)=>x.name);const enabling=catalog.toolsets.filter((x:Wire)=>!x.enabled&&ids.includes(x.name)).map((x:Wire)=>x.name);for(const [action,names] of [['disable',disabling],['enable',enabling]] as const){if(names.length){const result=await rpc('tools.configure',{session_id:state.session_id,action,names});if(result.unknown?.length||result.missing_servers?.length)throw new Error('Hermes could not apply all tool selections.');}}},
    async skills(botId):Promise<Skill[]>{const result=await rpc('profiles.describe',{name:botId});return result.skills.map((x:Wire)=>({id:x.name,name:x.name,description:requiredSkills.has(x.name)?'Required by Hermes':'Hermes profile skill',enabled:x.enabled,required:requiredSkills.has(x.name)}));},
    async setSkills(botId,ids){const all=await rpc('profiles.describe',{name:botId});const result=await rpc('profiles.configure',{name:botId,disabled_skills:all.skills.filter((x:Wire)=>!ids.includes(x.name)).map((x:Wire)=>x.name)});if(!result.ok)throw new Error('Hermes refused the skill selection.');},
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
            enabled:job.enabled !== false && job.state !== 'paused'});
        }
      }
      return all;
    },
    saveRoutine: routineMutation,
    async deleteRoutine(id){await http(`/api/cron/jobs/${encodeURIComponent(id)}`,{method:'DELETE'});},
    async discoverEvents(cursor):Promise<RuntimeDiscovery>{await connect();if(!extension)throw new Error('Durable discovery requires the verified Hermes add-on.');return await rpc('agent-interface.discover',{cursor}) as RuntimeDiscovery;},
    async close() {
      closed = true;
      retryAt = 0;
      diagnostic = {connected: false, code: 'closed', detail: 'The Hermes connection is closed.'};
      if (connection) disconnect(connection, new TransportError('closed', 'The Hermes connection is closed.'));
    },
  };
}
