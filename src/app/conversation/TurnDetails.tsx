import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import type { Bot, FileRef, Message, ToolCall } from "../../shared/types";
import { Icon } from "../../components/Icon";
import { AgentExchange, AgentExchangeGroup, isAgentExchange } from "../../components/AgentExchange";
import { ActionReceipt } from "../../components/ActionReceipt";
import { When } from "../../components/When";
import { messageOrigin } from "../../shared/message-origin";
import { withoutBotTag } from "../../shared/event-copy";
import {
  imageSize,
  neverLeaves,
  readerSees,
  rememberImageSize,
  reshapes,
  rowOf,
  scrollerOf,
  type ImageSize,
} from "../image-sizes";
import { foldSummary, isHumanMessage, turnDuration, workGroups } from "../transcript-logic";
import type { useConversation } from "../use-conversation";

export function latestReasoning(messages: Message[]) {
  const start = messages.findLastIndex(isHumanMessage) + 1;
  const text =
    messages
      .slice(start)
      .findLast((message) => message.role === "assistant" && message.reasoning?.trim())
      ?.reasoning ?? "";
  return text
    .trim()
    .split("\n")
    .findLast((line) => line.trim())
    ?.trim();
}
// The sweep copy is hidden from assistive technology; see .shimmer-band for how it moves.
export function HistorySkeleton() {
  return (
    <div className="history-skeleton" role="status">
      <span className="sr-only">Opening your conversation…</span>
      {["reply", "prompt", "reply long"].map((kind) => (
        <div key={kind} className={`skeleton-message ${kind}`} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}
// Earlier turns load as the reader nears the top. The button serves keyboards and retries.
export function HistoryEdge({
  history,
  scroll,
  name,
  disabled,
}: {
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
    if (
      !automatic ||
      !edge.current ||
      !scroll.current ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadEarlier();
      },
      { root: scroll.current, rootMargin: "600px 0px 0px 0px" },
    );
    observer.observe(edge.current);
    return () => observer.disconnect();
  }, [automatic, loadEarlier, scroll]);
  if (history.complete)
    return (
      <p className="history-edge history-start">
        This is the start of your conversation with {name}.
      </p>
    );
  if (!earlier) return null;
  return (
    <div className="history-edge" ref={edge}>
      <button
        type="button"
        className="with-progress"
        disabled={loading || disabled}
        onClick={loadEarlier}
      >
        {loading && <Icon name="spinner" className="spin" size={16} />}
        {loading
          ? "Loading earlier messages…"
          : failed
            ? "Try loading earlier messages again"
            : "Show earlier messages"}
      </button>
    </div>
  );
}

export function ExchangeMessages({
  messages,
  recipient,
  sources,
}: {
  messages: Message[];
  recipient: string;
  sources: Map<string, string>;
}) {
  return (
    <AgentExchangeGroup messages={messages} recipient={recipient}>
      {messages.map((message) => (
        <article
          className="message message-agent"
          key={message.id}
          data-message-id={message.id}
          data-source-message-id={sources.get(message.id)}
        >
          <AgentExchange message={message} recipient={recipient} />
          {message.files?.map((file) => (
            <FileLink key={file.id} file={file} />
          ))}
        </article>
      ))}
    </AgentExchangeGroup>
  );
}
/**
 * One row for a turn's intermediate work: "Worked for 2m 14s · 3 tool calls, 1 subagent". Open, it
 * shows the grouped accordions as before, with reasoning first.
 */

export function TurnWork({
  work,
  reasoning,
  messages,
  advanced,
  disconnected,
  recipient,
  live,
}: {
  work: Message[];
  reasoning: string[];
  messages: Message[];
  advanced: boolean;
  disconnected: boolean;
  recipient: string;
  live: boolean;
}) {
  const summary = foldSummary(work, live ? undefined : turnDuration({ messages, work }), live);
  return (
    <details className="turn-work">
      <summary>
        <span>{summary}</span>
      </summary>
      <div className="turn-work-content">
        {reasoning.length > 0 && <Reasoning parts={reasoning} />}
        {work.length > 0 && (
          <ToolCalls
            messages={work}
            advanced={advanced}
            disconnected={disconnected}
            recipient={recipient}
          />
        )}
      </div>
    </details>
  );
}
/** The label for a person's message that names no sender, in a chat other members share. Matches the unresolved author in group chats (src/server/group-latest.ts). */

export const UNKNOWN_SENDER = "Household member";
/** Only its owner can see a personal assistant that is not shared, so nobody else writes in that chat. Mirrors `visible` in src/server/bot-access.ts. */
export const isPrivateAssistant = (bot: Bot) => bot.shared === false && !!bot.ownerId;
export const isReplyRow = (message: Message) =>
  message.role === "assistant" || messageOrigin(message)?.kind === "scheduled";

export function Reasoning({ parts }: { parts: string[] }) {
  const counts = new Map<string, number>();
  const keyed = parts.map((part) => {
    const seen = counts.get(part) ?? 0;
    counts.set(part, seen + 1);
    return { key: `${part.slice(0, 32)}:${seen}`, part };
  });
  return (
    <details className="tool-calls reasoning-calls">
      <summary>
        <Icon name="brain" size={16} />
        <span>Reasoning</span>
        {parts.length > 1 && <span className="tool-count">{parts.length}</span>}
      </summary>
      <div className="tool-calls-content">
        {keyed.map(({ key, part }) => (
          <p className="reasoning-part" key={key}>
            {part}
          </p>
        ))}
      </div>
    </details>
  );
}

export function ToolCalls({
  messages,
  advanced,
  disconnected,
  recipient,
}: {
  messages: Message[];
  advanced: boolean;
  disconnected: boolean;
  recipient: string;
}): ReactNode {
  return workGroups(messages).map((group) => (
    <details className="tool-calls" key={group.label}>
      <summary>
        <Icon name={group.label === "Subagents" ? "robot" : "terminal"} size={16} />
        <span>{group.label}</span>
        <span className="tool-count">{group.items.length}</span>
        {group.items.some((message) => message.toolCall?.status === "running") && (
          <span className="muted">{disconnected ? "Last seen running" : "Running"}</span>
        )}
      </summary>
      <div className="tool-calls-content">
        {group.items.map((message) => (
          <div key={message.id}>
            {isAgentExchange(message) ? (
              <AgentExchange message={message} recipient={recipient} />
            ) : message.toolCall ? (
              advanced ? (
                <ToolCallDetail call={message.toolCall} disconnected={disconnected} />
              ) : (
                <ActionReceipt call={message.toolCall} />
              )
            ) : (
              <details className="message-detail">
                <summary>
                  {withoutBotTag(messageOrigin(message)?.title ?? "") ||
                    message.toolName ||
                    group.label}
                  {message.createdAt && (
                    <>
                      {" "}
                      · <When value={message.createdAt} inline />
                    </>
                  )}
                </summary>
                <pre role="region" tabIndex={0} aria-label="Activity output">
                  {message.text || "No result was exposed by Hermes."}
                </pre>
              </details>
            )}
            {message.files?.map((file) => (
              <FileLink key={file.id} file={file} />
            ))}
          </div>
        ))}
      </div>
    </details>
  ));
}

export function ToolCallDetail({ call, disconnected }: { call: ToolCall; disconnected?: boolean }) {
  return (
    <details className="message-detail tool-call-detail" data-tool-call-id={call.id}>
      <summary>
        <span>{call.name}</span>
        <span className={`tool-call-status tool-call-${call.status}`}>
          {call.status === "running"
            ? disconnected
              ? "Last seen running"
              : "Running"
            : call.status === "failed"
              ? "Failed"
              : "Completed"}
        </span>
      </summary>
      <dl>
        <div>
          <dt>Call</dt>
          <dd>
            <code>{call.id}</code>
          </dd>
        </div>
        {call.startedAt && (
          <div>
            <dt>Started</dt>
            <dd>
              <When value={call.startedAt} />
            </dd>
          </div>
        )}
        {call.completedAt && (
          <div>
            <dt>Finished</dt>
            <dd>
              <When value={call.completedAt} />
            </dd>
          </div>
        )}
      </dl>
      {call.arguments !== undefined && (
        <>
          <h3>Arguments</h3>
          <pre role="region" tabIndex={0} aria-label={`Arguments for ${call.name}`}>
            {call.arguments}
          </pre>
        </>
      )}
      {call.result !== undefined && (
        <>
          <h3>Result</h3>
          <pre role="region" tabIndex={0} aria-label={`Result from ${call.name}`}>
            {call.result}
          </pre>
        </>
      )}
      {call.error && (
        <>
          <h3 className="danger">Error</h3>
          <pre className="danger" role="region" tabIndex={0} aria-label={`Error from ${call.name}`}>
            {call.error}
          </pre>
        </>
      )}
      {call.status === "running" && call.result === undefined && (
        <p>
          {disconnected
            ? "The current tool status will be checked when Hermes reconnects."
            : "Waiting for the result from Hermes."}
        </p>
      )}
    </details>
  );
}

export function FileLink({ file }: { file: FileRef }) {
  // The frame around the image holds its space: the image's natural shape when this page knows it, else the 4:3
  // frame in styles.css. A loaded image far from its frame's shape takes its own once (see reshapes), at once unless
  // the reader is looking at it, else as soon as nothing being read would move: the row left the view, or the reader
  // is back at the end (see readerSees). A row that no scroll can take out of view, as in a short thread, takes it at
  // once, since waiting would keep it letterboxed for good (see neverLeaves). One that fails leaves the frame as it
  // was. The frame, not the image, carries the shape, because a browser drops a failed image's aspect ratio.
  const [shape, setShape] = useState(() => imageSize(file.id));
  const [waiting, setWaiting] = useState<ImageSize>();
  const [failed, setFailed] = useState(false);
  const frame = useRef<HTMLSpanElement>(null);
  const href = file.url || `/api/files/${encodeURIComponent(file.id)}`;
  const image = file.mime.startsWith("image/");
  useEffect(() => {
    const element = frame.current;
    if (!waiting || !element) return;
    let done = false;
    const apply = () => {
      if (done) return;
      done = true;
      setShape(waiting);
      setWaiting(undefined);
    };
    const check = () => {
      if (!readerSees(element) || neverLeaves(element)) apply();
    };
    check();
    if (done) return;
    // Scrolling is how a reader leaves the row or comes back to the end; the observer also hears the row pushed away.
    const scroller = scrollerOf(element);
    scroller?.addEventListener("scroll", check, { passive: true });
    const observer =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(
            (entries) => {
              if (!entries.some((entry) => entry.isIntersecting)) apply();
            },
            { root: scroller },
          );
    observer?.observe(rowOf(element));
    return () => {
      scroller?.removeEventListener("scroll", check);
      observer?.disconnect();
    };
  }, [waiting]);
  // The card's width follows the frame's ratio, so an image the height cap binds, such as a tall screenshot, keeps
  // its own shape in a narrower card instead of sitting between bars. See `.file-image` in styles.css.
  const ratio = shape ? shape.width / shape.height : undefined;
  return (
    <a
      className={`file-link${image ? " file-image" : ""}`}
      href={href}
      target="_blank"
      rel="noreferrer"
      style={ratio ? ({ "--file-ratio": ratio } as CSSProperties) : undefined}
    >
      {image && (
        <span
          className="file-frame"
          ref={frame}
          style={shape && { aspectRatio: `${shape.width} / ${shape.height}` }}
        >
          {failed ? (
            <span className="file-failed">
              <Icon name="file" size={20} />
              Couldn't load this image
            </span>
          ) : (
            <img
              src={href}
              alt={file.name}
              loading="lazy"
              decoding="async"
              onError={() => setFailed(true)}
              onLoad={(event) => {
                const loaded = {
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                };
                rememberImageSize(file.id, event.currentTarget);
                if (!reshapes(shape, loaded)) return;
                if (frame.current && readerSees(frame.current)) setWaiting(loaded);
                else setShape(loaded);
              }}
            />
          )}
        </span>
      )}
      <span className="file-name">
        <Icon name={image ? "download" : "file"} size={16} /> {file.name}
      </span>
    </a>
  );
}
