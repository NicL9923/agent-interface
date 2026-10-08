import type { RuntimeEvent } from "./types.js";

// The add-on titles task events generically; the assistant's name and its own words say more.
const generic = /^(Hermes (completed|failed|interrupted)|Approval requested)$/;

/** Plain, single-line text from a Markdown reply, cut at a word near `limit`. */
export function excerpt(text: string | undefined, limit = 180) {
  const plain = (text ?? "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)]|>)\s+/gm, "")
    .replace(/(\*\*|__|`|~~)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= limit) return plain;
  const cut = plain.slice(0, limit);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), limit * 0.6)).replace(/[\s,;:.–-]+$/, "")}…`;
}

/** What happened, in one line: the reply, the decision needed, or why it stopped. */
export function eventHeadline(event: Pick<RuntimeEvent, "kind" | "title" | "body">) {
  const body = excerpt(event.body);
  if (!generic.test(event.title)) return body ? `${excerpt(event.title, 80)}: ${body}` : excerpt(event.title);
  switch (event.kind) {
    case "approval": return body ? `Needs your approval: ${body}` : "Needs your approval to continue.";
    case "failed": return body ? `Couldn't finish: ${body}` : "Couldn't finish. Open the chat to see what happened.";
    case "interrupted": return body || "Stopped before finishing. Review it before retrying.";
    default: return body || "Finished. Open the chat for the reply.";
  }
}

/** Notification copy: a short title naming the assistant, and a specific body. */
export function notificationCopy(event: Pick<RuntimeEvent, "kind" | "title" | "body">, botName?: string) {
  return { title: botName || (generic.test(event.title) ? "Assistant" : excerpt(event.title, 60)), body: eventHeadline(event) };
}
