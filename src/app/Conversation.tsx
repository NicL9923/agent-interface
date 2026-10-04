import { useState } from "react";
import type { RefObject } from "react";
import type { ActivityState, AttentionRequest, Bootstrap, Bot, FileRef, ToolCall } from "../shared/types";
import { write } from "../client-api";
import { Avatar, stateLabels } from "../components/Avatar";
import { MessageMarkdown } from "../components/MessageMarkdown";
import { ConnectionPanel } from "../components/ConnectionPanel";
import { Icon } from "../components/Icon";
import { NotificationOnboarding } from "../components/DeviceNotifications";
import type { useDeviceNotifications } from "../components/use-device-notifications";
import { SecureRequestCard } from "../components/SecureRequestCard";
import { AgentExchange, isAgentExchange } from "../components/AgentExchange";
import { ActionReceipt } from "../components/ActionReceipt";
import type { SavedConversation } from "./storage";
export function Conversation({ boot, selected, botId, conversation, state, active, showActivity, avatarState, connectionLost, offline, appUnavailable, checkingConnection, reconnect, error, setError, workerUpdate, notifications, scroll, onScroll, onCreate }: {
  boot: Bootstrap;
  selected?: Bot;
  botId: string;
  conversation: SavedConversation | null;
  state: ActivityState;
  active: boolean;
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
}) {
  const prefs = boot.preferences;
  const advanced = prefs.presentation === "advanced";
  const historicalToolIds = new Set(conversation?.messages.flatMap(message => message.toolCall ? [message.toolCall.id] : []) || []);
  const liveTools = conversation?.toolCalls?.filter(call => !historicalToolIds.has(call.id)) || [];
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
        ) : conversation?.messages.length ? (
          <>
            {conversation.messages
              .filter((message) => message.role !== "tool" || advanced || message.files?.length || message.toolCall || isAgentExchange(message))
              .map((message) => (
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
                    {message.createdAt && (
                      <time dateTime={message.createdAt}>
                        {new Date(message.createdAt).toLocaleTimeString([], {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </time>
                    )}
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
                  {!advanced && message.toolCall && !isAgentExchange(message) && <ActionReceipt call={message.toolCall} />}
                  {advanced && message.toolCall && !isAgentExchange(message) && <ToolCallDetail call={message.toolCall} disconnected={connectionLost} />}
                  {advanced && message.role === "tool" && !message.toolCall && (
                    <details className="message-detail tool-call-detail">
                      <summary>{message.toolName || "Tool result"}</summary>
                      <pre>{message.text || "No result was exposed by Hermes."}</pre>
                    </details>
                  )}
                  {message.files?.map((file) => (
                    <FileLink file={file} key={file.id} />
                  ))}
                </article>
              ))}
          </>
        ) : !showActivity ? (
          <div className="empty-state">
            <Avatar
              avatar={selected.avatar}
              state={avatarState}
              size={112}
              name={selected.name}
            />
            <h2>What’s on your mind?</h2>
            <p>
              Ask a question, share a file, or hand over something from your
              to-do list.
            </p>
            {!boot.capabilities.chat.supported && (
              <p className="muted">{boot.capabilities.chat.reason}</p>
            )}
          </div>
        ) : null}
        {advanced && liveTools.map(call => <article className="message message-tool" key={`tool-${call.id}`}>
          <ToolCallDetail call={call} disconnected={connectionLost} />
        </article>)}
        {selected && showActivity && (
          <div className={`activity-status conversation-activity message-activity state-${state}`}>
            <Avatar avatar={selected.avatar} state={state} size={52} name={selected.name} />
            <div className="activity-copy" role="status">
              <strong>{stateLabels[state]}</strong>
              <p>{connectionLost ? "Restoring activity when Hermes reconnects."
                : conversation?.activity.detail || (state === "thinking" ? "Considering your message."
                  : state === "working" ? "Working on your request." : "")}</p>
            </div>
            {active && (
              <button
                disabled={!boot.capabilities.stop.supported}
                title={boot.capabilities.stop.reason}
                onClick={() =>
                  void write(
                    `/bots/${encodeURIComponent(botId)}/stop`,
                    {},
                  ).catch((e) => setError(e.message))
                }
              >
                <Icon name="stop" size={14} /> Stop
              </button>
            )}
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
          .map((approval) => (
            <article className="approval-card" key={approval.id}>
              <p className="eyebrow">Your decision needed</p>
              <h2>{approval.title}</h2>
              <p>{approval.detail}</p>
              {approval.expiresAt && (
                <small>
                  Expires {new Date(approval.expiresAt).toLocaleString()}
                </small>
              )}
              <div className="actions">
                <button
                  className="primary"
                  disabled={!boot.capabilities.approvals.supported}
                  onClick={() =>
                    void write(
                      `/bots/${encodeURIComponent(botId)}/approvals/${encodeURIComponent(approval.id)}`,
                      { decision: "approved" },
                    ).catch((e) => setError(e.message))
                  }
                >
                  Approve
                </button>
                <button
                  disabled={!boot.capabilities.approvals.supported}
                  onClick={() =>
                    void write(
                      `/bots/${encodeURIComponent(botId)}/approvals/${encodeURIComponent(approval.id)}`,
                      { decision: "denied" },
                    ).catch((e) => setError(e.message))
                  }
                >
                  Decline
                </button>
              </div>
              <small>
                Either household member can decide. Hermes checks whether this
                request is still pending.
              </small>
            </article>
          ))}
      </div>
    </>
  );
}
function ToolCallDetail({ call, disconnected }: { call: ToolCall; disconnected?: boolean }) {
  return <details className="message-detail tool-call-detail" data-tool-call-id={call.id}>
    <summary><span>{call.name}</span><span className={`tool-call-status tool-call-${call.status}`}>{call.status === "running" ? disconnected ? "Last seen running" : "Running" : call.status === "failed" ? "Failed" : "Completed"}</span></summary>
    <dl>
      <div><dt>Call</dt><dd><code>{call.id}</code></dd></div>
      {call.startedAt && <div><dt>Started</dt><dd><time dateTime={call.startedAt}>{new Date(call.startedAt).toLocaleString()}</time></dd></div>}
      {call.completedAt && <div><dt>Finished</dt><dd><time dateTime={call.completedAt}>{new Date(call.completedAt).toLocaleString()}</time></dd></div>}
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
