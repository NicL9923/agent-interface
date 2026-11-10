import type { ActivityState, Bot, Conversation, FileRef, Message, SubmissionReceipt, ToolCall, TurnRows } from '../shared/types.js';
import type { ExplicitLoginRequest, SecureRequest } from '../shared/vault.js';
import { computerHandoffMethod as COMPUTER_HANDOFF, terminalCommandPattern, terminalRequestLimits, terminalRequestMethod as TERMINAL_REQUEST, type ComputerHandoff, type TerminalRequest } from '../shared/computer.js';
import { connectionRequestMethod as CONNECTION_REQUEST, requestableConnectionId, type ConnectionRequest } from '../shared/integrations.js';
import { messageOrigin, withMessageOrigins, wireOrigin } from '../shared/message-origin.js';
import { excerpt } from '../shared/event-copy.js';
import { markdownPlain } from '../shared/plain-text.js';
import { isTalkVoice } from '../shared/voice.js';
import { recommendedOption } from '../shared/recommended.js';
import type { ApprovalChoice } from '../shared/types.js';
import type { Wire } from './hermes-transport.js';

/** What a session's frames have said since its last read: streamed text, open requests and tools. */
export type LiveState = {text: string; reasoning: string; state: ActivityState; requests: Wire[]; tools: ToolCall[]; detail?: string};
export const emptyLiveState = (): LiveState => ({text: '', reasoning: '', state: 'idle', requests: [], tools: []});
// Requests a person answers, which this client must leave open rather than refuse. The add-on's
// computer handoff, terminal request and connection request are three: refusing one would settle the assistant's request at once.
const blockingRequests = ['clarify', 'sudo', 'secret', 'vault.save_login', 'vault.code', 'vault.unlock_prompt', 'connection', COMPUTER_HANDOFF, TERMINAL_REQUEST, CONNECTION_REQUEST];

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
    // message.interim announces a progress line Hermes has already saved to history, whose own row carries the
    // text through `display_commentary`. Nothing accumulates here: the frame only has to reach the caller as
    // a structural change, which every frame outside its delta list is, so open chats read the saved line now.
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
  const raw = typeof session?.preview === 'string' ? session.preview.replace(/\s+/g, ' ').trim() : '';
  if (!raw || messageOrigin({id: 'preview', role: 'user', text: raw})?.visibility === 'activity') return undefined;
  // Home shows the preview as plain text, so it carries the reply's words without its Markdown.
  const text = excerpt(markdownPlain(session!.preview), 160);
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
    ...(isTalkVoice(meta.voice) ? {voice: meta.voice} : {}),
    enabledTools: enabled(detail?.toolsets),
    enabledSkills: enabled(detail?.skills),
    enabledMcpServers: enabled(detail?.mcp_servers),
    availableMcpServers: detail?.mcp_servers?.map((x: Wire) => x.name),
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
    // The add-on's admission decision. An older add-on sends none, which stays unknown.
    ...(value.status === 'accepted' && typeof value.steering === 'boolean' ? {steered: value.steering} : {}),
  };
}
const approvalChoiceNames: readonly ApprovalChoice[] = ['once', 'session', 'always', 'deny'];
/** The choices Hermes offered for one approval, in its order. Anything else, or nothing known, reads as an older Hermes. */
export function approvalChoices(value: unknown): ApprovalChoice[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const choices = [...new Set(value.filter((choice): choice is ApprovalChoice => approvalChoiceNames.includes(choice)))];
  return choices.length ? choices : undefined;
}
// The add-on's context for a login requested by address. Every field is assistant text except the requester.
function explicitLogin(value: unknown): {explicit?: ExplicitLoginRequest} {
  const row = value as Wire;
  if (!row || typeof row !== 'object' || !['label', 'purpose', 'profile'].every(key => typeof row[key] === 'string' && row[key])) return {};
  return {explicit: {label: row.label.slice(0, 80), purpose: row.purpose.slice(0, 300), profile: row.profile.slice(0, 200),
    ...(typeof row.requesterId === 'string' && row.requesterId ? {requestedBy: {id: row.requesterId}} : {})}};
}

