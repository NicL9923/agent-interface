import { approvalAttempt, type ApprovalAttempt } from "./approval-attempt";
import { matchCombo, shortcuts } from "./shortcuts";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefCallback, RefObject } from "react";
import type { ActivityState, Approval, Bootstrap, Bot, FileRef, Message, ToolCall } from "../shared/types";
import { ApiError, request as apiRequest } from "../client-api";
import { Avatar } from "../components/Avatar";
import { avatarProp } from "../components/avatar-motion";
import { MessageMarkdown, StreamingMarkdown } from "../components/MessageMarkdown";
import { ConnectionPanel } from "../components/ConnectionPanel";
import { Icon } from "../components/Icon";
import { NotificationOnboarding } from "../components/DeviceNotifications";
import type { useDeviceNotifications } from "../components/use-device-notifications";
import { SecureRequestCard } from "../components/SecureRequestCard";
import { AgentExchange, isAgentExchange } from "../components/AgentExchange";
import { ActionReceipt } from "../components/ActionReceipt";
import { When } from "../components/When";
import { receipt } from "../shared/discovery";
import { MAX_ATTACHMENTS } from "../shared/uploads";
import { isActivityMessage, messageOrigin, withMessageOrigins } from "../shared/message-origin";
import type { SavedConversation } from "./storage";
import type { SentEcho } from "./sent-echo";
import type { useConversation } from "./use-conversation";
import { useStableCallback } from "./use-stable-callback";
import { useTurnRetry } from "./use-turn-retry";
import { AttentionCard } from "./AttentionCard";
import { FindBar } from "./FindBar";
import { QuoteSelection, ReplyActions, TranscriptTools } from "./ReplyActions";
import { attentionAnchor, foldSummary, isHumanMessage, quoteBlock, turnDuration, workGroups } from "./transcript-logic";
import "./transcript.css";
const activeStates: ActivityState[] = ["thinking", "working", "waiting", "blocked"];
export function Conversation({ boot, selected, botId, conversation, canonical, echo, state, showActivity, avatarState, connectionLost, offline, appUnavailable, checkingConnection, reconnect, error, setError, notifications, scroll, endSpace, content, history, reply, onScroll, onCreate, onDraft }: {
  boot: Bootstrap;
  selected?: Bot;
  botId: string;
  /** Includes the echo of a message still on its way, which is drawn as sending. */
  conversation: SavedConversation | null;
  /** The conversation as Hermes has it, without messages still drawn from this device. */
  canonical: SavedConversation | null;
  echo: SentEcho | null;
  state: ActivityState;
  showActivity: boolean;
  avatarState: ActivityState;
  connectionLost: boolean;
  offline: boolean;
  appUnavailable: boolean;
  checkingConnection: boolean;
  reconnect(): Promise<void>;
  error: string;
  setError(message: string): void;
  notifications: ReturnType<typeof useDeviceNotifications>;
  scroll: RefObject<HTMLDivElement | null>;
  endSpace: RefObject<HTMLDivElement | null>;
  content: RefCallback<HTMLDivElement>;
  history: ReturnType<typeof useConversation>["history"];
  reply: ReturnType<typeof useConversation>["reply"];
  onScroll(): void;
  onCreate(): void;
  /** Adds text to the draft. False while the draft is on its way, when it must not change. */
  /** Adds to the person's draft, never replacing it. False while a send is on its way; otherwise how many files didn't fit. */
  onDraft(text: string, files?: FileRef[]): number | false;
}) {
  const prefs = boot.preferences;
  const advanced = prefs.presentation === "advanced";
  const blocks = useMemo(() => turns(conversation, advanced), [conversation, advanced]);
  const actions: Record<ActivityState, string> = {
    idle: "ready", thinking: "thinking", working: "working", waiting: "waiting for approval",
    blocked: "waiting for your input", done: "done", failed: "having trouble", interrupted: "stopped", disconnected: "reconnecting",
  };
  const detail = conversation?.activity.detail?.trim().replace(/[.…]+$/, "");
  const runningCall = connectionLost ? undefined : conversation?.toolCalls?.findLast(call => call.status === "running");
  const prop = avatarProp(runningCall?.name);
  const action = offline ? "offline" : !connectionLost && state === "working" && detail ? detail.charAt(0).toLowerCase() + detail.slice(1) : actions[state];
  const running = !!conversation && activeStates.includes(conversation.activity.state);
  // The running turn's one live row: the current tool's receipt, and in Advanced, the latest reasoning line.
  const liveTool = runningCall ? `${receipt(runningCall).label} · ${runningCall.name}` : undefined;
  const liveThought = advanced && running && !connectionLost ? latestReasoning(conversation!.messages) : undefined;
  // Short results of reply actions, each its own node so a repeat still reads out.
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);
  const announce = useStableCallback((text: string) => setNotice(previous => ({ id: (previous?.id ?? 0) + 1, text })));
  const quote = useStableCallback((text: string) => {
    if (onDraft(`${quoteBlock(text)}\n\n`) === false) return announce("Your message is still sending. Quote once it has gone.");
    announce("Quoted in your message.");
    // The composer is outside the transcript; its field takes the caret after the quote.
    requestAnimationFrame(() => {
      const field = document.getElementById("message");
      if (!(field instanceof HTMLTextAreaElement)) return;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    });
  });
  // A refused retry's words go back in the message box beside whatever the person already wrote.
  const putBack = useStableCallback((original: Message) => {
    const left = onDraft(original.text, original.files);
    if (left === false) return announce("Your message is still sending. Try again once it has gone.");
    announce(left ? `Your message is in the message box, without ${left} of its files: a message can carry only ${MAX_ATTACHMENTS}.` : "Your message is in the message box.");
    requestAnimationFrame(() => document.getElementById("message")?.focus());
  });
  const tools = useMemo<TranscriptTools>(() => ({ botId, sessionId: conversation?.sessionId, unavailable: connectionLost, quote, announce }),
    [botId, conversation?.sessionId, connectionLost, quote, announce]);
  const frame = useRef<HTMLDivElement>(null);
  const retry = useTurnRetry({ botId, userId: boot.user.id, canonical, blocked: !!echo || connectionLost || !boot.capabilities.chat.supported,
    resendable: boot.capabilities.idempotency.supported, report: setError });
  // Find in chat takes Cmd/Ctrl+F while a conversation is on screen. Covered by a dialog or the
  // phone's assistant list, the browser's own find stays.
  const [finding, setFinding] = useState(false);
  const findReturn = useRef<HTMLElement | null>(null);
  const findable = !!selected && !!conversation;
  useEffect(() => setFinding(false), [botId]);
  useEffect(() => {
    if (!findable) return;
    const open = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matchCombo(event, shortcuts.find)) return;
      const view = scroll.current;
      if (!view || view.closest("[inert]") || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      const field = frame.current?.querySelector<HTMLInputElement>(".find-bar input");
      if (field) return field.select();
      findReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setFinding(true);
    };
    // Assistant details and the palette ask for find in chat by event, once this chat is on screen.
    const requested = (event: Event) => {
      if ((event as CustomEvent<{ botId?: string }>).detail?.botId !== botId) return;
      const field = frame.current?.querySelector<HTMLInputElement>(".find-bar input");
      if (field) return field.select();
      findReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setFinding(true);
    };
    window.addEventListener("keydown", open);
    window.addEventListener("wildbots:find", requested);
    return () => { window.removeEventListener("keydown", open); window.removeEventListener("wildbots:find", requested); };
  }, [findable, scroll, botId]);
  const closeFind = useStableCallback(() => {
    setFinding(false);
    const back = findReturn.current;
    findReturn.current = null;
    (back?.isConnected ? back : scroll.current)?.focus({ preventScroll: true });
  });
  return (
    <TranscriptTools.Provider value={tools}>
      {error && (
        <div className="notice error" role="alert">
          {error}
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      <NotificationOnboarding notifications={notifications} />
      <div className="transcript-frame" ref={frame}>
      {finding && findable && <FindBar botId={botId} conversation={conversation} scroll={scroll} openMessage={history.openMessage} onClose={closeFind} />}
      {/* Always mounted, so a screen reader is already watching when a reply lands. */}
      {/* Each reply is its own node, so a repeat of the same words still reads out. */}
      <span className="sr-only" role="status">
        {selected && reply?.botId === botId && <span key={reply.id}>{`${selected.name} replied: ${reply.text}`}</span>}
      </span>
      <span className="sr-only" role="status">{notice && <span key={notice.id}>{notice.text}</span>}</span>
      <div
        className="transcript"
        ref={scroll}
        onScroll={onScroll}
        role="region"
        aria-label="Conversation"
        tabIndex={0}
      >
      <div className="transcript-content" ref={content}>
        {!selected && connectionLost ? (
          <ConnectionPanel connection={boot.connection} offline={offline}
            appUnavailable={appUnavailable} busy={checkingConnection} retry={() => void reconnect()} />
        ) : !selected ? (
          <div className="empty-state">
            <Avatar size={100} />
            <h2>A little less to carry.</h2>
            <p>
              Return to the same assistants, with the context and
              conversations you share.
            </p>
            <button
              className="primary"
              disabled={!boot.capabilities.botConfiguration.supported}
              title={boot.capabilities.botConfiguration.reason}
              onClick={onCreate}
            >
              Create an assistant
            </button>
            {!boot.capabilities.botConfiguration.supported && (
              <p className="muted">
                Assistant setup is unavailable while Hermes is disconnected.
              </p>
            )}
            {prefs.presentation === "advanced" && (
              <details className="activity-details">
                <summary>Connection details</summary>
                <p>{boot.connection.detail}</p>
              </details>
            )}
          </div>
        ) : !conversation && !connectionLost ? (
          <HistorySkeleton />
        ) : blocks.length ? (
          <>
            <HistoryEdge history={history} scroll={scroll} name={selected.name} disabled={connectionLost} />
            <Turns blocks={blocks} advanced={advanced} disconnected={connectionLost} name={selected.name} botId={botId} userId={boot.user.id}
              running={running} outgoingId={echo?.request.requestId} outgoing={echo?.status} />
          </>
        ) : !showActivity ? (
          <div className="empty-state">
            <Avatar
              avatar={selected.avatar}
              state={avatarState}
              size={112}
              name={selected.name}
              reducedMotion
            />
            <h2>Start with {selected.name}'s role</h2>
            <p>{selected.description || `Tell ${selected.name} what you need help with.`}</p>
            <button type="button" onClick={() => onDraft(`Let's discuss your role${selected.description ? `: ${selected.description}` : ". Ask me what I need help with and how I like to work"}.`)}>Discuss {selected.name}'s role</button>
            {!boot.capabilities.chat.supported && (
              <p className="muted">{boot.capabilities.chat.reason}</p>
            )}
          </div>
        ) : null}
        {selected && showActivity && (
          <div className={`activity-status conversation-activity message-activity state-${state}${state === "failed" || state === "interrupted" ? " recovery-activity" : ""}`}>
            {/* Headers, home and lists keep avatars still; this one moves to show live work. */}
            <Avatar avatar={selected.avatar} state={state === "blocked" ? "idle" : state} size={52} name={selected.name} botId={selected.id} offline={offline} prop={state === "working" ? prop : undefined} />
            <div className="activity-copy">
              <div role="status" aria-atomic="true">
                {state === "failed" || state === "interrupted" ? <>
                  <p className="recovery-title">{state === "failed" ? `${selected.name} couldn't finish.` : `${selected.name}'s task was interrupted.`}</p>
                  {conversation?.activity.detail?.trim() && <p className="recovery-detail">{conversation.activity.detail}</p>}
                  {state === "interrupted" && <p className="recovery-guidance">Review the last actions above before continuing.</p>}
                </> : <Shimmer text={`${selected.name} is ${action}...`} />}
              </div>
              {running && (liveTool || liveThought) && <div className="activity-live">
                {liveTool && <p className="activity-live-tool">{liveTool}</p>}
                {liveThought && <p className="activity-live-thought">{liveThought}</p>}
              </div>}
              {retry.message && <p className="recovery-guidance" role={retry.checking ? "status" : undefined}>{retry.checking
                ? retry.resendable ? "Checking whether the retry arrived… Retry sends the same request again, so it can't run twice."
                  : "Hermes hasn't confirmed the retry yet. It's being checked and won't be sent again. If it never arrives, send the message again from the message box."
                : "Retry sends your last message again. Your draft stays as it is."}</p>}
              {retry.refusal && <div className="retry-refused">
                <p role="status">{retry.refusal.text}</p>
                <button type="button" className="primary retry-turn" onClick={() => putBack(retry.refusal!.message)}>Put my message in the message box</button>
              </div>}
              {retry.message && <button type="button" className="primary with-progress retry-turn" disabled={retry.busy || retry.checking && !retry.resendable}
                title={retry.checking ? retry.resendable ? "Sends the same request again, so it can't run twice" : boot.capabilities.idempotency.reason : undefined}
                onClick={() => void retry.run(retry.message!)}>
                {retry.busy ? <Icon name="spinner" className="spin" size={16} /> : <Icon name="refresh" size={16} />}
                {retry.busy ? "Retrying…" : "Retry"}
              </button>}
            </div>
          </div>
        )}
        {conversation?.attention?.map((request) => (
          request.kind === "secure" && request.secure ? <SecureRequestCard
            key={`${boot.user.id}:${botId}:${request.id}:${JSON.stringify(request.secure)}`}
            request={request.secure} requestId={request.id} botId={botId} ownerId={boot.user.id}
            title={request.title} detail={request.detail} assistantName={selected?.name}
          /> : <AttentionCard
            key={request.id}
            request={request}
            botId={botId}
            report={setError}
          />
        ))}
        {conversation?.approvals
          .filter((approval) => approval.status === "pending")
          .map((approval) => <ApprovalCard key={`${boot.user.id}:${botId}:${approval.id}`} approval={approval} botId={botId} userId={boot.user.id} disconnected={connectionLost}
            supported={boot.capabilities.approvals.supported} unavailableReason={boot.capabilities.approvals.reason} report={setError} />)}
      </div>
      {/* Room for a message just sent to sit near the top while its reply grows; see use-conversation. */}
      <div className="transcript-end-space" ref={endSpace} aria-hidden="true" />
      </div>
      <QuoteSelection frame={frame} scroll={scroll} />
      {selected && conversation && !history.atLatest && !history.atAttention && (
        <button type="button" className={`jump-latest${history.unseen ? " has-new" : ""}`} onClick={() => {
          history.jumpToLatest();
          // The button disappears, so keyboard focus continues from the transcript.
          scroll.current?.focus({ preventScroll: true });
        }}>
          <Icon name="latest" size={16} />
          {history.unseen ? `${history.unseen} new ${history.unseen === 1 ? "message" : "messages"}` : "Jump to latest"}
        </button>
      )}
      </div>
    </TranscriptTools.Provider>
  );
}
/** The last line of reasoning in the running turn, after the person's latest message. */
function latestReasoning(messages: Message[]) {
  const start = messages.findLastIndex(isHumanMessage) + 1;
  const text = messages.slice(start).findLast(message => message.role === "assistant" && message.reasoning?.trim())?.reasoning ?? "";
  return text.trim().split("\n").findLast(line => line.trim())?.trim();
}
// The sweep copy is hidden from assistive technology; see .shimmer-band for how it moves.
function Shimmer({ text }: { text: string }) {
  return <span className="activity-shimmer">{text}<span className="shimmer-band" aria-hidden="true"><span>{text}</span></span></span>;
}
function HistorySkeleton() {
  return <div className="history-skeleton" role="status">
    <span className="sr-only">Opening your conversation…</span>
    {["reply", "prompt", "reply long"].map((kind, index) => <div key={index} className={`skeleton-message ${kind}`} aria-hidden="true">
      <span /><span /><span />
    </div>)}
  </div>;
}
// Earlier turns load as the reader nears the top. The button serves keyboards and retries.
function HistoryEdge({ history, scroll, name, disabled }: {
  history: ReturnType<typeof useConversation>["history"];
  scroll: RefObject<HTMLDivElement | null>;
  name: string;
  disabled: boolean;
}) {
  const edge = useRef<HTMLDivElement>(null);
  const { earlier, loading, failed, loadEarlier } = history;
  const automatic = earlier && !loading && !failed && !disabled;
  // A new observer reports at once, so a page that still leaves the edge in view loads the next.
  useEffect(() => {
    if (!automatic || !edge.current || !scroll.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) loadEarlier();
    }, { root: scroll.current, rootMargin: "600px 0px 0px 0px" });
    observer.observe(edge.current);
    return () => observer.disconnect();
  }, [automatic, loadEarlier, scroll]);
  if (history.complete) return <p className="history-edge history-start">This is the start of your conversation with {name}.</p>;
  if (!earlier) return null;
  return <div className="history-edge" ref={edge}>
    <button type="button" className="with-progress" disabled={loading || disabled} onClick={loadEarlier}>
      {loading && <Icon name="spinner" className="spin" size={16} />}
      {loading ? "Loading earlier messages…" : failed ? "Try loading earlier messages again" : "Show earlier messages"}
    </button>
  </div>;
}
type Turn = { messages: Message[]; tools: Map<string, Message>; reasoning: string[]; replyAt?: string };
const startsTurn = (message: Message) => isHumanMessage(message) || message.role === "user" && messageOrigin(message)?.kind === "scheduled";
function turns(conversation: SavedConversation | null, advanced: boolean) {
  const blocks: Turn[] = [];
  for (const message of withMessageOrigins(conversation?.messages || [])) {
    // A person's message or a scheduled prompt starts a turn. Subagent, process and agent rows that
    // Hermes files as user messages belong to the work of the turn they arrive in.
    if (!blocks.length || startsTurn(message)) blocks.push({ messages: [], tools: new Map(), reasoning: [] });
    const block = blocks.at(-1)!;
    // A turn's reasoning parts share one accordion instead of a block per reply row.
    if (advanced && !isActivityMessage(message) && message.role === "assistant" && message.reasoning?.trim()) block.reasoning.push(message.reasoning.trim());
    // A tool-call row with no reply text would render as an empty bubble.
    if (!isActivityMessage(message) && message.role !== "tool" && visibleMessage(message)) {
      if (message.role !== "user" && block.tools.size && block.replyAt === undefined) block.replyAt = message.id;
      block.messages.push(message);
    }
    if (isActivityMessage(message) || message.role === "tool" || message.toolCall) {
      block.tools.set(message.id, message);
      block.replyAt = undefined;
    }
  }
  for (const call of conversation?.toolCalls || []) {
    // Native history can reuse a tool ID. Only a unique row is safe to reconcile.
    const matches = blocks.flatMap(block => [...block.tools.values()].filter(message => message.toolCall?.id === call.id)
      .map(message => ({ block, message })));
    if (matches.length === 1) {
      const { block, message } = matches[0];
      block.tools.set(message.id, { ...message, toolCall: call });
    } else {
      if (!blocks.length) blocks.push({ messages: [], tools: new Map(), reasoning: [] });
      blocks.at(-1)!.tools.set(`live-${call.id}`, { id: `live-${call.id}`, role: "tool", text: "", toolCall: call });
    }
  }
  // Live calls update receipts, but only saved row order establishes where the reply starts.
  for (const block of blocks) if ([...block.tools.values()].some(message => message.toolCall?.status === "running")) block.replyAt = undefined;
  return blocks;
}
type TurnProps = {
  block: Turn; advanced: boolean; disconnected: boolean; name: string; botId: string; userId: string;
  /** This is the latest turn and it is still working, so its work reads as live rather than finished. */
  live: boolean;
  /** The person's sent message still shown from this device, and how far it got. Only the turn that holds it gets these. */
  outgoingId?: string; outgoing?: SentEcho["status"];
};
// Memoized so typing in the composer does not re-render the whole transcript.
const Turns = memo(function Turns({ blocks, running, outgoingId, outgoing, ...shared }: Omit<TurnProps, "block" | "live" | "outgoingId" | "outgoing"> & {
  blocks: Turn[];
  /** The latest turn is still working. */
  running: boolean;
  outgoingId?: string; outgoing?: SentEcho["status"];
}) {
  return <>
    {blocks.map((block, index) => {
      const holdsEcho = outgoingId !== undefined && block.messages.some(message => message.id === outgoingId);
      return <TurnView key={block.messages[0]?.id || `tools-${index}`} block={block} {...shared} live={running && index === blocks.length - 1}
        outgoingId={holdsEcho ? outgoingId : undefined} outgoing={holdsEcho ? outgoing : undefined} />;
    })}
  </>;
});
// A stream changes the latest reply about four times a second, and `turns` rebuilds every block each
// time. A turn is compared by what it shows, so finished turns, and a reload with the same content, bail out.
const sameFile = (a: FileRef, b: FileRef) => a === b || a.id === b.id && a.name === b.name && a.mime === b.mime && a.size === b.size && a.url === b.url;
const sameCall = (a?: ToolCall, b?: ToolCall) => a === b || !!a && !!b && a.id === b.id && a.name === b.name && a.status === b.status
  && a.arguments === b.arguments && a.result === b.result && a.error === b.error && a.startedAt === b.startedAt && a.completedAt === b.completedAt;
