import type { ActivityState, Bot, Conversation, FileRef, Message, SubmissionReceipt, ToolCall } from '../shared/types.js';
import type { ExplicitLoginRequest, SecureRequest } from '../shared/vault.js';
import { messageOrigin, withMessageOrigins, wireOrigin } from '../shared/message-origin.js';
import type { Wire } from './hermes-transport.js';

/** What a session's frames have said since its last read: streamed text, open requests and tools. */
export type LiveState = {text: string; reasoning: string; state: ActivityState; requests: Wire[]; tools: ToolCall[]; detail?: string};
export const emptyLiveState = (): LiveState => ({text: '', reasoning: '', state: 'idle', requests: [], tools: []});
const blockingRequests = ['clarify', 'sudo', 'secret', 'vault.save_login', 'vault.code', 'vault.unlock_prompt', 'connection'];

/**
 * Removes persisted segments from the front of accumulated live text. Whitespace
 * is ignored while matching, because streamed and stored separators differ. A
 * mismatch keeps the remainder.
 */
export function unseen(live: string | undefined, segments: (string | undefined)[]): string | undefined {
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
export function exposedText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value !== undefined && value !== null) return JSON.stringify(value, null, 2);
  return undefined;
}
// Tool search runs deferred and connector tools through one bridge tool, tool_call. Show the tools it
// ran, accepting every form Hermes's own normalizer does. One call shows as itself, arguments included.
export function bridged(name: unknown, args: unknown): {name: unknown; args: unknown} {
  if (name !== 'tool_call') return {name, args};
  const parse = (value: unknown) => {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return value; }
  };
  const value = parse(args);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {name, args};
  const row = value as Wire;
  let calls = row.calls === undefined
    ? row.name ? [{name: row.name, arguments: row.arguments}] : []
    : parse(row.calls);
  if (calls && typeof calls === 'object' && !Array.isArray(calls)) calls = [calls];
  const entries = (Array.isArray(calls) ? calls : [])
    .filter((call): call is Wire => !!call && typeof call === 'object' && typeof call.name === 'string' && !!call.name);
  if (!entries.length) return {name, args};
  if (entries.length === 1) return {name: entries[0].name, args: parse(entries[0].arguments) ?? {}};
  return {name: [...new Set(entries.map(call => call.name))].join(', '), args};
}
export function unbridged(call: ToolCall): ToolCall {
  const shown = bridged(call.name, call.arguments);
  return shown.name === call.name ? call : {...call, name: shown.name as string, arguments: exposedText(shown.args)};
}
export function toolDetails(payload: Wire, id: string, status: ToolCall['status'], previous?: ToolCall): ToolCall {
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

/**
 * Applies one session frame to its live state. Returns false for a Hermes request this client
 * does not handle, which the caller declines. `fallbackSeq` numbers a tool sent without an ID.
 */
export function applyFrame(state: LiveState, frame: Wire, fallbackSeq: number): boolean {
  const params = frame.params ?? {};
  if (frame.method === 'event') {
    const payload = params.payload ?? {};
    const type = params.type;
    if (type === 'message.start') {
      state.text = '';
      state.reasoning = '';
      state.detail = undefined;
      state.tools = [];
      state.state = 'thinking';
    }
    if (type === 'message.delta') {
      state.text += payload.delta ?? payload.text ?? '';
      if (!state.tools.some(tool => tool.status === 'running')) state.state = 'thinking';
    }
    if (['reasoning.delta', 'reasoning.available'].includes(type) && typeof payload.text === 'string') {
      if (type !== 'reasoning.available' || !state.reasoning.endsWith(payload.text)) state.reasoning += payload.text;
    }
    // thinking.delta carries only Hermes's terminal spinner line, a kaomoji and a verb such as
    // "(⌐■_■) ruminating...". The animated avatar already shows thinking, so its text is dropped.
    if (type === 'tool.start' || type === 'tool.complete') {
      const id = typeof payload.tool_id === 'string' ? payload.tool_id : `live-tool-${params.seq ?? fallbackSeq}`;
      const existing = state.tools.find(tool => tool.id === id);
      const tool = toolDetails(payload, id, type === 'tool.start' ? 'running' : 'completed', existing);
      if (existing) Object.assign(existing, tool); else state.tools.push(tool);
      state.state = state.tools.some(tool => tool.status === 'running') ? 'working' : 'thinking';
      state.detail = typeof payload.summary === 'string' ? payload.summary : type === 'tool.start' ? `Using ${tool.name}` : undefined;
    }
    if (type === 'tool.generating' && typeof payload.name === 'string') state.detail = `Preparing ${payload.name}`;
    if (type === 'status.update' && typeof payload.text === 'string') state.detail = payload.text;
    if (type === 'message.complete') {
      state.text = '';
      state.reasoning = '';
      state.detail = undefined;
      state.state = payload.status === 'error' ? 'failed' : payload.status === 'interrupted' ? 'interrupted' : 'done';
      state.tools = [];
    }
    if (type === 'error') state.state = 'failed';
    if (type === 'request.cancel') state.requests = state.requests.filter(x => x.id !== payload.id);
  } else if (frame.id && frame.method) {
    if (frame.method === 'approval') {
      state.requests = state.requests.filter(x => x.id !== frame.id);
      state.requests.push(frame);
      state.state = 'waiting';
    } else if (blockingRequests.includes(frame.method)) {
      state.requests.push(frame);
      state.state = 'blocked';
    } else return false;
  }
  return true;
}

export function preview(session?: Wire): Bot['lastMessage'] {
  const text = typeof session?.preview === 'string' ? session.preview.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  if (!text || messageOrigin({id: 'preview', role: 'user', text})?.visibility === 'activity') return undefined;
  const at = typeof session?.last_active === 'number' && Number.isFinite(session.last_active)
    ? new Date(session.last_active * 1000).toISOString()
    : undefined;
  return at ? {text, at} : {text};
}
/** A profile row, with its description when settings need writable configuration. */
export function bot(row: Wire, activity: ActivityState, detail?: Wire): Bot {
  const meta = row.ui_meta?.agent_interface ?? {};
  const enabled = (rows: Wire[] | undefined) => rows?.filter((x: Wire) => x.enabled).map((x: Wire) => x.name);
  return {
    id: row.name,
    name: meta.name || row.display_name || row.ui_meta?.['hermes-bots']?.title || row.name,
    description: row.description,
    instructions: detail ? detail.soul ?? '' : undefined,
    model: row.model ?? detail?.model?.default ?? 'Inherited',
    provider: row.provider ?? detail?.model?.provider,
    shared: meta.shared ?? true,
    avatar: meta.avatar,
    enabledTools: enabled(detail?.toolsets),
    enabledSkills: enabled(detail?.skills),
    enabledMcpServers: enabled(detail?.mcp_servers),
    sessionId: row.canonical_session?.resolved_id,
    activity,
    lastMessage: preview(row.canonical_session),
  };
}
export function receipt(value: Wire): SubmissionReceipt {
  return {
    requestId: value.requestId,
    status: value.status,
    runId: value.runId,
    ...(value.userRowId != null ? {messageId: String(value.userRowId)} : {}),
    message: value.message,
  };
}
// The add-on's context for a login requested by address. Every field is assistant text except the requester.
function explicitLogin(value: unknown): {explicit?: ExplicitLoginRequest} {
  const row = value as Wire;
  if (!row || typeof row !== 'object' || !['label', 'purpose', 'profile'].every(key => typeof row[key] === 'string' && row[key])) return {};
  return {explicit: {label: row.label.slice(0, 80), purpose: row.purpose.slice(0, 300), profile: row.profile.slice(0, 200),
    ...(typeof row.requesterId === 'string' && row.requesterId ? {requestedBy: {id: row.requesterId}} : {})}};
}

/** Visible history rows as messages, each keeping its position among all visible rows. */
export function historyMessages(sid: string, history: Wire[], files: (row: Wire) => FileRef[]): Message[] {
  return history.filter((x: Wire) => x.display_kind !== 'hidden').map((row: Wire, listed: number) => {
    // A windowed read keeps each row's position among all visible rows, so positional IDs never change.
    const index = typeof row.app_index === 'number' ? row.app_index : listed;
    const text = exposedText(row.app_tool_result) ??
      (typeof row.app_display_text === 'string' ? row.app_display_text : row.text ?? (typeof row.content === 'string' ? row.content : row.context ?? ''));
    const reasoning = typeof row.reasoning === 'string' && row.reasoning ? row.reasoning
      : typeof row.reasoning_content === 'string' ? row.reasoning_content : undefined;
    const createdAt = typeof row.timestamp === 'number' && Number.isFinite(row.timestamp) ? new Date(row.timestamp * 1000).toISOString() : undefined;
    let toolCall: ToolCall | undefined;
    if (row.role === 'tool') {
      if (row.app_tool_call && typeof row.app_tool_call.id === 'string' && typeof row.app_tool_call.name === 'string') toolCall = unbridged(row.app_tool_call);
      else {
        const result = row.app_tool_result ?? row.content;
        toolCall = toolDetails({name: row.name, args: row.args, ...(result !== undefined ? {result} : {})},
          String(row.tool_call_id ?? row.row_id ?? `${sid}-${index}`), 'completed');
        toolCall.completedAt = createdAt;
      }
    }
    const message: Message = {
      id: String(row.app_request_id ?? row.row_id ?? `${sid}-${index}`),
      runId: typeof row.app_run_id === 'string' ? row.app_run_id : undefined,
      role: ['user', 'assistant', 'tool'].includes(row.role) ? row.role : 'system',
      text,
      createdAt,
      reasoning,
      toolName: typeof bridged(row.name, row.args).name === 'string' ? String(bridged(row.name, row.args).name) : undefined,
      toolCall,
      files: files(row),
    };
    const origin = wireOrigin(message, row);
    return origin ? {...message, origin} : message;
  });
}

/** The approvals and other requests an open session is waiting on. */
export function openRequests(value: Wire, sid: string): {approvals: Conversation['approvals']; attention: NonNullable<Conversation['attention']>} {
  const requests = Array.isArray(value.open_requests) ? value.open_requests : [];
  const approvals = requests.filter((x: Wire) => x.method === 'approval').map((x: Wire) => ({
    id: String(x.id),
    title: 'Action approval',
    detail: x.params?.description ?? x.params?.command ?? 'Hermes requests approval.',
    status: 'pending' as const,
  }));
  const attention = requests.filter((x: Wire) => x.method !== 'approval').map((x: Wire) => {
    const params = x.params ?? {};
    let secure: SecureRequest | undefined;
    const owner = {epoch: value.executor_epoch, sessionId: sid};
    if (x.app_local_secure === true && typeof owner.epoch === 'string' && typeof owner.sessionId === 'string') {
      if (x.method === 'vault.save_login' && typeof params.origin === 'string' && typeof params.site === 'string')
        secure = {...owner, method: x.method, origin: params.origin, site: params.site, ...explicitLogin(x.app_credential)};
      if (x.method === 'vault.code')
        secure = {...owner, method: x.method, site: typeof params.site === 'string' ? params.site : undefined, hint: typeof params.hint === 'string' ? params.hint : undefined};
      if (x.method === 'vault.unlock_prompt' && ['onepassword', 'bitwarden'].includes(params.backend) && typeof params.display_name === 'string')
        secure = {...owner, method: x.method, backend: params.backend, displayName: params.display_name};
      if (x.method === 'secret' && typeof params.env_var === 'string' && typeof params.prompt === 'string')
        secure = {...owner, method: x.method, envVar: params.env_var, prompt: params.prompt};
    }
    const explicit = secure?.method === 'vault.save_login' && !!secure.explicit;
    const clarify = x.method === 'clarify';
    return {
      id: String(x.id),
      kind: secure ? 'secure' as const : clarify ? 'clarify' as const : 'official' as const,
      title: explicit ? 'Hermes asks to save a login'
        : secure ? 'Hermes needs secure input'
        : clarify ? 'Hermes needs your answer'
        : 'Continue in the official Hermes client',
      detail: explicit ? 'Check the address and reason first. The password goes directly to the encrypted Hermes vault, never into this chat or to the assistant.'
        : secure ? 'Enter this value securely. It will go directly to Hermes without becoming a chat message.'
        : clarify ? 'Answer the questions to continue this task.'
        : `Hermes is waiting for ${x.method}. Use the official client to complete credential or service setup.`,
      secure,
      questions: clarify ? (params.questions ?? []).map((q: Wire) => ({id: q.qid, prompt: q.question ?? '', options: q.choices})) : undefined,
    };
  });
  return {approvals, attention};
}

/** The unpersisted tail of a running turn as one message, or an empty one when nothing is unsaved. */
export function inflightMessage(value: Wire, rows: Message[], state: LiveState | undefined): Message {
  const sid = value.session_id;
  const inflight = value.inflight ?? {};
  const active = !!value.info?.running || !!value.app_run_id;
  // Live text and reasoning accumulate across the whole turn, while each segment
  // before a tool call is already a history row. Show only the unpersisted tail.
  // The run ID proves rows belong to this task, and queued follow-ups share it, so
  // only rows after the latest prompt count. Without a run ID, nothing is removed.
  const run = active && typeof value.app_run_id === 'string' ? value.app_run_id : undefined;
  const lastPrompt = rows.findLastIndex(row => row.role === 'user');
  const lastTurn = rows.slice(lastPrompt + 1).filter(row => row.role === 'assistant');
  // A finished turn can leave its whole reply in the snapshot after history saved it. Remove
  // the saved turn too, unless the snapshot names a newer prompt than the last saved one.
  // The snapshot's prompt keeps file references that the saved display text drops.
  const prompt = typeof inflight.user === 'string' ? inflight.user.replace(/(?:\n@file:"(?:[^"\\]|\\.)*")+\s*$/, '').trim() : '';
  const savedPrompt = !prompt || prompt === rows[lastPrompt]?.text.trim();
  const persisted = run ? lastTurn.filter(row => row.runId === run) : !active && savedPrompt ? lastTurn : [];
  const text = unseen(inflight.assistant || (active ? state?.text : undefined), persisted.map(row => row.text));
  const reasoning = unseen(typeof inflight.reasoning === 'string' ? inflight.reasoning : active ? state?.reasoning : undefined,
    persisted.map(row => row.reasoning));
  let message: Message = {id: `${sid}-inflight`, role: "assistant", text: ""};
  if (text || reasoning) {
    const origin = !savedPrompt
      ? wireOrigin({id: 'inflight-prompt', role: 'user', text: prompt}, inflight) ?? {kind: 'human' as const, visibility: 'conversation' as const}
      : undefined;
    message = {id: `${sid}-inflight`, role: 'assistant', text: text ?? '', reasoning,
      ...(origin ? {origin: {...origin, visibility: origin.kind === 'agent' || origin.kind === 'diagnostic' ? 'activity' : 'conversation'}} : {})};
  }
  // Inherit the saved prompt origin exactly as a conversation read does.
  return message.text || message.reasoning ? withMessageOrigins([...rows, message]).at(-1)! : message;
}