// Hermes's display projection of a model's progress lines, already redacted, for one assistant row.
// A bad shape shows nothing: a disabled gate sends [], and an older Hermes sends no field at all.
// No line is cut or dropped for length, count or repeats: a streamed line is matched against the saved
// ones whole (see `unseen`), so a line left out here would reappear as the live tail, as a reply.
/** The progress lines Hermes chose to show for an assistant row. Never read from its raw provider items. */
export function progressLines(row: Wire, text: string): string[] {
  if (row.role !== 'assistant' || !Array.isArray(row.display_commentary)) return [];
  // A line the row's own text already says would show twice, and that text is saved to match the stream too.
  return row.display_commentary.flatMap((value: unknown) => typeof value === 'string' && value.trim() && value.trim() !== text.trim() ? [value.trim()] : []);
}
/** The shown copies of an assistant row's reply and reasoning, which leave out its progress lines. Other rows keep their own. */
export function displayCopies(row: Wire): {text?: string; reasoning?: string | null} {
  if (row.role !== 'assistant') return {};
  return {...(typeof row.display_content === 'string' ? {text: row.display_content} : {}),
    ...(typeof row.display_reasoning === 'string' ? {reasoning: row.display_reasoning || null} : {})};
}

/**
 * Visible history rows as messages, each keeping its position among all visible rows. An assistant row
 * that carries progress lines yields each as its own `interim` message ahead of the row's message, so
 * `starts[i]` is where row `i` begins in the result, for cutting a window that Hermes counted in rows.
 */
export function historyRows(sid: string, history: Wire[], files: (row: Wire) => FileRef[]): {messages: Message[]; starts: number[]} {
  const messages: Message[] = [], starts: number[] = [];
  history.filter((x: Wire) => x.display_kind !== 'hidden').forEach((row: Wire, listed: number) => {
    // A windowed read keeps each row's position among all visible rows, so positional IDs never change.
    const index = typeof row.app_index === 'number' ? row.app_index : listed;
    // Hermes's display copies leave out progress lines that a flattened reply or reasoning also repeats.
    const copies = displayCopies(row);
    const text = exposedText(row.app_tool_result) ?? copies.text ??
      (typeof row.app_display_text === 'string' ? row.app_display_text : row.text ?? (typeof row.content === 'string' ? row.content : row.context ?? ''));
    const raw = typeof row.reasoning === 'string' && row.reasoning ? row.reasoning
      : typeof row.reasoning_content === 'string' ? row.reasoning_content : undefined;
    const reasoning = copies.reasoning === undefined ? raw : copies.reasoning ?? undefined;
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
    const id = String(row.app_request_id ?? row.row_id ?? `${sid}-${index}`);
    const runId = typeof row.app_run_id === 'string' ? row.app_run_id : undefined;
    const message: Message = {
      id,
      runId,
      role: ['user', 'assistant', 'tool'].includes(row.role) ? row.role : 'system',
      text,
      createdAt,
      reasoning,
      toolName: typeof bridged(row.name, row.args).name === 'string' ? String(bridged(row.name, row.args).name) : undefined,
      toolCall,
      files: files(row),
      ...(row.role === 'user' && row.app_steering === true ? {steered: true} : {}),
    };
    const origin = wireOrigin(message, row);
    starts.push(messages.length);
    progressLines(row, text).forEach((line, position) =>
      messages.push({id: `${id}-progress-${position}`, runId, role: 'assistant', text: line, createdAt, interim: true, ...(origin ? {origin} : {})}));
    messages.push(origin ? {...message, origin} : message);
  });
  return {messages, starts};
}
// The app sends a prompt's text, then a newline and a quoted reference for each file. The add-on saves the text without them.
// Hermes strips the whole prompt, so a file sent alone is reported as its references with no newline before the first.
const trailingFiles = /(?:(?:^|\n)@file:"(?:[^"\\]|\\.)*")+\s*$/;
/**
 * The prompt of the native turn Hermes reports running, `inflight.user`, as its saved row shows it: trimmed, without the file
 * references the add-on leaves out. An image sent alone is '', since images are staged and never referenced in the text.
 * Undefined when Hermes reports no prompt, as between native turns.
 */
export const nativePrompt = (inflight: Wire | undefined): string | undefined =>
  typeof inflight?.user === 'string' ? inflight.user.replace(trailingFiles, '').trim() : undefined;
/**
 * The row of the prompt Hermes reports for the running native turn (`nativePrompt`), looked for only among the trailing prompts
 * at or after `from`: the last prompt and, while the prompts before it are steered guidance, those, back to and including the
 * first prompt that is not guidance. The last of them whose text is `prompt`. An empty prompt, such as an image sent alone, is
 * a prompt like any other. -1 when none has it, or when no prompt is reported.
 */