const sameOrigin = (a?: Message["origin"], b?: Message["origin"]) => a === b || !!a && !!b && a.kind === b.kind && a.visibility === b.visibility
  && a.title === b.title && a.name === b.name && a.handle === b.handle;
function sameMessage(a: Message, b: Message) {
  if (a === b) return true;
  return a.id === b.id && a.role === b.role && a.text === b.text && a.createdAt === b.createdAt && a.reasoning === b.reasoning
    && a.toolName === b.toolName && a.runId === b.runId && a.sender?.id === b.sender?.id && a.sender?.name === b.sender?.name
    && sameOrigin(a.origin, b.origin) && sameCall(a.toolCall, b.toolCall)
    && (a.files === b.files || !!a.files && !!b.files && a.files.length === b.files.length && a.files.every((file, index) => sameFile(file, b.files![index])));
}
const sameMessages = (a: Message[], b: Message[]) => a === b || a.length === b.length && a.every((message, index) => sameMessage(message, b[index]));
function sameTurn(a: Turn, b: Turn) {
  if (a === b) return true;
  if (a.replyAt !== b.replyAt || a.reasoning.length !== b.reasoning.length || a.reasoning.some((part, index) => part !== b.reasoning[index])) return false;
  if (!sameMessages(a.messages, b.messages) || a.tools.size !== b.tools.size) return false;
  const left = [...a.tools], right = [...b.tools];
  return left.every(([id, message], index) => id === right[index][0] && sameMessage(message, right[index][1]));
}
const sameTurnProps = (a: TurnProps, b: TurnProps) => a.advanced === b.advanced && a.disconnected === b.disconnected && a.name === b.name
  && a.botId === b.botId && a.userId === b.userId && a.live === b.live && a.outgoingId === b.outgoingId && a.outgoing === b.outgoing
  && sameTurn(a.block, b.block);
