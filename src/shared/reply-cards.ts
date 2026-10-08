import { z } from "zod";

const id = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/);
const title = z.string().trim().min(1).max(200);
const itemIds = <T extends { id: string }>(items: T[]) => new Set(items.map(item => item.id)).size === items.length;
const checklist = z.object({
  id, type: z.literal("checklist"), title,
  items: z.array(z.object({ id, text: z.string().trim().min(1).max(500) }).strict()).min(1).max(60)
    .refine(itemIds, "Item IDs must be unique"),
}).strict();
const itinerary = z.object({
  id, type: z.literal("itinerary"), title,
  items: z.array(z.object({
    id, title, time: z.string().max(100).optional(), detail: z.string().max(2000).optional(),
    url: z.string().url().max(2000).refine(url => /^https?:\/\//i.test(url)).optional(),
  }).strict()).min(1).max(60).refine(itemIds, "Item IDs must be unique"),
}).strict();
const event = z.object({
  id, type: z.literal("event"), title,
  start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }).optional(),
  location: z.string().max(500).optional(), description: z.string().max(4000).optional(),
}).strict().refine(card => !card.end || Date.parse(card.end) > Date.parse(card.start), "The event must end after it starts");
export const replyCardSchema = z.union([checklist, itinerary, event]);
export const replyDocumentSchema = z.object({
  version: z.literal(1), cards: z.array(replyCardSchema).min(1).max(8).refine(itemIds, "Card IDs must be unique"),
}).strict();
export type ReplyCard = z.infer<typeof replyCardSchema>;
export type EventCard = Extract<ReplyCard, { type: "event" }>;
export type ReplyDocument = z.infer<typeof replyDocumentSchema>;
export interface ReplyCardState { checkedIds: string[]; notes: Record<string, string> }

/** Invalid or oversized card blocks remain readable code rather than actionable UI. */
export function parseReplyDocument(code: string): ReplyDocument | null {
  if (code.length > 100_000) return null;
  try { const parsed = replyDocumentSchema.safeParse(JSON.parse(code)); return parsed.success ? parsed.data : null; }
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
