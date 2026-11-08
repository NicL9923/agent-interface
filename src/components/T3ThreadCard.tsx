import type { T3Thread } from "../shared/t3-code";
import { Icon } from "./Icon";
import "./t3-thread.css";

const headings: Record<T3Thread["state"], string> = { starting: "Starting a T3 Code thread", started: "T3 Code thread started", failed: "T3 Code thread didn't start" };

/**
 * A T3 Code thread the assistant started, shown in the turn rather than folded into its tool calls,
 * so Open is one tap away. WildBots cannot read T3 Code, so the card says what happened at launch
 * and leaves the thread's progress to T3 Code.
 */
export function T3ThreadCard({ thread }: { thread: T3Thread }) {
  const facts = [thread.model, thread.workspace, thread.plan ? "Plan mode" : undefined].filter(Boolean);
  return <section className={`t3-thread-card is-${thread.state}`} aria-label={`${headings[thread.state]}: ${thread.title}`}>
    <p className="eyebrow t3-thread-eyebrow">
      <Icon name={thread.state === "starting" ? "spinner" : thread.state === "failed" ? "alert" : "terminal"} className={thread.state === "starting" ? "spin" : undefined} size={14} />
      {headings[thread.state]}
    </p>
    <h3>{thread.title}</h3>
    {thread.prompt && <p className="t3-thread-prompt">{thread.prompt}</p>}
    {facts.length > 0 && <ul className="t3-thread-facts">{facts.map(fact => <li key={fact}>{fact}</li>)}</ul>}
    {thread.error && <p className="form-error">{thread.error}</p>}
    {thread.url ? <a className="button-link primary t3-thread-open" href={thread.url} target="_blank" rel="noopener noreferrer">
      Open in T3 Code <Icon name="external" size={16} />
    </a> : thread.state === "started" && <p className="muted">Open T3 Code to find this thread.</p>}
  </section>;
}
