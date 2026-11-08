// Frozen copy of src/shared/reply-cards.ts as #264 merged it on main (c2fae16): the parser the first
// clients with email cards run. Tests feed it what this release sends, so a card it would refuse fails here.
// Never update it to match the current parser.
// Hand-written guards rather than a schema library: this module reaches the browser, and a
// schema library would ship to every phone for these few shapes. They accept exactly what the
// schemas they replace did, including trimmed text and strict objects with no extra keys.
export interface ChecklistCard { id: string; type: "checklist"; title: string; items: { id: string; text: string }[] }
export interface ItineraryCard {
  id: string; type: "itinerary"; title: string;
  items: { id: string; title: string; time?: string; detail?: string; url?: string }[];
}
export interface EventCard { id: string; type: "event"; title: string; start: string; end?: string; location?: string; description?: string }
/** An email the assistant drafted. Nothing is sent: the person copies it or opens it in their mail app. */
export interface EmailCard { id: string; type: "email"; title: string; to?: string[]; cc?: string[]; subject?: string; body: string }
export const formFieldKinds = ["text", "textarea", "number", "date", "select", "choice", "multi", "toggle"] as const;
export type FormFieldKind = (typeof formFieldKinds)[number];
/** A value a form field starts with, or a person's answer: text for most kinds, a list for multi, a switch for toggle. */
export type FormValue = string | string[] | boolean;
export interface FormField {
  id: string; label: string; kind: FormFieldKind;
  required?: boolean; help?: string; placeholder?: string;
  /** The choices for select, choice and multi, and only for them. */
  options?: string[];
  value?: FormValue;
}
/** Questions the person answers in place. Sending posts the answers to the assistant as the person's own message. */
export interface FormCard { id: string; type: "form"; title: string; description?: string; submitLabel?: string; fields: FormField[] }
export type ReplyCard = ChecklistCard | ItineraryCard | EventCard | EmailCard | FormCard;
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
// A single address, as people write them: no display names, spaces or list separators.
const address = (value: unknown) => {
  const result = text(value, 254, 3, true);
  return result !== null && /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/.test(result) ? result : null;
};
/** An optional list of addresses: absent is fine, present must hold 1 to 20 valid ones. */
function addresses(card: Fields, name: string) {
  if (!Object.hasOwn(card, name)) return undefined;
  const value = card[name];
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return null;
  const parsed = value.map(address);
  return parsed.every(entry => entry !== null) ? parsed as string[] : null;
}
function email(card: Fields): EmailCard | null {
  const id = identifier(card.id), name = title(card.title), to = addresses(card, "to"), cc = addresses(card, "cc");
  const subject = Object.hasOwn(card, "subject") ? text(card.subject, 500, 1, true) : undefined;
  const body = text(card.body, 20_000, 1);
  if (!only(card, ["id", "type", "title", "to", "cc", "subject", "body"]) || id === null || name === null || to === null || cc === null
    || subject === null || body === null || !body.trim()) return null;
  return { id, type: "email", title: name, ...(to && { to }), ...(cc && { cc }), ...(subject !== undefined && { subject }), body };
}
const choiceKinds: readonly FormFieldKind[] = ["select", "choice", "multi"];
// A real calendar day, as a date input reports it.
const day = new RegExp(`^${date.source}$`);
// HTML's valid floating-point number, the only text a number input shows: no hex, no "Infinity", no "1.".
const decimal = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
/** Whether a starting value suits its field: one of its options, a real day, a number, or a switch. */
function fitsField(field: Omit<FormField, "value">, value: unknown): value is FormValue {
  switch (field.kind) {
    case "toggle": return typeof value === "boolean";
    case "multi": return Array.isArray(value) && value.length <= field.options!.length && new Set(value).size === value.length
      && value.every(entry => typeof entry === "string" && field.options!.includes(entry));
    case "select": case "choice": return typeof value === "string" && field.options!.includes(value);
    case "date": return typeof value === "string" && day.test(value);
    case "number": return typeof value === "string" && decimal.test(value) && Number.isFinite(Number(value));
    default: return typeof value === "string" && value.length <= 4000;
  }
}
function formField(entry: unknown): FormField | null {
  if (!isFields(entry) || !only(entry, ["id", "label", "kind", "required", "help", "placeholder", "options", "value"])) return null;
  const id = identifier(entry.id), label = title(entry.label);
  const kind = formFieldKinds.find(known => known === entry.kind);
  const help = optional(entry, "help", 500), placeholder = optional(entry, "placeholder", 200);
  if (id === null || label === null || !kind || help === null || placeholder === null) return null;
  if (Object.hasOwn(entry, "required") && typeof entry.required !== "boolean") return null;
  // Options belong to the kinds that choose among them, and those kinds need at least one.
  const choosing = choiceKinds.includes(kind);
  if (choosing !== Object.hasOwn(entry, "options")) return null;
  let options: string[] | undefined;
  if (choosing) {
    if (!Array.isArray(entry.options) || entry.options.length < 1 || entry.options.length > 20) return null;
    const parsed = entry.options.map(option => text(option, 200, 1, true));
    if (parsed.some(option => option === null) || new Set(parsed).size !== parsed.length) return null;
    options = parsed as string[];
  }
  const field: FormField = { id, label, kind, ...(entry.required === true && { required: true }), ...(help !== undefined && { help }),
    ...(placeholder !== undefined && { placeholder }), ...(options && { options }) };
  // A number may arrive as JSON's number; the field keeps the text a number input holds.
  const value = kind === "number" && typeof entry.value === "number" ? String(entry.value) : entry.value;
  if (!Object.hasOwn(entry, "value")) return field;
  return fitsField(field, value) ? { ...field, value } : null;
}
function form(card: Fields): FormCard | null {
  const id = identifier(card.id), name = title(card.title);
  const description = optional(card, "description", 2000);
  const submitLabel = Object.hasOwn(card, "submitLabel") ? text(card.submitLabel, 40, 1, true) : undefined;
  const fields = entries(card.fields, 20, formField);
  if (!only(card, ["id", "type", "title", "description", "submitLabel", "fields"]) || id === null || name === null
    || description === null || submitLabel === null || !fields) return null;
  return { id, type: "form", title: name, ...(description !== undefined && { description }), ...(submitLabel !== undefined && { submitLabel }), fields };
}
const parsers: Record<string, (card: Fields) => ReplyCard | null> = { checklist, itinerary, event, email, form };
function replyCard(value: unknown): ReplyCard | null {
  if (!isFields(value) || typeof value.type !== "string" || !Object.hasOwn(parsers, value.type)) return null;
  return parsers[value.type](value);
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
/** Card types whose checks or notes the server saves for each person. The others hold nothing. */
export const savesState = (card: ReplyCard): card is ChecklistCard | ItineraryCard => card.type === "checklist" || card.type === "itinerary";
export function validReplyCardState(card: ReplyCard, state: ReplyCardState): boolean {
  const ids = new Set(savesState(card) ? card.items.map(item => item.id) : []);
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

// RFC 6068 wants line breaks in a mailto body as CRLF.
const mailText = (value: string) => encodeURIComponent(value.replace(/\r\n|\r|\n/g, "\r\n"));
/** A mailto link that opens the draft in the device's mail app. Addresses keep their @ readable. */
export function emailMailtoUrl(card: EmailCard): string {
  const query = [card.cc && `cc=${card.cc.map(encodeURIComponent).join(",")}`, card.subject && `subject=${mailText(card.subject)}`, `body=${mailText(card.body)}`]
    .filter(Boolean).join("&");
  return `mailto:${(card.to ?? []).map(encodeURIComponent).join(",").replace(/%40/g, "@")}?${query.replace(/%40/g, "@")}`;
}
/** Gmail's compose window with the draft filled in. Nothing sends until the person presses Send there. */
export function emailGmailUrl(card: EmailCard): string {
  const url = new URL("https://mail.google.com/mail/");
  url.searchParams.set("view", "cm"); url.searchParams.set("fs", "1");
  if (card.to) url.searchParams.set("to", card.to.join(","));
  if (card.cc) url.searchParams.set("cc", card.cc.join(","));
  if (card.subject) url.searchParams.set("su", card.subject);
  url.searchParams.set("body", card.body);
  return url.toString();
}
/** The whole draft as plain text, for pasting into any mail app. */
export function emailText(card: EmailCard): string {
  const headers = [card.to && `To: ${card.to.join(", ")}`, card.cc && `Cc: ${card.cc.join(", ")}`, card.subject && `Subject: ${card.subject}`]
    .filter((line): line is string => !!line);
  return headers.length ? `${headers.join("\n")}\n\n${card.body}` : card.body;
}

/** A person's answers, by field ID. */
export type FormAnswers = Record<string, FormValue>;
/**
 * A field's entry in a map keyed by field ID. Field IDs are the assistant's words, so one named
 * `constructor` or `__proto__` must never read what every object inherits.
 */
export const fieldEntry = <T>(map: Record<string, T>, id: string): T | undefined => Object.hasOwn(map, id) ? map[id] : undefined;
/** Where a form starts: each field's suggested value, or empty. */
export function formStart(card: FormCard): FormAnswers {
  return Object.fromEntries(card.fields.map(field => [field.id, field.value ?? (field.kind === "multi" ? [] : field.kind === "toggle" ? false : "")]));
}
const answered = (value: FormValue | undefined) => Array.isArray(value) ? value.length > 0 : typeof value === "string" ? value.trim() !== "" : value !== undefined;
/** What stops the answers from going, by field ID: a required field left empty, or a value that doesn't fit its field. */
export function formProblems(card: FormCard, answers: FormAnswers): Record<string, string> {
  const problems: Record<string, string> = Object.create(null);
  const reasons: Record<FormFieldKind, string> = { text: "Keep this under 4,000 characters.", textarea: "Keep this under 4,000 characters.", number: "Enter a number.",
    date: "Enter a real date.", select: "Choose one of the options.", choice: "Choose one of the options.", multi: "Choose from the options.", toggle: "Turn this on or off." };
  for (const field of card.fields) {
    const value = fieldEntry(answers, field.id);
    if (field.kind !== "toggle" && !answered(value)) {
      if (field.required) problems[field.id] = field.kind === "multi" ? "Choose at least one." : "This one needs an answer.";
    } else if (!fitsField(field, value)) problems[field.id] = reasons[field.kind];
  }
  return problems;
}
/**
 * The message that carries a form's answers: its title, then each answered field as "Label: value".
 * Unanswered optional fields are left out. A value of several lines starts on its own line, indented
 * so it stays inside its list item.
 */
export function formAnswerText(card: FormCard, answers: FormAnswers): string {
  const lines = card.fields.flatMap(field => {
    const value = fieldEntry(answers, field.id);
    if (field.kind !== "toggle" && !answered(value)) return [];
    const shown = value === undefined || typeof value === "boolean" ? value ? "Yes" : "No" : Array.isArray(value) ? value.join(", ") : value.trim();
    return shown.includes("\n") ? [`- ${field.label}:`, ...shown.split(/\r\n|\r|\n/).map(line => `  ${line}`)] : [`- ${field.label}: ${shown}`];
  });
  return [`My answers to "${card.title}":`, ...(lines.length ? lines : ["- (No answers given)"])].join("\n");
}

export const interactiveReplyInstructions = `When a checklist, itinerary, or calendar proposal would help, include a fenced agent-ui JSON block alongside a short explanation. Use {"version":1,"cards":[...]}. Each card needs a unique stable id and title. A checklist is {"id":"groceries","type":"checklist","title":"Groceries","items":[{"id":"milk","text":"Milk"}]}. An itinerary is {"id":"trip","type":"itinerary","title":"Our trip","items":[{"id":"stop1","title":"First stop","time":"Saturday, 10 AM","detail":"Details","url":"https://example.com"}]}. An event is {"id":"dinner","type":"event","title":"Dinner","start":"2026-10-03T18:00:00-05:00","end":"2026-10-03T19:00:00-05:00","location":"Home","description":"Details"}. IDs use letters, digits, underscores or hyphens. Include only useful fields, at most 8 cards and 60 items per card. Event timestamps require a confirmed date and timezone offset; ask when those are unknown. Cards are proposals, never evidence that a calendar event or other external action was created.`;