const TurnView = memo(function TurnView({ block, advanced, disconnected, name, botId, userId, live: running, outgoingId, outgoing }: TurnProps) {
  const work = [...block.tools.values()];
  // A turn's intermediate work folds into one row: before the reply that follows the work, before the
  // first reply when there is only reasoning, or at the end.
  const fold = work.length || block.reasoning.length ? <TurnWork key="turn-work" work={work} reasoning={block.reasoning}
    messages={block.messages} advanced={advanced} disconnected={disconnected} recipient={name} live={running} /> : null;
  const foldAt = work.length ? block.replyAt : block.messages.find(message => message.role !== "user")?.id;
  // One keyed list, so the fold keeps its open state when finishing moves it above the reply.
  const rows = block.messages.flatMap((message, position) => {
    // The conversation is with one assistant, so its replies need no name, and
    // consecutive reply parts in a turn share the first part's timestamp.
    const reply = message.role === "assistant" || messageOrigin(message)?.kind === "scheduled";
    const continued = reply && block.messages[position - 1]?.role === "assistant" && message.id !== block.replyAt;
    const scheduled = messageOrigin(message)?.kind === "scheduled";
    const label = scheduled ? "Scheduled" : message.role === "user" ? message.sender?.name || "User"
      : reply ? "" : message.toolName || message.role;
    // Accepted, it reads as any other message until Hermes's own copy takes its place.
    const delivery = outgoingId === message.id && outgoing !== "accepted" ? outgoing : undefined;
    const streaming = message.id.endsWith("-inflight");
    const article = <article
      className={`message message-${isAgentExchange(message) ? "agent" : message.role}${continued ? " message-continued" : ""}${delivery ? ` message-outgoing message-${delivery}` : ""}`}
      key={message.id}
      data-message-id={message.id}
      aria-busy={delivery === "sending" || undefined}
    >
      {!isAgentExchange(message) && !continued && (label || message.createdAt) && <div className="message-attribution">
        {label}
        {delivery ? <span className="message-delivery">{delivery === "sending" ? "Sending…" : "Not confirmed yet"}</span>
          : message.createdAt && <When value={message.createdAt} />}
      </div>}
      {isAgentExchange(message) ? <AgentExchange message={message} recipient={name} /> : reply ? (
        streaming
          ? <StreamingMarkdown text={message.text} botId={botId} messageId={message.id} userId={userId} unavailable={disconnected} inlineUi={message.role === "assistant"} />
          : <MessageMarkdown text={message.text} botId={botId} messageId={message.id} userId={userId} unavailable={disconnected} inlineUi={message.role === "assistant"} />
      ) : message.role !== "tool" && (
        <div className="message-text">{message.text}</div>
      )}
      {message.files?.map((file) => (
        <FileLink file={file} key={file.id} />
      ))}
      {message.role === "assistant" && !streaming && !isAgentExchange(message) && !!message.text.trim() && <ReplyActions message={message} />}
    </article>;
    return message.id === foldAt && fold ? [fold, article] : [article];
  });
  if (foldAt === undefined && fold) rows.push(fold);
  return <div className="conversation-turn">{rows}</div>;
}, sameTurnProps);
/**
 * One row for a turn's intermediate work: "Worked for 2m 14s · 3 tool calls, 1 subagent". Open, it
 * shows the grouped accordions as before, with reasoning first.
 */
