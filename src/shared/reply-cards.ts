// Hand-written guards rather than a schema library: this module reaches the browser, and a
// schema library would ship to every phone for these few shapes. They accept exactly what the
// schemas they replace did, including trimmed text and strict objects with no extra keys.
export interface ChecklistCard { id: string; type: "checklist"; title: string; items: { id: string; text: string }[] }
export interface ItineraryCard {
  id: string; type: "itinerary"; title: string;
  items: { id: string; title: string; time?: string; detail?: string; url?: string }[];
}
export interface EventCard { id: string; type: "event"; title: string; start: string; end?: string; location?: string; description?: string }
export type ReplyCard = ChecklistCard | ItineraryCard | EventCard;
export interface ReplyDocument { version: 1; cards: ReplyCard[] }
export interface ReplyCardState { checkedIds: string[]; notes: Record<string, string> }

type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
/** Whether the object holds only the named keys. */
const only = (value: Fields, keys: string[]) => Object.keys(value).every(name => keys.includes(name));
const text = (value: unknown, max: number, min = 0, trim = false) => {
  if (typeof value !== "string") return null;
  const result = trim ? value.trim() : value;
  return result.length >= min && result.length <= max ? result : null;
};
/** An optional text field: absent is fine (undefined), present must be valid (null if not). */
const optional = (value: Fields, name: string, max: number) => Object.hasOwn(value, name) ? text(value[name], max) : undefined;
const identifier = (value: unknown) => {
  const result = text(value, 80, 1);
  return result !== null && /^[a-zA-Z0-9_-]+$/.test(result) ? result : null;
};
const title = (value: unknown) => text(value, 200, 1, true);
// The URL parser ignores tabs and line breaks, so the stored link must not contain them either.
function link(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  try { new URL(trimmed); } catch { return null; }
  const result = trimmed.replace(/[\t\n\r]/g, "");
  return result.length <= 2000 && /^https?:\/\//i.test(result) ? result : null;
}
// Month lengths and leap days, so "2026-02-30" is not a date.
const date = /(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|02-(?:0[1-9]|1\d|2[0-8])))/;
// A real calendar date and clock time with seconds and an explicit Z or offset: no floating times.
const timestamp = new RegExp(`^${date.source}T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)$`);
const instant = (value: unknown) => typeof value === "string" && timestamp.test(value) ? value : null;
/** Entries that all parse and carry distinct IDs, or null. */
function entries<T extends { id: string }>(value: unknown, max: number, parse: (entry: unknown) => T | null) {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) return null;
  const parsed: T[] = [];
  for (const entry of value) {
    const result = parse(entry);
    if (!result) return null;
    parsed.push(result);
  }
  return new Set(parsed.map(item => item.id)).size === parsed.length ? parsed : null;
}

function checklist(card: Fields): ChecklistCard | null {
  const id = identifier(card.id), name = title(card.title);
  const items = entries(card.items, 60, entry => {
    if (!isFields(entry) || !only(entry, ["id", "text"])) return null;
    const itemId = identifier(entry.id), itemText = text(entry.text, 500, 1, true);
    return itemId !== null && itemText !== null ? { id: itemId, text: itemText } : null;
  });
  return only(card, ["id", "type", "title", "items"]) && id !== null && name !== null && items
    ? { id, type: "checklist", title: name, items } : null;
}
function itinerary(card: Fields): ItineraryCard | null {
  const id = identifier(card.id), name = title(card.title);
  const items = entries(card.items, 60, entry => {
    if (!isFields(entry) || !only(entry, ["id", "title", "time", "detail", "url"])) return null;
    const itemId = identifier(entry.id), itemTitle = title(entry.title);
    const time = optional(entry, "time", 100), detail = optional(entry, "detail", 2000);
    const url = Object.hasOwn(entry, "url") ? link(entry.url) : undefined;
    if (itemId === null || itemTitle === null || time === null || detail === null || url === null) return null;
    return { id: itemId, title: itemTitle, ...(time !== undefined && { time }), ...(detail !== undefined && { detail }), ...(url !== undefined && { url }) };
  });
  return only(card, ["id", "type", "title", "items"]) && id !== null && name !== null && items
    ? { id, type: "itinerary", title: name, items } : null;
}
function event(card: Fields): EventCard | null {
  const id = identifier(card.id), name = title(card.title), start = instant(card.start);
  const end = Object.hasOwn(card, "end") ? instant(card.end) : undefined;
  const location = optional(card, "location", 500), description = optional(card, "description", 4000);
  if (!only(card, ["id", "type", "title", "start", "end", "location", "description"]) ||
    id === null || name === null || start === null || end === null || location === null || description === null) return null;
  if (end !== undefined && !(Date.parse(end) > Date.parse(start))) return null; // The event must end after it starts.
  return { id, type: "event", title: name, start, ...(end !== undefined && { end }), ...(location !== undefined && { location }), ...(description !== undefined && { description }) };
}
function replyCard(value: unknown): ReplyCard | null {
  if (!isFields(value)) return null;
  return value.type === "checklist" ? checklist(value) : value.type === "itinerary" ? itinerary(value) : value.type === "event" ? event(value) : null;
}
function replyDocument(value: unknown): ReplyDocument | null {
  if (!isFields(value) || !only(value, ["version", "cards"]) || value.version !== 1) return null;
  const cards = entries(value.cards, 8, replyCard); // Card IDs must be unique.
  return cards ? { version: 1, cards } : null;
}

