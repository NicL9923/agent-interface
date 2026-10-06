import { useState } from "react";
import type { RefObject } from "react";
import type { ActivityState, Approval, AttentionRequest, Bootstrap, Bot, FileRef, Message, ToolCall } from "../shared/types";
import { write } from "../client-api";
import { Avatar } from "../components/Avatar";
import { MessageMarkdown } from "../components/MessageMarkdown";
import { ConnectionPanel } from "../components/ConnectionPanel";
import { Icon } from "../components/Icon";
import { NotificationOnboarding } from "../components/DeviceNotifications";
import type { useDeviceNotifications } from "../components/use-device-notifications";
import { SecureRequestCard } from "../components/SecureRequestCard";
import { AgentExchange, isAgentExchange } from "../components/AgentExchange";
import { ActionReceipt } from "../components/ActionReceipt";
import { When } from "../components/When";
import type { SavedConversation } from "./storage";
export function Conversation({ boot, selected, botId, conversation, state, showActivity, avatarState, connectionLost, offline, appUnavailable, checkingConnection, reconnect, error, setError, workerUpdate, notifications, scroll, onScroll, onCreate, onDraft }: {
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
  onScroll(): void;
  onCreate(): void;
  onDraft(text: string): void;
}) {
  const prefs = boot.preferences;
  const advanced = prefs.presentation === "advanced";
  const blocks: { messages: Message[]; tools: Map<string, Message> }[] = [];
  for (const message of conversation?.messages || []) {
    if (!blocks.length || message.role === "user") blocks.push({ messages: [], tools: new Map() });
    const block = blocks.at(-1)!;
    if (message.role === "tool" || message.toolCall) block.tools.set(message.id, message);
    if (message.role !== "tool") block.messages.push(message);
  }
  for (const call of conversation?.toolCalls || []) {
    // Native history can reuse a tool ID. Only a unique row is safe to reconcile.
    const matches = blocks.flatMap(block => [...block.tools.values()].filter(message => message.toolCall?.id === call.id)
      .map(message => ({ block, message })));
    if (matches.length === 1) {
      const { block, message } = matches[0];
      block.tools.set(message.id, { ...message, toolCall: call });
    } else {
      if (!blocks.length) blocks.push({ messages: [], tools: new Map() });
      blocks.at(-1)!.tools.set(`live-${call.id}`, { id: `live-${call.id}`, role: "tool", text: "", toolCall: call });
    }
  }
  const actions: Record<ActivityState, string> = {
    idle: "ready", thinking: "thinking", working: "working", waiting: "waiting for approval",
    blocked: "waiting for your input", done: "done", failed: "having trouble", interrupted: "stopped", disconnected: "reconnecting",
  };
  const detail = conversation?.activity.detail?.trim().replace(/[.…]+$/, "");
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
      <div
        className="transcript"
        ref={scroll}
        onScroll={onScroll}
        aria-label="Conversation"
        tabIndex={0}
      >
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
          <div className="empty-state" role="status"><p>Opening your conversation…</p></div>
        ) : blocks.length ? (
          <>
            {blocks.map((block, index) => <div className="conversation-turn" key={block.messages[0]?.id || `tools-${index}`}>
              {block.messages.map((message) => (
                <article
                  className={`message message-${isAgentExchange(message) ? "agent" : message.role}`}
                  key={message.id}
                  data-message-id={message.id}
                >
                  {!isAgentExchange(message) && <div className="message-attribution">
                    {message.role === "user"
                      ? message.sender?.name || "Household member"
                      : message.role === "assistant" || message.role === "tool"
                        ? selected.name
                        : message.toolName || message.role}
                    {message.createdAt && <When value={message.createdAt} />}
                  </div>}
                  {isAgentExchange(message) ? <AgentExchange message={message} recipient={selected.name} /> : message.role === "assistant" ? (
                    <MessageMarkdown text={message.text} botId={botId} messageId={message.id} userId={boot.user.id} unavailable={connectionLost} />
                  ) : message.role !== "tool" && (
                    <div className="message-text">{message.text}</div>
                  )}
                  {advanced && message.reasoning && (
                    <details className="message-detail">
                      <summary>Reasoning</summary>
                      <p>{message.reasoning}</p>
                    </details>
                  )}
                  {message.files?.map((file) => (
                    <FileLink file={file} key={file.id} />
                  ))}
                </article>
              ))}
              <ToolCalls messages={[...block.tools.values()]} advanced={advanced} disconnected={connectionLost} recipient={selected.name} />
            </div>)}
          </>
        ) : !showActivity ? (
          <div className="empty-state">
            <Avatar
              avatar={selected.avatar}
              state={avatarState}
              size={112}
              name={selected.name}
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
            <Avatar avatar={selected.avatar} state={state} size={52} name={selected.name} />
            <div className="activity-copy" role="status">
              <span className="activity-shimmer">{selected.name} is {action}...</span>
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
    </>
  );
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
  const delegated = (message: Message) => isAgentExchange(message) || /^(delegate_task|spawn_agent|subagent|task)$/.test(message.toolCall?.name || message.toolName || "");
  const groups = [{ label: "Tool calls", items: messages.filter(message => !delegated(message)) },
    { label: "Subagents", items: messages.filter(delegated) }];
  return groups.filter(group => group.items.length).map(group => <details className="tool-calls" key={group.label}>
    <summary><Icon name={group.label === "Subagents" ? "robot" : "terminal"} size={16} /><span>{group.label}</span><span className="tool-count">{group.items.length}</span>
      {group.items.some(message => message.toolCall?.status === "running") && <span className="muted">{disconnected ? "Last seen running" : "Running"}</span>}
      <Icon name="chevron" size={16} /></summary>
    <div className="tool-calls-content">{group.items.map(message => <div key={message.id}>
      {isAgentExchange(message) ? <AgentExchange message={message} recipient={recipient} /> : message.toolCall
        ? advanced ? <ToolCallDetail call={message.toolCall} disconnected={disconnected} /> : <ActionReceipt call={message.toolCall} />
        : <details className="message-detail"><summary>{message.toolName || "Tool result"}</summary><pre>{message.text || "No result was exposed by Hermes."}</pre></details>}
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
function FileLink({ file }: { file: FileRef }) {
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
          loading="lazy"
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
