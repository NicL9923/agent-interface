import type { EmailCard } from "./reply-cards";
import { replyCardsFromText } from "./reply-cards";

/**
 * Word changes between an email draft and the draft it revises. iOS mirrors this in DraftDiff.swift,
 * and ios/AgentInterfaceTests/Vectors/draft-diff.json holds both to the same output, so keep the
 * tokens, tie-breaks and grouping identical when changing either.
 */
export type DiffPart = { kind: "same" | "added" | "removed"; text: string };
/** Past this many compared token pairs, after the shared start and end, the middle shows as replaced whole. */
export const DIFF_CELL_LIMIT = 1_000_000;

// Runs of spaces, tabs and line breaks, and runs of everything else. Only these four count as space,
// so both clients split the same way whatever their idea of Unicode whitespace.
const tokens = (text: string) => text.match(/[ \t\r\n]+|[^ \t\r\n]+/g) ?? [];
const blank = (text: string) => /^[ \t\r\n]+$/.test(text);

export function wordDiff(before: string, after: string, limit = DIFF_CELL_LIMIT): DiffPart[] {
  const a = tokens(before), b = tokens(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const raw: DiffPart[] = a.slice(0, start).map(text => ({ kind: "same", text }));
  const n = endA - start, m = endB - start;
  if (n * m > limit) {
    raw.push(...a.slice(start, endA).map(text => ({ kind: "removed" as const, text })), ...b.slice(start, endB).map(text => ({ kind: "added" as const, text })));
  } else {
    // lengths[i * (m + 1) + j]: the longest common run of a[start + i..] and b[start + j..].
    const lengths = new Int32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      lengths[i * (m + 1) + j] = a[start + i] === b[start + j] ? lengths[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(lengths[(i + 1) * (m + 1) + j], lengths[i * (m + 1) + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) { raw.push({ kind: "same", text: a[start + i] }); i++; j++; }
      // On a tie, removal goes first.
      else if (lengths[(i + 1) * (m + 1) + j] >= lengths[i * (m + 1) + j + 1]) { raw.push({ kind: "removed", text: a[start + i] }); i++; }
      else { raw.push({ kind: "added", text: b[start + j] }); j++; }
    }
    for (; i < n; i++) raw.push({ kind: "removed", text: a[start + i] });
    for (; j < m; j++) raw.push({ kind: "added", text: b[start + j] });
  }
  raw.push(...a.slice(endA).map(text => ({ kind: "same" as const, text })));
  return group(raw);
}

/** Joins runs, folds a lone space between two changes into them, and puts each change's removals before its additions. */
function group(raw: DiffPart[]): DiffPart[] {
  const merged: DiffPart[] = [];
  for (const part of raw) {
    const last = merged.at(-1);
    if (last && last.kind === part.kind) last.text += part.text;
    else merged.push({ ...part });
  }
  const parts: DiffPart[] = [];
  let removed = "", added = "";
  const flush = () => {
    if (removed) parts.push({ kind: "removed", text: removed });
    if (added) parts.push({ kind: "added", text: added });
    removed = added = "";
  };
  merged.forEach((part, index) => {
    const between = part.kind === "same" && blank(part.text) && index > 0 && index < merged.length - 1;
    if (part.kind === "removed" || between) removed += part.text;
    if (part.kind === "added" || between) added += part.text;
    if (part.kind === "same" && !between) { flush(); parts.push(part); }
  });
  flush();
  return parts;
}

/** One address in a recipient list and whether the revision kept, added or removed it. */
export type AddressPart = { kind: DiffPart["kind"]; address: string };
/** Recipient lists compare address by address: an address holds no spaces, so each is one token. */
export function addressDiff(before: string[] = [], after: string[] = []): AddressPart[] {
  return wordDiff(before.join(" "), after.join(" ")).flatMap(part => part.text.split(" ").filter(Boolean).map(address => ({ kind: part.kind, address })));
}
export type DraftChanges = { to: AddressPart[]; cc: AddressPart[]; subject: DiffPart[]; body: DiffPart[]; changed: boolean };
/** What changed from `previous` to `current`, field by field. */
export function draftChanges(previous: EmailCard, current: EmailCard): DraftChanges {
  const to = addressDiff(previous.to, current.to), cc = addressDiff(previous.cc, current.cc);
  const subject = wordDiff(previous.subject ?? "", current.subject ?? ""), body = wordDiff(previous.body, current.body);
  return { to, cc, subject, body, changed: [...to, ...cc, ...subject, ...body].some(part => part.kind !== "same") };
}

/** Where an email card sits: the reply's message ID and the card's ID. */
export const draftKey = (messageId: string, cardId: string) => `${messageId}\n${cardId}`;
/**
 * The earlier draft each email card revises, by draftKey. Only explicit lineage counts: a card's
 * `revises` names the `draftId` of a card earlier in this conversation, and the latest such card
 * wins. Subjects and recipients are never matched. A card naming itself or a later card revises nothing.
 */
export function draftRevisions(messages: { id: string; role: string; text: string }[]): Map<string, EmailCard> {
  const drafts = new Map<string, EmailCard>(), revisions = new Map<string, EmailCard>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const card of replyCardsFromText(message.text)) {
      if (card.type !== "email") continue;
      const previous = card.revises ? drafts.get(card.revises) : undefined;
      if (previous) revisions.set(draftKey(message.id, card.id), previous);
      if (card.draftId) drafts.set(card.draftId, card);
    }
  }
  return revisions;
}
