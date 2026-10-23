import type { RuntimeStatus } from '../shared/types.js';
import { httpError } from './http-error.js';
import { isolatedQualification, qualifiedReceipt } from './hermes-qualification.js';

// The only Hermes wire boundary. Dynamic records are upstream's versioned JSON-RPC payloads.
export type Wire = Record<string, any>;
export interface HermesOptions {
  url?: string;
  token?: string;
  authMode?: 'static' | 'service';
  qualificationFile?: string;
  qualification?: {revision: string; home: string};
}
type DiagnosticCode = NonNullable<RuntimeStatus['code']>;
export class TransportError extends Error {
  constructor(readonly code: DiagnosticCode, message: string, readonly rpcCode?: number, readonly rpcMessage?: string) {
    super(message);
  }
}
export type Connection = {
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
/** What the verified add-on revision supports, learned on each connection. */
export interface Contract {
  extension: boolean;
  // An add-on that binds logins requested by address to their member. Earlier ones refuse the extra field.
  explicitCredentials: boolean;
  canonicalSubmit: boolean;
  incrementalDiscovery: boolean;
  requiredSkills: Set<string>;
}
export interface TransportHooks {
  /** A frame that is not a response: a session event or a request from Hermes. */
  frame(frame: Wire, connection: Connection): void;
  /** Runs after a dropped connection's requests fail. A verified one may have carried frames. */
  disconnected(verified: boolean): void;
  /** Runs once a new connection's contract is verified. */
  connected(): void;
  /** Whether anything is watching, so a dropped socket reconnects without waiting for a request. */
  watching(): boolean;
}

const qualifiedRevisions = new Set(['b9cb268deffc97946ec11645aa622a7353dd0591', 'd23cc6b06455b8551fb6f61d3cad040a0e82f5b6']);
const readMethods = new Set([
  'agent-interface.capabilities', 'agent-interface.receipt', 'agent-interface.discover',
  'profiles.list', 'profiles.describe', 'session.history', 'model.options',
  'groups.capabilities', 'groups.list', 'groups.state', 'groups.log',
]);
// A quiet socket is checked in the background, so no request waits on a dead one,
// and open chats reconnect without waiting for a request.
const HEARTBEAT_MS = 10_000;

export const unavailable = () => new TransportError('unreachable', 'Hermes is disconnected. Check its supervised gateway and connection settings.');
const closedError = () => new TransportError('closed', 'The Hermes connection is closed.');

export function createHermesTransport(options: HermesOptions, hooks: TransportHooks) {
  let connection: Connection | undefined;
  let connecting: Promise<void> | undefined;
  let reconnecting: Promise<RuntimeStatus> | undefined;
  let serial = 0;
  let closed = false;
  let failures = 0;
  let retryAt = 0;
  let lastConnectedAt: string | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const pending = new Map<number, Pending>();
  const reads = new Map<string, Promise<Wire>>();
  const contract: Contract = {
    extension: false,
    explicitCredentials: false,
    canonicalSubmit: false,
    incrementalDiscovery: false,
    requiredSkills: new Set(),
  };
  const serviceAuth = options.authMode === 'service';
  const servicePath = (path: string) => serviceAuth ? '/api/agent-interface/service/' + path.slice('/api/'.length) : path;
  const authHeaders = (): Record<string, string> => serviceAuth
    ? {'Authorization': `Bearer ${options.token}`}
    : {'X-Hermes-Session-Token': options.token!};

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
    contract.extension = false;
    contract.canonicalSubmit = false;
    contract.incrementalDiscovery = false;
    // A reconnected socket receives a session's frames only after reopening it. Watchers reload,
    // but failed attempts during an outage, which never carried frames, stay quiet.
    hooks.disconnected(current.verified);
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
    contract.extension = true;
    contract.explicitCredentials = capabilities.explicit_credentials === true;
    contract.canonicalSubmit = capabilities.canonical_submit === true;
    contract.incrementalDiscovery = capabilities.incremental_discovery === true;
    contract.requiredSkills = new Set(Array.isArray(capabilities.essential_skills)
      ? capabilities.essential_skills.filter((value: unknown) => typeof value === 'string')
      : []);
  }
  async function socketUrl(): Promise<URL> {
    const url = new URL('/api/ws', origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    if (serviceAuth) {
      let response: Response;
      try {
        response = await fetch(new URL('/api/agent-interface/service-ticket', origin), {
          method: 'POST', headers: authHeaders(), signal: AbortSignal.timeout(5_000), redirect: 'error',
        });
      } catch { throw unavailable(); }
      if (!response.ok) {
        const refused = response.status === 401 || response.status === 403;
        throw new TransportError(refused ? 'unauthorized' : 'unreachable',
          refused ? 'Hermes rejected the private service credential.' : 'Hermes service ticket could not be issued.');
      }
      const body = await response.json() as Wire;
      if (typeof body.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.ticket))
        throw new TransportError('incompatible', 'Hermes returned an invalid service upgrade ticket.');
      if (closed) throw closedError();
      url.searchParams.set('ticket', body.ticket);
    } else url.searchParams.set('token', options.token!);
    return url;
  }
  /** Becomes the current connection at once, so a handshake deadline can drop it while it opens. */
  function adopt(url: URL): Connection {
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch { throw unavailable(); }
    connection = {ws, verified: false, lastReceivedAt: Date.now()};
    return connection;
  }
  async function opened(owned: Connection): Promise<void> {
    const ws = owned.ws;
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
  }
  async function connect(): Promise<void> {
    if (closed) throw closedError();
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
          current = adopt(await socketUrl());
          await opened(current);
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
        if (fresh) hooks.connected();
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
  function startHeartbeat(): void {
    if (heartbeat || closed) return;
    heartbeat = setInterval(() => {
      if (closed || connecting) return;
      const current = connection;
      if (current?.verified && current.ws.readyState === WebSocket.OPEN) {
        if (Date.now() - current.lastReceivedAt >= HEARTBEAT_MS) void rpc('agent-interface.capabilities').catch(() => {});
      } else if (hooks.watching() && retryAt <= Date.now()) void connect().catch(() => {});
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
              unauthorized
                ? 'Hermes rejected the session token. Update the server-side token and reconnect.'
                : `Hermes refused the request (code ${typeof code === 'number' ? code : 'unknown'}). Review before retrying.`,
              typeof code === 'number' ? code : undefined,
              typeof frame.error.message === 'string' ? frame.error.message.slice(0, 500) : undefined);
            item.reject(error);
            if (unauthorized) disconnect(current, error);
          } else item.resolve(frame.result ?? {});
        }
        continue;
      }
      hooks.frame(frame, current);
    }
  }
  /** Declines a Hermes request this client does not handle. */
  function refuse(current: Connection, id: unknown): void {
    if (current.ws.readyState !== WebSocket.OPEN) return;
    try {
      current.ws.send(JSON.stringify({jsonrpc: '2.0', id, error: {code: -32601, message: 'This client does not implement this official-client bridge.'}}));
    } catch { disconnect(current, unavailable()); }
  }
  /** share=false never joins an in-flight read, as a read that must see a just-made edit needs. */
  async function rpc(method: string, params: Wire = {}, share = true): Promise<Wire> {
    await connect();
    const current = connection;
    if (!current?.verified || current.ws.readyState !== WebSocket.OPEN) {
      if (current) disconnect(current, unavailable());
      throw unavailable();
    }
    const key = share && (readMethods.has(method) || method === 'image.generate' && params.probe === true)
      ? `${method}:${JSON.stringify(params)}`
      : undefined;
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
    const timeout = readMethods.has(method) || method === 'client.capabilities' || method === 'image.generate' && params.probe === true
      ? 10_000
      : 45_000;
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
    if (closed) throw closedError();
    if (configurationError) throw configurationError;
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      const credential = path === '/api/agent-interface/credentials' || path === '/api/agent-interface/experience' || path === '/api/agent-interface/automation';
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
      throw httpError(502, "Hermes rejected this server's credential. You are still signed in. Ask whoever runs the server to update its Hermes token, then reconnect.", {code: 'hermes_unauthorized', expose: true});
    }
    if (!response.ok && path.startsWith('/api/audio/') && response.status === 400) {
      await response.body?.cancel();
      throw httpError(409, 'Voice is unavailable. Check the speech provider in the native Hermes dashboard.');
    }
    if (!response.ok && path === '/api/agent-interface/credentials') {
      await response.body?.cancel();
      throw httpError(response.status, 'Hermes could not confirm this credential operation. Refresh its status before trying again.');
    }
    if (!response.ok && ['/api/agent-interface/integrations', '/api/agent-interface/experience', '/api/agent-interface/automation'].includes(path)) {
      const detail = await response.json().catch(() => ({})) as {error?: unknown};
      throw httpError(response.status, typeof detail.error === 'string' ? detail.error.slice(0, 1000) : 'Hermes could not finish this connection operation.');
    }
    if (!response.ok && path.startsWith('/api/cron/jobs') && [400, 404, 409, 422].includes(response.status)) {
      const detail = await response.json().catch(() => ({})) as {detail?: unknown; error?: unknown};
      const message = typeof detail.detail === 'string' ? detail.detail
        : typeof detail.error === 'string' ? detail.error
        : 'Hermes could not save this routine. Review its settings and try again.';
      // Native script validation includes absolute profile paths. Keep the useful
      // reason, but don't expose the host's directory layout to clients.
      const safeMessage = message.replace(/(^|[\s("'=:])\/[^\s"'<>]*/g, '$1[server path]');
      throw httpError(response.status, safeMessage.slice(0, 1000));
    }
    if (!response.ok) throw new TransportError('unreachable', `Hermes HTTP ${response.status}: request failed.`);
    return response;
  }
  async function status(): Promise<RuntimeStatus> {
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
      return status();
    })();
    reconnecting = attempt;
    try { return await attempt; } finally { if (reconnecting === attempt) reconnecting = undefined; }
  }
  function close(): void {
    closed = true;
    clearInterval(heartbeat);
    retryAt = 0;
    diagnostic = {connected: false, code: 'closed', detail: 'The Hermes connection is closed.'};
    if (connection) disconnect(connection, closedError());
  }
  return {
    contract,
    connect,
    rpc,
    http,
    refuse,
    disconnect,
    status,
    reconnect,
    close,
    get connection() { return connection; },
    get origin() { return origin; },
    /** The latest request ID, which numbers a live tool that Hermes sent without one. */
    get serial() { return serial; },
    /** Why Hermes is unavailable, for capabilities that depend on it. */
    get detail() { return diagnostic.detail; },
  };
}
export type HermesTransport = ReturnType<typeof createHermesTransport>;