function TurnWork({ work, reasoning, messages, advanced, disconnected, recipient, live }: {
  work: Message[]; reasoning: string[]; messages: Message[]; advanced: boolean; disconnected: boolean; recipient: string; live: boolean;
}) {
  const summary = foldSummary(work, live ? undefined : turnDuration({ messages, work }), live);
  return <details className="turn-work">
    <summary><span>{summary}</span></summary>
    <div className="turn-work-content">
      {reasoning.length > 0 && <Reasoning parts={reasoning} />}
      {work.length > 0 && <ToolCalls messages={work} advanced={advanced} disconnected={disconnected} recipient={recipient} />}
    </div>
  </details>;
}
function visibleMessage(message: Message) {
  return message.role !== "assistant" || isAgentExchange(message) || !!message.text.trim() || !!message.files?.length;
}
function Reasoning({ parts }: { parts: string[] }) {
  return <details className="tool-calls reasoning-calls">
    <summary><Icon name="brain" size={16} /><span>Reasoning</span>{parts.length > 1 && <span className="tool-count">{parts.length}</span>}</summary>
    <div className="tool-calls-content">{parts.map((part, index) => <p className="reasoning-part" key={index}>{part}</p>)}</div>
  </details>;
}
function ApprovalCard({ approval, botId, userId, disconnected, supported, unavailableReason, report }: {
  approval: Approval; botId: string; userId: string; disconnected: boolean; supported: boolean; unavailableReason?: string; report(message: string): void;
}) {
  const saved = approvalAttempt(userId, botId, approval.id);
  const [attempt, setAttempt] = useState<ApprovalAttempt | undefined>(() => saved.read());
  const [sending, setSending] = useState(false);
  const pending = useRef(false);
  async function decide(value: "approved" | "denied") {
    const previous = saved.read();
    if (!supported || disconnected || pending.current || previous && (previous.state !== "unconfirmed" || previous.decision !== value)) return;
    report("");
    pending.current = true;
    setSending(true);
    const next: ApprovalAttempt = { decision: value, state: "unconfirmed" };
    // Save before sending: leaving this chat while the POST is in flight must
    // never offer the opposite decision when the person returns.
    saved.save(next); setAttempt(next);
    try {
      await apiRequest("POST /bots/:id/approvals/:approvalId", { params: { id: botId, approvalId: approval.id }, body: { decision: value } });
      const sent: ApprovalAttempt = { decision: value, state: "sent" };
      saved.save(sent); setAttempt(sent);
    } catch (error) {
      if (error instanceof ApiError && error.status < 500 && (error.status !== 409 || error.code === "hermes_maintenance") && !previous) {
        saved.save(undefined); setAttempt(undefined); report(error.code === "hermes_maintenance" ? "Hermes is being updated. Try your decision again when the update finishes." : error.message);
      } else {
        const retained: ApprovalAttempt = { decision: value, state: error instanceof ApiError && error.status === 409 && error.code !== "hermes_maintenance" ? "closed" : "unconfirmed" };
        saved.save(retained); setAttempt(retained);
        // Refreshes can remove a resolved card, but a still-pending read cannot
        // prove an earlier answer isn't still being processed. Never auto-send.
        window.dispatchEvent(new Event("agent-interface:reconnect"));
      }
    } finally { pending.current = false; setSending(false); }
  }
  return <article className="approval-card decision-card" aria-busy={sending} {...attentionAnchor("approval", approval.id)}>
    <p className="eyebrow">{attempt?.state === "closed" ? "Decision status" : "Your decision needed"}</p><h2>{approval.title}</h2><p>{approval.detail}</p>
    {approval.expiresAt && <small>Expires <When value={approval.expiresAt} inline /></small>}
    {attempt?.state !== "closed" && <div className="actions">{(["approved", "denied"] as const).map(value => <button key={value} type="button"
      className={value === "approved" ? "primary" : undefined}
      disabled={!supported || disconnected || sending || !!attempt && (attempt.state !== "unconfirmed" || value !== attempt.decision)} onClick={() => void decide(value)}>
      {attempt?.decision === value && (sending || attempt.state === "sent") && <Icon name={sending ? "spinner" : "check"} className={sending ? "spin" : undefined} size={16} />}
      {attempt?.decision === value ? sending ? value === "approved" ? "Approving…" : "Declining…"
        : attempt.state === "sent" ? value === "approved" ? "Approved" : "Declined"
        : value === "approved" ? "Send approval again" : "Send decline again"
        : value === "approved" ? "Approve" : "Decline"}
    </button>)}</div>}
    {!supported && <p className="approval-unavailable">{unavailableReason || "This Hermes connection does not support approval decisions. Open the official Hermes interface to answer."}</p>}
    {disconnected && !attempt && supported && <p className="decision-status" role="status">Reconnect to Hermes to answer.</p>}
    {attempt && <p className="decision-status" role="status">{sending ? "Sending decision…"
      : attempt.state === "sent" ? attempt.decision === "approved" ? "Approval sent." : "Decline sent."
      : attempt.state === "closed" ? "This request is no longer available to answer. Its status will update with the conversation."
      : `Hermes hasn't confirmed your ${attempt.decision === "approved" ? "approval" : "decline"}. It may still go through, so the other choice stays off. After reconnecting, you can send the same decision again.`}</p>}
  </article>;
}
function ToolCalls({ messages, advanced, disconnected, recipient }: { messages: Message[]; advanced: boolean; disconnected: boolean; recipient: string }): ReactNode {
  return workGroups(messages).map(group => <details className="tool-calls" key={group.label}>
    <summary><Icon name={group.label === "Subagents" ? "robot" : "terminal"} size={16} /><span>{group.label}</span><span className="tool-count">{group.items.length}</span>
      {group.items.some(message => message.toolCall?.status === "running") && <span className="muted">{disconnected ? "Last seen running" : "Running"}</span>}</summary>
    <div className="tool-calls-content">{group.items.map(message => <div key={message.id}>
      {isAgentExchange(message) ? <AgentExchange message={message} recipient={recipient} /> : message.toolCall
        ? advanced ? <ToolCallDetail call={message.toolCall} disconnected={disconnected} /> : <ActionReceipt call={message.toolCall} />
        : <details className="message-detail"><summary>{messageOrigin(message)?.title || message.toolName || group.label}{message.createdAt && <> · <When value={message.createdAt} inline /></>}</summary><pre role="region" tabIndex={0} aria-label="Activity output">{message.text || "No result was exposed by Hermes."}</pre></details>}
      {message.files?.map(file => <FileLink key={file.id} file={file} />)}
    </div>)}</div>
  </details>);
}
function ToolCallDetail({ call, disconnected }: { call: ToolCall; disconnected?: boolean }) {
  return <details className="message-detail tool-call-detail" data-tool-call-id={call.id}>
    <summary><span>{call.name}</span><span className={`tool-call-status tool-call-${call.status}`}>{call.status === "running" ? disconnected ? "Last seen running" : "Running" : call.status === "failed" ? "Failed" : "Completed"}</span></summary>
    <dl>
      <div><dt>Call</dt><dd><code>{call.id}</code></dd></div>
      {call.startedAt && <div><dt>Started</dt><dd><When value={call.startedAt} /></dd></div>}
      {call.completedAt && <div><dt>Finished</dt><dd><When value={call.completedAt} /></dd></div>}
    </dl>
    {call.arguments !== undefined && <><h3>Arguments</h3><pre role="region" tabIndex={0} aria-label={`Arguments for ${call.name}`}>{call.arguments}</pre></>}
    {call.result !== undefined && <><h3>Result</h3><pre role="region" tabIndex={0} aria-label={`Result from ${call.name}`}>{call.result}</pre></>}
    {call.error && <><h3 className="danger">Error</h3><pre className="danger" role="region" tabIndex={0} aria-label={`Error from ${call.name}`}>{call.error}</pre></>}
    {call.status === "running" && call.result === undefined && <p>{disconnected ? "The current tool status will be checked when Hermes reconnects." : "Waiting for the result from Hermes."}</p>}
  </details>;
}
// Natural sizes of images already shown, so one that scrolls back into the transcript reserves its space before it reloads.
const imageSizes = new Map<string, { width: number; height: number }>();
function FileLink({ file }: { file: FileRef }) {
  const size = imageSizes.get(file.id);
  return (
    <a
      className="file-link"
      href={file.url || `/api/files/${encodeURIComponent(file.id)}`}
      target="_blank"
      rel="noreferrer"
    >
      {file.mime.startsWith("image/") && (
        <img
          src={file.url || `/api/files/${encodeURIComponent(file.id)}`}
          alt={file.name}
          width={size?.width}
          height={size?.height}
          loading="lazy"
          decoding="async"
          onLoad={event => imageSizes.set(file.id, { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        />
      )}
      <span><Icon name={file.mime.startsWith("image/") ? "download" : "file"} size={16} /> {file.name}</span>
    </a>
  );
}
