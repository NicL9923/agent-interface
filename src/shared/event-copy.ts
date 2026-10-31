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

/** A routine's name as people know it, without the "[bot:<id>] " owner tag Hermes keeps on it. */
export const withoutBotTag = (title: string) => title.replace(/^\[bot:[^\]\s]+\]\s*/, "");

/** What happened, in one line: the reply, the decision needed, or why it stopped. */
export function eventHeadline(event: Pick<RuntimeEvent, "kind" | "title" | "body" | "routineId">) {
  // Approval details can include commands and credentials, even in a custom title; they stay in the signed-in chat.
  if (event.kind === "approval") return "Needs your approval to continue.";
  const body = excerpt(event.body);
  if (!generic.test(event.title)) {
    const title = excerpt(withoutBotTag(event.title), 80);
    // A routine's name alone reads as success, so a failed or stopped run says so.
    if (event.routineId && event.kind === "failed") return body ? `${title} couldn't finish: ${body}` : `${title} couldn't finish. Open it to see what happened.`;
    if (event.routineId && event.kind === "interrupted") return body ? `${title} stopped: ${body}` : `${title} stopped before finishing.`;
    return body ? `${title}: ${body}` : title;
  }
  switch (event.kind) {
    case "failed": return body ? `Couldn't finish: ${body}` : "Couldn't finish. Open the chat to see what happened.";
    case "interrupted": return body || "Stopped before finishing. Review it before retrying.";
    default: return body || "Finished. Open the chat for the reply.";
  }
}

/** Notification copy: a short title naming the assistant, and a specific body. */
export function notificationCopy(event: Pick<RuntimeEvent, "kind" | "title" | "body" | "routineId">, botName?: string) {
  // An approval's own title could quote its command, so it never stands in for the assistant's name.
  const fallback = event.kind === "approval" || generic.test(event.title) ? "Assistant" : excerpt(withoutBotTag(event.title), 60);
  return { title: botName || fallback, body: eventHeadline(event) };
}

/**
 * One notification for several held updates, each already titled with its assistant. One
 * assistant's updates name it once; several assistants' name each beside what it said.
 */
export function digestCopy(updates: { title: string; body: string }[]) {
  const names = [...new Set(updates.map(update => update.title))];
  const count = `${updates.length} update${updates.length === 1 ? "" : "s"}`;
  const one = names.length === 1;
  return {
    title: one ? `${count} from ${names[0]}` : `${count} from ${names.length} assistants`,
    body: excerpt(updates.map(update => one ? update.body : `${update.title}: ${update.body}`).join(" · "), 240),
  };
}