export function promptRow(messages: Message[], prompt: string | undefined, from = 0): number {
  if (prompt === undefined) return -1;
  for (let index = messages.length - 1; index >= from; index--) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    if (message.text.trim() === prompt) return index;
    if (!message.steered) return -1;
  }
  return -1;
}
/**
 * Where the native turn Hermes is running starts. Hermes sets its prompt when a native turn starts, from a person's message or
 * from guidance it queued instead of steering in, and keeps it when guidance is steered into the running turn. The turn's live
 * text accumulates from that same start, so the turn's saved messages and the live reply's removal of saved text both start
 * at its prompt row (`promptRow`).
 *
 * Only steered guidance follows a running turn's prompt, so the search stops at the first prompt that is not guidance, and an
 * older prompt worded the same is never reached. When no trailing prompt has the reported text, as for a hidden prompt such as
 * a goal continuation, one Hermes has not saved yet, or no prompt reported, the boundary is the last prompt, as on main. A
 * hidden prompt's turn saves its segments after the last shown prompt, so that is right for it. A prompt not saved yet whose
 * live text starts with what the native turn before it saved under the same app run loses those words, as on main. So the
 * boundary is main's except where guidance was steered into the running turn: there the turn's own prompt keeps the
 * segments saved before the guidance out of the live reply.
 *
 * Two known gaps, each needing prompts worded exactly alike:
 * - Guidance steered in place and worded exactly like the turn's prompt is taken as the start, so a segment the turn saved
 *   before it shows again in the live reply. Main does the same.
 * - A native turn whose prompt is not shown yet repeats word for word a trailing prompt other than the last, such as the app
 *   run's first prompt after queued guidance, and its live text starts with what that prompt's turn saved first. Those
 *   words are left out of the live reply; main shows them. Rows and text cannot tell this from guidance steered into the
 *   earlier turn. It clears when Hermes saves the prompt, which is then the last match. A hidden prompt is never saved
 *   as a shown row, so for one worded like a person's prompt it lasts the turn.
 * A marker from the add-on for where a native turn starts would close both. -1 when there is no prompt at all.
 */
export function turnStart(messages: Message[], prompt: string | undefined, from = 0): number {
  const matched = promptRow(messages, prompt, from);
  return matched >= 0 ? matched : messages.findLastIndex((message, index) => index >= from && message.role === 'user');
}
/**
 * The running native turn's saved messages in a read's shown messages: from where it starts (`turnStart`) to the end, without
 * the live reply `liveId`. `windowStart` is where the read's own window begins, after the earlier messages a cut window keeps
 * for files and origins, which are never part of a turn. `after` is the message just before the turn, null when the turn starts
 * the whole history, and absent when the read began inside it. Without a prompt in the window, the whole window.
 */
export function turnRows(shown: Message[], prompt: string | undefined, liveId: string, windowStart: number, cut: boolean): TurnRows {
  const saved = shown.at(-1)?.id === liveId ? shown.slice(0, -1) : shown;
  let start = turnStart(saved, prompt, windowStart);
  if (start < 0) start = Math.min(windowStart, saved.length);
  const after = start > windowStart ? saved[start - 1].id : cut ? undefined : null;
  return {messages: saved.slice(start), ...(after !== undefined ? {after} : {})};
}
/** Visible history rows as messages. See `historyRows`. */
export const historyMessages = (sid: string, history: Wire[], files: (row: Wire) => FileRef[]): Message[] => historyRows(sid, history, files).messages;

/** The approvals and other requests an open session is waiting on. */
/**
 * `revocable` says the add-on can list and remove always-allowed commands. Without it, Always allow
 * is not offered: the app would save a grant nobody could remove here, so the server refuses it too.
 */
