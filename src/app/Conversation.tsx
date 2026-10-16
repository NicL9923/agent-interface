import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { RefCallback, RefObject } from "react";
import type { ActivityState, Approval, AttentionRequest, Bootstrap, Bot, FileRef, Message, ToolCall } from "../shared/types";
import { write } from "../client-api";
import { Avatar } from "../components/Avatar";
import { avatarProp } from "../components/avatar-motion";
import { MessageMarkdown } from "../components/MessageMarkdown";
import { ConnectionPanel } from "../components/ConnectionPanel";
import { Icon } from "../components/Icon";
import { NotificationOnboarding } from "../components/DeviceNotifications";
import type { useDeviceNotifications } from "../components/use-device-notifications";
import { SecureRequestCard } from "../components/SecureRequestCard";
import { AgentExchange, isAgentExchange } from "../components/AgentExchange";
import { ActionReceipt } from "../components/ActionReceipt";
import { When } from "../components/When";
import { activityLabels, isActivityMessage, messageOrigin, withMessageOrigins } from "../shared/message-origin";
import type { SavedConversation } from "./storage";
import type { useConversation } from "./use-conversation";
export function Conversation({ boot, selected, botId, conversation, state, showActivity, avatarState, connectionLost, offline, appUnavailable, checkingConnection, reconnect, error, setError, workerUpdate, notifications, scroll, content, history, reply, onScroll, onCreate, onDraft }: {
  boot: Bootstrap;
  selected?: Bot;
  botId: string;
  conversation: SavedConversation | null;
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
  workerUpdate: ServiceWorker | null;
  notifications: ReturnType<typeof useDeviceNotifications>;
  scroll: RefObject<HTMLDivElement | null>;
  content: RefCallback<HTMLDivElement>;
  history: ReturnType<typeof useConversation>["history"];
  reply: ReturnType<typeof useConversation>["reply"];
  onScroll(): void;
  onCreate(): void;
  onDraft(text: string): void;
}) {
  const prefs = boot.preferences;
  const advanced = prefs.presentation === "advanced";
  const blocks = useMemo(() => turns(conversation, advanced), [conversation, advanced]);
  const actions: Record<ActivityState, string> = {
    idle: "ready", thinking: "thinking", working: "working", waiting: "waiting for approval",
    blocked: "waiting for your input", done: "done", failed: "having trouble", interrupted: "stopped", disconnected: "reconnecting",
  };
  const detail = conversation?.activity.detail?.trim().replace(/[.…]+$/, "");
  const prop = connectionLost ? undefined : avatarProp(conversation?.toolCalls?.findLast(call => call.status === "running")?.name);
  const action = !connectionLost && state === "working" && detail ? detail.charAt(0).toLowerCase() + detail.slice(1) : actions[state];
  return (
    <>
      {workerUpdate && (
        <div className="notice">
          An app update is ready.
          <button
            onClick={() => {
              navigator.serviceWorker.addEventListener(
                "controllerchange",
                () => location.reload(),
                { once: true },
              );
              workerUpdate.postMessage({ type: "SKIP_WAITING" });
            }}
          >
            Reload when ready
          </button>
        </div>
      )}
      {connectionLost && selected && (
        <ConnectionPanel compact connection={boot.connection} offline={offline}
          appUnavailable={appUnavailable} busy={checkingConnection} retry={() => void reconnect()} />
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      <NotificationOnboarding notifications={notifications} />
      <div className="transcript-frame">
      {/* Always mounted, so a screen reader is already watching when a reply lands. */}
      {/* Each reply is its own node, so a repeat of the same words still reads out. */}
      <span className="sr-only" role="status">
        {selected && reply?.botId === botId && <span key={reply.id}>{`${selected.name} replied: ${reply.text}`}</span>}
      </span>
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
            <Turns blocks={blocks} advanced={advanced} disconnected={connectionLost} name={selected.name} botId={botId} userId={boot.user.id} />
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
            <h2>Let's discuss your role.</h2>
            <p>{selected.description || `Tell ${selected.name} what you need help with.`}</p>
            <button type="button" onClick={() => onDraft(`Let's discuss your role${selected.description ? `: ${selected.description}` : ". Ask me what I need help with and how I like to work"}.`)}>Discuss {selected.name}'s role</button>
            {!boot.capabilities.chat.supported && (
              <p className="muted">{boot.capabilities.chat.reason}</p>
            )}
          </div>
        ) : null}
        {selected && showActivity && (
          <div className={`activity-status conversation-activity message-activity state-${state}`}>
            {/* Headers, home and lists keep avatars still; this one moves to show live work. */}
            <Avatar avatar={selected.avatar} state={state} size={52} name={selected.name} prop={state === "working" ? prop : undefined} />
            <div className="activity-copy" role="status">
              <Shimmer text={`${selected.name} is ${action}...`} />
            </div>
          </div>
        )}
        {conversation?.attention?.map((request) => (
          request.kind === "secure" && request.secure ? <SecureRequestCard
            key={`${boot.user.id}:${botId}:${request.id}:${JSON.stringify(request.secure)}`}
            request={request.secure} requestId={request.id} botId={botId} ownerId={boot.user.id}
            title={request.title} detail={request.detail}
          /> : <AttentionCard
            key={request.id}
            request={request}
            botId={botId}
            report={setError}
          />
        ))}
        {conversation?.approvals
          .filter((approval) => approval.status === "pending")
          .map((approval) => <ApprovalCard key={`${botId}:${approval.id}`} approval={approval} botId={botId}
            supported={boot.capabilities.approvals.supported} report={setError} />)}
      </div>
      </div>
      {selected && conversation && !history.atLatest && (
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
    </>
  );
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
type Turn = { messages: Message[]; tools: Map<string, Message>; reasoning: string[] };
function turns(conversation: SavedConversation | null, advanced: boolean) {
  const blocks: Turn[] = [];
  for (const message of withMessageOrigins(conversation?.messages || [])) {
    if (!blocks.length || message.role === "user") blocks.push({ messages: [], tools: new Map(), reasoning: [] });
    const block = blocks.at(-1)!;
    // A turn's reasoning parts share one accordion instead of a block per reply row.
    if (advanced && !isActivityMessage(message) && message.role === "assistant" && message.reasoning?.trim()) block.reasoning.push(message.reasoning.trim());
    if (isActivityMessage(message) || message.role === "tool" || message.toolCall) block.tools.set(message.id, message);
    // A tool-call row with no reply text would render as an empty bubble.
    if (!isActivityMessage(message) && message.role !== "tool" && visibleMessage(message)) block.messages.push(message);
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
  return blocks;
}
// Memoized so typing in the composer does not re-render the whole transcript.
const Turns = memo(function Turns({ blocks, advanced, disconnected, name, botId, userId }: {
  blocks: Turn[]; advanced: boolean; disconnected: boolean; name: string; botId: string; userId: string;
}) {
  return <>
    {blocks.map((block, index) => <div className="conversation-turn" key={block.messages[0]?.id || `tools-${index}`}>
      {block.messages.flatMap((message, position) => {
        // The conversation is with one assistant, so its replies need no name, and
        // consecutive reply parts in a turn share the first part's timestamp.
        const reply = message.role === "assistant" || messageOrigin(message)?.kind === "scheduled";
        const continued = reply && block.messages[position - 1]?.role === "assistant";
        const scheduled = messageOrigin(message)?.kind === "scheduled";
        const label = scheduled ? "Scheduled" : message.role === "user" ? message.sender?.name || "User"
          : reply ? "" : message.toolName || message.role;
        // Reasoning follows the prompt and precedes the reply.
        const opensReply = !!block.reasoning.length && message.role !== "user" && block.messages.slice(0, position).every(item => item.role === "user");
        const article = <article
          className={`message message-${isAgentExchange(message) ? "agent" : message.role}${continued ? " message-continued" : ""}`}
          key={message.id}
          data-message-id={message.id}
        >
          {!isAgentExchange(message) && !continued && (label || message.createdAt) && <div className="message-attribution">
            {label}
            {message.createdAt && <When value={message.createdAt} />}
          </div>}
          {isAgentExchange(message) ? <AgentExchange message={message} recipient={name} /> : reply ? (
            <MessageMarkdown text={message.text} botId={botId} messageId={message.id} userId={userId} unavailable={disconnected} inlineUi={message.role === "assistant"} />
          ) : message.role !== "tool" && (
            <div className="message-text">{message.text}</div>
          )}
          {message.files?.map((file) => (
            <FileLink file={file} key={file.id} />
          ))}
        </article>;
        return opensReply ? [<Reasoning key="reasoning" parts={block.reasoning} />, article] : [article];
      })}
      {!!block.reasoning.length && block.messages.every(message => message.role === "user") && <Reasoning parts={block.reasoning} />}
      <ToolCalls messages={[...block.tools.values()]} advanced={advanced} disconnected={disconnected} recipient={name} />
    </div>)}
  </>;
});
function visibleMessage(message: Message) {
  return message.role !== "assistant" || isAgentExchange(message) || !!message.text.trim() || !!message.files?.length;
}
function Reasoning({ parts }: { parts: string[] }) {
  return <details className="tool-calls reasoning-calls">
    <summary><Icon name="brain" size={16} /><span>Reasoning</span>{parts.length > 1 && <span className="tool-count">{parts.length}</span>}
      <Icon name="chevron" size={16} /></summary>
    <div className="tool-calls-content">{parts.map((part, index) => <p className="reasoning-part" key={index}>{part}</p>)}</div>
  </details>;
}
function ApprovalCard({ approval, botId, supported, report }: { approval: Approval; botId: string; supported: boolean; report(message: string): void }) {
  const [decision, setDecision] = useState<"approved" | "denied" | null>(null);
  const [settled, setSettled] = useState(false);
  async function decide(value: "approved" | "denied") {
    if (decision) return;
    setDecision(value);
    try {
      await write(`/bots/${encodeURIComponent(botId)}/approvals/${encodeURIComponent(approval.id)}`, { decision: value });
      setSettled(true);
    } catch (error) { setDecision(null); report((error as Error).message); }
  }
  return <article className="approval-card" aria-busy={!!decision && !settled}>
    <p className="eyebrow">Your decision needed</p><h2>{approval.title}</h2><p>{approval.detail}</p>
    {approval.expiresAt && <small>Expires <When value={approval.expiresAt} inline /></small>}
    <div className="actions">{(["approved", "denied"] as const).map(value => <button key={value} type="button"
      className={value === "approved" ? "primary" : undefined} disabled={!supported || !!decision} onClick={() => void decide(value)}>
      {decision === value && <Icon name={settled ? "check" : "spinner"} className={settled ? undefined : "spin"} size={16} />}
      {decision === value ? settled ? value === "approved" ? "Approved" : "Declined" : value === "approved" ? "Approving…" : "Declining…" : value === "approved" ? "Approve" : "Decline"}
    </button>)}</div>
    {decision && <span className="sr-only" role="status">{settled ? "Decision sent" : "Sending decision"}</span>}
  </article>;
}
function ToolCalls({ messages, advanced, disconnected, recipient }: { messages: Message[]; advanced: boolean; disconnected: boolean; recipient: string }) {
  const label = (message: Message) => {
    const origin = messageOrigin(message);
    return origin && origin.visibility === "activity" ? activityLabels[origin.kind] : "Tool calls";
  };
  const groups = [...new Set(messages.map(label))].map(name => ({ label: name, items: messages.filter(message => label(message) === name) }));
  return groups.filter(group => group.items.length).map(group => <details className="tool-calls" key={group.label}>
    <summary><Icon name={group.label === "Subagents" ? "robot" : "terminal"} size={16} /><span>{group.label}</span><span className="tool-count">{group.items.length}</span>
      {group.items.some(message => message.toolCall?.status === "running") && <span className="muted">{disconnected ? "Last seen running" : "Running"}</span>}
      <Icon name="chevron" size={16} /></summary>
    <div className="tool-calls-content">{group.items.map(message => <div key={message.id}>
      {isAgentExchange(message) ? <AgentExchange message={message} recipient={recipient} /> : message.toolCall
        ? advanced ? <ToolCallDetail call={message.toolCall} disconnected={disconnected} /> : <ActionReceipt call={message.toolCall} />
        : <details className="message-detail"><summary>{messageOrigin(message)?.title || message.toolName || label(message)}{message.createdAt && <> · <When value={message.createdAt} inline /></>}</summary><pre>{message.text || "No result was exposed by Hermes."}</pre></details>}
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
    {call.arguments !== undefined && <><h3>Arguments</h3><pre>{call.arguments}</pre></>}
    {call.result !== undefined && <><h3>Result</h3><pre>{call.result}</pre></>}
    {call.error && <><h3 className="danger">Error</h3><pre className="danger">{call.error}</pre></>}
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
function AttentionCard({
  request,
  botId,
  report,
}: {
  request: AttentionRequest;
  botId: string;
  report: (s: string) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  return (
    <article className="approval-card">
      <p className="eyebrow">
        {request.kind === "clarify"
          ? "A question for you"
          : "Continue in Hermes"}
      </p>
      <h2>{request.title}</h2>
      <p>{request.detail}</p>
      {request.kind === "clarify" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            void write(
              `/bots/${encodeURIComponent(botId)}/requests/${encodeURIComponent(request.id)}`,
              { answers },
            )
              .catch((error) => report(error.message))
              .finally(() => setBusy(false));
          }}
        >
          {request.questions?.map((question) => (
            <label key={question.id}>
              {question.prompt}
              {question.options?.length ? (
                <select
                  required
                  value={answers[question.id] || ""}
                  onChange={(event) =>
                    setAnswers({
                      ...answers,
                      [question.id]: event.target.value,
                    })
                  }
                >
                  <option value="">Choose an answer</option>
                  {question.options.map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </select>
              ) : (
                <input
                  required
                  value={answers[question.id] || ""}
                  onChange={(event) =>
                    setAnswers({
                      ...answers,
                      [question.id]: event.target.value,
                    })
                  }
                />
              )}
            </label>
          ))}
          <button className="primary" disabled={busy}>
            Send answers
          </button>
        </form>
      )}
      {request.kind === "official" && (
        <p className="muted">
          Open the official Hermes interface to handle this request. Return here
          when it is complete.
        </p>
      )}
    </article>
  );
}