/** Invalid or oversized card blocks remain readable code rather than actionable UI. */
export function parseReplyDocument(code: string): ReplyDocument | null {
  if (code.length > 100_000) return null;
  try { return replyDocument(JSON.parse(code)); }
  catch { return null; }
}
export function replyCardsFromText(text: string): ReplyCard[] {
  const cards: ReplyCard[] = [];
  const ids = new Set<string>();
  for (const match of text.matchAll(/^```agent-ui\s*\n([\s\S]*?)^```\s*$/gm)) {
    for (const card of parseReplyDocument(match[1])?.cards || []) {
      if (ids.has(card.id)) return []; // Ambiguous IDs cannot target saved state safely.
      ids.add(card.id); cards.push(card);
    }
  }
  return cards.length <= 8 ? cards : [];
}
export function validReplyCardState(card: ReplyCard, state: ReplyCardState): boolean {
  const ids = new Set(card.type === "event" ? [] : card.items.map(item => item.id));
  return state.checkedIds.length <= 60 && new Set(state.checkedIds).size === state.checkedIds.length &&
    state.checkedIds.every(id => card.type === "checklist" && ids.has(id)) &&
    Object.entries(state.notes).length <= 60 && Object.entries(state.notes).every(([id, note]) =>
      card.type === "itinerary" && ids.has(id) && typeof note === "string" && note.length <= 2000);
}

const calendarStamp = (value: string) => new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const calendarEscape = (value: string) => value.replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
// Fold on UTF-8 octet boundaries as required by RFC 5545, without splitting Unicode.
function calendarLine(value: string) {
  const lines: string[] = []; let line = ""; let length = 0;
  for (const character of value) {
    const bytes = new TextEncoder().encode(character).length;
    if (length + bytes > 75) { lines.push(line); line = " "; length = 1; }
    line += character; length += bytes;
  }
  lines.push(line); return lines.join("\r\n");
}
export function eventCalendarFile(card: EventCard, now = new Date()): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//WildBots//Event proposal//EN", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
    `UID:${card.id}-${calendarStamp(card.start)}@agent-interface`, `DTSTAMP:${calendarStamp(now.toISOString())}`,
    `DTSTART:${calendarStamp(card.start)}`, ...(card.end ? [`DTEND:${calendarStamp(card.end)}`] : []),
    `SUMMARY:${calendarEscape(card.title)}`, ...(card.location ? [`LOCATION:${calendarEscape(card.location)}`] : []),
    ...(card.description ? [`DESCRIPTION:${calendarEscape(card.description)}`] : []), "END:VEVENT", "END:VCALENDAR"]
    .map(calendarLine).join("\r\n") + "\r\n";
}
export function eventGoogleCalendarUrl(card: EventCard): string {
  const url = new URL("https://calendar.google.com/calendar/render");
  url.searchParams.set("action", "TEMPLATE"); url.searchParams.set("text", card.title);
  url.searchParams.set("dates", `${calendarStamp(card.start)}/${calendarStamp(card.end || card.start)}`);
  if (card.location) url.searchParams.set("location", card.location);
  if (card.description) url.searchParams.set("details", card.description);
  return url.toString();
}

export const interactiveReplyInstructions = `When a checklist, itinerary, or calendar proposal would help, include a fenced agent-ui JSON block alongside a short explanation. Use {"version":1,"cards":[...]}. Each card needs a unique stable id and title. A checklist is {"id":"groceries","type":"checklist","title":"Groceries","items":[{"id":"milk","text":"Milk"}]}. An itinerary is {"id":"trip","type":"itinerary","title":"Our trip","items":[{"id":"stop1","title":"First stop","time":"Saturday, 10 AM","detail":"Details","url":"https://example.com"}]}. An event is {"id":"dinner","type":"event","title":"Dinner","start":"2026-10-03T18:00:00-05:00","end":"2026-10-03T19:00:00-05:00","location":"Home","description":"Details"}. IDs use letters, digits, underscores or hyphens. Include only useful fields, at most 8 cards and 60 items per card. Event timestamps require a confirmed date and timezone offset; ask when those are unknown. Cards are proposals, never evidence that a calendar event or other external action was created.`;