export function openRequests(value: Wire, sid: string, {revocable = false}: {revocable?: boolean} = {}): {approvals: Conversation['approvals']; attention: NonNullable<Conversation['attention']>} {
  const requests = Array.isArray(value.open_requests) ? value.open_requests : [];
  const approvals = requests.filter((x: Wire) => x.method === 'approval').map((x: Wire) => {
    const offered = approvalChoices(x.params?.choices);
    const choices = revocable ? offered : offered?.filter(choice => choice !== 'always');
    // Session and always grants are saved by these pattern keys, not by the one command.
    const patterns = Array.isArray(x.params?.pattern_keys)
      ? [...new Set<string>(x.params.pattern_keys.filter((key: unknown) => typeof key === 'string' && key.trim()).map((key: string) => key.slice(0, 200)))] : [];
    return {
      id: String(x.id),
      title: 'Action approval',
      detail: x.params?.description ?? x.params?.command ?? 'Hermes requests approval.',
      status: 'pending' as const,
      ...(choices ? {choices} : {}),
      ...(patterns.length ? {patterns} : {}),
      ...(typeof x.params?.command === 'string' && x.params.command.trim() && x.params.command !== x.params?.description
        ? {command: x.params.command.slice(0, 2000)} : {}),
    };
  });
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
    // The add-on's household computer handoff. Only this executor can settle it.
    const computer: ComputerHandoff | undefined = x.method === COMPUTER_HANDOFF && x.app_local_secure === true
      && typeof owner.epoch === 'string' && typeof params.reason === 'string' && typeof params.what_to_do === 'string'
      ? {...owner, reason: params.reason.slice(0, 200), whatToDo: params.what_to_do.slice(0, 300)} : undefined;
    // The add-on's ask for a person at the system terminal. Only this executor can settle it.
    const terminal: TerminalRequest | undefined = x.method === TERMINAL_REQUEST && x.app_local_secure === true
      && typeof owner.epoch === 'string' && typeof params.reason === 'string' && typeof params.what_to_do === 'string'
      && (params.command === undefined || params.command === null || typeof params.command === 'string' && terminalCommandPattern.test(params.command))
      ? {...owner, reason: params.reason.slice(0, terminalRequestLimits.reason), whatToDo: params.what_to_do.slice(0, terminalRequestLimits.whatToDo),
        ...(params.command ? {command: params.command} : {})} : undefined;
    // The add-on's ask to set up one of this assistant's connections inline. Only this executor can settle it.
    const connection: ConnectionRequest | undefined = x.method === CONNECTION_REQUEST && x.app_local_secure === true
      && typeof owner.epoch === 'string' && typeof params.connection === 'string' && requestableConnectionId.test(params.connection)
      && typeof params.reason === 'string'
      ? {...owner, connectionId: params.connection, reason: params.reason.slice(0, 200)} : undefined;
    return {
      id: String(x.id),
      kind: secure ? 'secure' as const : clarify ? 'clarify' as const : computer ? 'computer' as const : terminal ? 'terminal' as const : connection ? 'connection' as const : 'official' as const,
      title: explicit ? 'Hermes asks to save a login'
        : secure ? 'Hermes needs secure input'
        : clarify ? 'The assistant needs your answer'
        : computer ? 'Take over the computer?'
        : terminal ? 'Use the terminal?'
        : connection ? 'Set up a connection?'
        : 'Continue in the official Hermes client',
      detail: explicit ? 'Check the address and reason first. The password goes directly to the encrypted Hermes vault, never into this chat or to the assistant.'
        : secure ? 'Enter this value securely. It will go directly to Hermes without becoming a chat message.'
        : clarify ? `Answer ${(params.questions ?? []).length === 1 ? 'the question' : 'the questions'} to continue this task.`
        : computer ? computer.reason
        : terminal ? terminal.reason
        : connection ? connection.reason
        : `Hermes is waiting for ${x.method}. Use the official client to complete credential or service setup.`,
      secure,
      ...(computer ? {computer} : {}),
      ...(terminal ? {terminal} : {}),
      ...(connection ? {connection} : {}),
      questions: clarify ? (params.questions ?? []).map((q: Wire) => {
        const options: string[] | undefined = Array.isArray(q.choices) ? q.choices.filter((choice: unknown) => typeof choice === 'string') : undefined;
        const recommended = recommendedOption(options);
        return {id: q.qid, prompt: q.question ?? '', options,
          // Hermes takes several picks as one JSON array answer; a free-text question has nothing to pick.
          ...(q.multi_select === true && options?.length ? {multiple: true} : {}),
          ...(recommended !== undefined ? {recommended} : {})};
      }) : undefined,
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
  // The run ID proves rows belong to this task, and queued follow-ups share it, so only
  // rows after the native turn's prompt count (`turnStart`): guidance steered into the
  // turn keeps its segments, and guidance Hermes queued starts a native turn of its own.
  // A prompt none of the trailing prompts has falls back to the last prompt, as on main. Without a run ID, nothing is removed.
  const run = active && typeof value.app_run_id === 'string' ? value.app_run_id : undefined;
  const prompt = nativePrompt(inflight);
  // A finished turn can leave its whole reply in the snapshot after history saved it. Remove
  // the saved turn too, unless the snapshot names a prompt none of the trailing prompts has.
  const savedPrompt = !prompt || promptRow(rows, prompt) >= 0;
  const lastTurn = rows.slice(turnStart(rows, prompt) + 1).filter(row => row.role === 'assistant');
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

