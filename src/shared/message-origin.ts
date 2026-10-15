import type { Message, MessageOrigin } from "./types";
import { agentEnvelope } from "./collaboration";

const kinds = new Set(["human", "agent", "scheduled", "subagent", "process", "diagnostic"]);
const bounded = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : undefined;
export const activityLabels: Record<MessageOrigin["kind"], string> = {
  human: "Messages", agent: "Bot messages", scheduled: "Scheduled jobs", subagent: "Subagents", process: "Background processes", diagnostic: "Diagnostics",
};
/** Narrow legacy envelopes are display hints only. Missing attribution alone proves nothing. */
export function messageOrigin(message: Message): MessageOrigin | undefined {
  if (message.role === "user" && message.sender) return { kind: "human", visibility: "conversation" };
  if (message.origin) return message.origin;
  const envelope = agentEnvelope(message);
  if (envelope) return { kind: "agent", visibility: "activity", name: envelope.name, handle: envelope.handle };
  if (message.role === "user") {
    const cron = /^\[Cronjob "([^\n]+)" output [—-] scheduled job,? not the user\. Review it, act on anything that needs action, and summarize for the chat\.\]/u.exec(message.text);
    if (cron) return { kind: "scheduled", visibility: "activity", title: cron[1] };
    if (/^\[Cron delivery: [^\n\]]+\]/u.test(message.text)) return { kind: "scheduled", visibility: "conversation", title: "Scheduled result" };
    if (/^(?:Subagent Tasks? (?:Completed|Failed|Interrupted|Incomplete):|\[IMPORTANT: (?:Background )?[Ss]ubagent|\[ASYNC (?:DELEGATION )?(?:BATCH )?COMPLETE\b|A background (?:subagent|fan-out of \d+ subagent\(s\)) you dispatched earlier has finished\.)/u.test(message.text)) return { kind: "subagent", visibility: "activity" };
    if (/^(?:Background Process (?:Completed|Failed|Output|Interrupted)|\[IMPORTANT: Background process |\[Background process \S+ heartbeat #)/u.test(message.text)) return { kind: "process", visibility: "activity" };
  }
  const names = (message.toolCall?.name || message.toolName || "").split(",").map(name => name.trim());
  const kind = names.includes("message_agent") ? "agent" : names.some(name => /^(delegate_task|spawn_agent|subagent|task)$/.test(name)) ? "subagent" : undefined;
  if (kind && (message.role === "tool" || !message.text.trim())) return { kind, visibility: "activity" };
  return undefined;
}
export const isActivityMessage = (message: Message) => messageOrigin(message)?.visibility === "activity";
export const isConversationReply = (message: Message) => message.role === "assistant" && !isActivityMessage(message) && (!!message.text.trim() || !!message.files?.length);

/** Normalize the upstream display contract at the wire boundary; unknown types stay visible. */
export function wireOrigin(message: Message, row: Record<string, unknown>): MessageOrigin | undefined {
  if (row.app_sender_id || message.sender) return { kind: "human", visibility: "conversation" };
  const metadata = row.display_metadata && typeof row.display_metadata === "object" ? row.display_metadata as Record<string, unknown> : {};
  const raw = metadata.origin && typeof metadata.origin === "object" ? metadata.origin as Record<string, unknown> : {};
  if (kinds.has(String(raw.kind)) && ["conversation", "activity"].includes(String(raw.visibility))) {
    return { kind: raw.kind as MessageOrigin["kind"], visibility: raw.visibility as MessageOrigin["visibility"], title: bounded(raw.title), name: bounded(raw.name), handle: bounded(raw.handle) };
  }
  if (metadata.notification_category === "diagnostic") return { kind: "diagnostic", visibility: "activity" };
  const displayKinds: Record<string, MessageOrigin["kind"]> = { async_delegation_complete: "subagent", process_complete: "process", process_completion: "process", process_watch: "process", process_heartbeat: "process", auto_continue: "process" };
  const kind = Object.hasOwn(displayKinds, String(row.display_kind)) ? displayKinds[String(row.display_kind)] : undefined;
  if (row.display_kind === "internal_notification") return messageOrigin(message) ?? { kind: "process", visibility: "activity", title: bounded(metadata.display_text) };
  return kind ? { kind, visibility: "activity", title: row.display_kind === "auto_continue" ? "Resumed work" : bounded(metadata.display_text) } : messageOrigin(message);
}
/** Responses inherit provenance until the next user prompt, including desktop prompts. */
export function withMessageOrigins(messages: Message[], seed?: MessageOrigin): Message[] {
  let prompt = seed;
  return messages.map(message => {
    const own = messageOrigin(message);
    if (message.role === "user") prompt = own?.kind === "human" ? undefined : own;
    if (own || message.role !== "assistant" || !prompt) return own ? { ...message, origin: own } : message;
    const visibility = ["agent", "diagnostic"].includes(prompt.kind) ? "activity" : "conversation";
    return { ...message, origin: { ...prompt, visibility } };
  });
}
