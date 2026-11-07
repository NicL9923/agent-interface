import { describe, expect, it } from "vitest";
import { emailGmailUrl, emailMailtoUrl, emailText, eventCalendarFile, eventGoogleCalendarUrl, formAnswerText, formProblems, formStart, parseReplyDocument, replyCardsFromText, validReplyCardState } from "../src/shared/reply-cards";
import type { EmailCard, FormCard } from "../src/shared/reply-cards";
const card = { id: "groceries", type: "checklist" as const, title: "Groceries", items: [{ id: "milk", text: "Milk" }] };
const document = (cards: unknown[]) => JSON.stringify({ version: 1, cards });
const block = (cards: unknown[]) => "```agent-ui\n" + document(cards) + "\n```";
describe("interactive reply contracts", () => {
  it("accepts bounded known cards and keeps malformed or executable payloads as plain code", () => {
    expect(parseReplyDocument(document([card]))?.cards).toEqual([card]);
    expect(parseReplyDocument(document([{ ...card, script: "alert(1)" }]))).toBeNull();
    expect(parseReplyDocument(document([{ id: "trip", title: "Trip", type: "itinerary", items: [{ id: "stop", title: "Stop", url: "javascript:alert(1)" }] }]))).toBeNull();
    expect(parseReplyDocument(document([{ ...card, items: [card.items[0], card.items[0]] }]))).toBeNull();
    expect(parseReplyDocument("not JSON")).toBeNull();
    expect(parseReplyDocument("x".repeat(100_001))).toBeNull();
  });
  it("trims titles and text, and accepts only well-formed IDs, limits and fields", () => {
    const parsed = parseReplyDocument(document([{ id: "groceries", type: "checklist", title: "  Groceries \n", items: [{ id: "milk", text: "  Milk " }] }]));
    expect(parsed?.cards).toEqual([card]);
    const invalid = (value: unknown) => expect(parseReplyDocument(document([value]))).toBeNull();
    invalid({ ...card, id: "has space" });
    invalid({ ...card, id: "x".repeat(81) });
    invalid({ ...card, title: "   " });
    invalid({ ...card, title: "x".repeat(201) });
    invalid({ ...card, type: "poll" });
    invalid({ ...card, items: [] });
    invalid({ ...card, items: [{ id: "milk", text: "Milk", extra: true }] });
    invalid({ ...card, items: [{ id: "milk", text: "x".repeat(501) }] });
    invalid({ ...card, items: Array.from({ length: 61 }, (_, i) => ({ id: `i${i}`, text: "Item" })) });
    invalid("groceries");
    invalid(null);
    expect(parseReplyDocument(document([{ ...card, items: Array.from({ length: 60 }, (_, i) => ({ id: `i${i}`, text: "Item" })) }]))?.cards).toHaveLength(1);
    expect(parseReplyDocument(JSON.stringify({ version: 2, cards: [card] }))).toBeNull();
    expect(parseReplyDocument(JSON.stringify({ version: 1, cards: [card], extra: 1 }))).toBeNull();
    expect(parseReplyDocument(document(Array.from({ length: 9 }, (_, i) => ({ ...card, id: `c${i}` }))))).toBeNull();
    expect(parseReplyDocument(document([card, card]))).toBeNull();
  });
  it("keeps itinerary links to http and https and strips the characters a URL parser ignores", () => {
    const trip = (item: object) => document([{ id: "trip", type: "itinerary", title: "Trip", items: [{ id: "stop", title: "Stop", ...item }] }]);
    expect(parseReplyDocument(trip({ time: "10 AM", detail: "Bring cash", url: " https://exa\nmple.com/a " }))?.cards[0]).toEqual({
      id: "trip", type: "itinerary", title: "Trip",
      items: [{ id: "stop", title: "Stop", time: "10 AM", detail: "Bring cash", url: "https://example.com/a" }],
    });
    for (const url of ["ftp://example.com", "javascript:alert(1)", "https:example.com", "not a url", `https://example.com/${"a".repeat(2000)}`, 5, null])
      expect(parseReplyDocument(trip({ url }))).toBeNull();
    expect(parseReplyDocument(trip({ time: "x".repeat(101) }))).toBeNull();
    expect(parseReplyDocument(trip({ detail: null }))).toBeNull();
  });
  it("accepts only real calendar times that carry seconds and an offset", () => {
    const event = (fields: object) => document([{ id: "dinner", type: "event", title: "Dinner", start: "2026-10-03T18:00:00-05:00", ...fields }]);
    for (const start of ["2026-10-03T18:00:00Z", "2026-10-03T18:00:00.250+01:30", "2028-02-29T10:00:00Z"])
      expect(parseReplyDocument(event({ start }))?.cards).toHaveLength(1);
    for (const start of ["2026-02-29T10:00:00Z", "2026-04-31T10:00:00Z", "2026-10-03T24:00:00Z", "2026-10-03T18:00Z", "2026-10-03T18:00:00+0500", "2026-10-03T18:00:00+24:00", "2026-10-03 18:00:00Z", 5])
      expect(parseReplyDocument(event({ start }))).toBeNull();
    expect(parseReplyDocument(event({ end: "2026-10-03T18:00:00-05:00" }))).toBeNull();
    expect(parseReplyDocument(event({ end: null }))).toBeNull();
    expect(parseReplyDocument(event({ location: "Home", description: "Bring dessert" }))?.cards[0]).toMatchObject({ location: "Home", description: "Bring dessert" });
    expect(parseReplyDocument(event({ location: "x".repeat(501) }))).toBeNull();
  });
  it("rejects ambiguous card IDs across blocks and more than eight total cards", () => {
    expect(replyCardsFromText(`Here you go.\n${block([card])}`)).toEqual([card]);
    expect(replyCardsFromText(`${block([card])}\n${block([card])}`)).toEqual([]);
    expect(replyCardsFromText(`${block(Array.from({ length: 8 }, (_, i) => ({ ...card, id: `card${i}` })))}\n${block([{ ...card, id: "ninth" }])}`)).toEqual([]);
  });
  it("allows state only for actual items of the appropriate card type", () => {
    expect(validReplyCardState(card, { checkedIds: ["milk"], notes: {} })).toBe(true);
    expect(validReplyCardState(card, { checkedIds: ["milk", "milk"], notes: {} })).toBe(false);
    expect(validReplyCardState(card, { checkedIds: ["invented"], notes: {} })).toBe(false);
    expect(validReplyCardState(card, { checkedIds: [], notes: { milk: "wrong type" } })).toBe(false);
    const itinerary = { id: "trip", type: "itinerary" as const, title: "Trip", items: [{ id: "stop", title: "Stop" }] };
    expect(validReplyCardState(itinerary, { checkedIds: [], notes: { stop: "Lunch first" } })).toBe(true);
    expect(validReplyCardState(itinerary, { checkedIds: ["stop"], notes: {} })).toBe(false);
  });
  it("requires explicit event timezone and chronological dates", () => {
    const event = { id: "dinner", type: "event", title: "Dinner", start: "2026-10-03T18:00:00-05:00", end: "2026-10-03T19:00:00-05:00" };
    expect(parseReplyDocument(document([event]))?.cards).toHaveLength(1);
    expect(parseReplyDocument(document([{ ...event, start: "2026-10-03T18:00:00" }]))).toBeNull();
    expect(parseReplyDocument(document([{ ...event, end: "2026-10-03T17:00:00-05:00" }]))).toBeNull();
  });
  it("exports reviewed events without calendar line injection and folds Unicode safely", () => {
    const event = { id: "dinner", type: "event" as const, title: "Dinner, family; home\nBEGIN:VEVENT", start: "2026-10-03T18:00:00-05:00", end: "2026-10-03T19:00:00-05:00", description: "🌻".repeat(60) };
    const calendar = eventCalendarFile(event, new Date("2026-10-01T12:00:00Z"));
    expect(calendar).toContain("DTSTART:20261003T230000Z\r\n");
    expect(calendar.match(/^BEGIN:VEVENT$/gm)).toHaveLength(1);
    expect(calendar).toContain("SUMMARY:Dinner\\, family\\; home\\nBEGIN:VEVENT");
    expect(calendar.split("\r\n").every(line => new TextEncoder().encode(line).length <= 75)).toBe(true);
    expect(calendar.replace(/\r\n /g, "")).toContain(event.description);
    const url = new URL(eventGoogleCalendarUrl(event));
    expect(url.origin).toBe("https://calendar.google.com");
    expect(url.searchParams.get("dates")).toBe("20261003T230000Z/20261004T000000Z");
    expect(url.searchParams.get("text")).toBe(event.title);
  });

  describe("email drafts", () => {
    const draft = { id: "reply", type: "email", title: "Reply to Sam", to: ["sam@example.com"], cc: ["ann@example.com"], subject: "Saturday", body: "Hi Sam,\nSee you then." };
    it("accepts a draft with only a body, and trims headers but keeps the body as written", () => {
      expect(parseReplyDocument(document([{ id: "note", type: "email", title: "Note", body: "  Indented\n" }]))?.cards[0])
        .toEqual({ id: "note", type: "email", title: "Note", body: "  Indented\n" });
      expect(parseReplyDocument(document([{ ...draft, to: [" sam@example.com "], subject: " Saturday " }]))?.cards[0]).toEqual(draft);
    });
    it.each([
      ["a display name in an address", { to: ["Sam <sam@example.com>"] }],
      ["two addresses in one entry", { to: ["sam@example.com, ann@example.com"] }],
      ["an address with no domain", { cc: ["sam@"] }],
      ["an empty recipient list", { to: [] }],
      ["more than 20 recipients", { to: Array.from({ length: 21 }, (_, i) => `p${i}@example.com`) }],
      ["recipients that are not a list", { to: "sam@example.com" }],
      ["a blank body", { body: "  \n " }],
      ["a body over 20,000 characters", { body: "x".repeat(20_001) }],
      ["a blank subject", { subject: " " }],
      ["an unknown field", { bcc: ["x@example.com"] }],
    ])("keeps a draft with %s as code", (_, change) => {
      expect(parseReplyDocument(document([{ ...draft, ...change }]))).toBeNull();
    });
    it("opens in a mail app or Gmail with every header and CRLF line breaks, and copies as plain text", () => {
      const card = parseReplyDocument(document([draft]))!.cards[0] as EmailCard;
      expect(emailMailtoUrl(card)).toBe("mailto:sam@example.com?cc=ann@example.com&subject=Saturday&body=Hi%20Sam%2C%0D%0ASee%20you%20then.");
      const gmail = new URL(emailGmailUrl(card));
      expect(gmail.origin + gmail.pathname).toBe("https://mail.google.com/mail/");
      expect(Object.fromEntries(gmail.searchParams)).toEqual({ view: "cm", fs: "1", to: "sam@example.com", cc: "ann@example.com", su: "Saturday", body: draft.body });
      expect(emailText(card)).toBe("To: sam@example.com\nCc: ann@example.com\nSubject: Saturday\n\nHi Sam,\nSee you then.");
      const bare: EmailCard = { id: "x", type: "email", title: "X", body: "Just this & that?" };
      expect(emailMailtoUrl(bare)).toBe("mailto:?body=Just%20this%20%26%20that%3F");
      expect(emailText(bare)).toBe("Just this & that?");
    });
  });

  describe("forms", () => {
    const fields = [
      { id: "city", label: "Destination", kind: "text", required: true, placeholder: "Town" },
      { id: "nights", label: "Nights", kind: "number", value: 2 },
      { id: "when", label: "Arrive", kind: "date", value: "2026-11-20" },
      { id: "pace", label: "Pace", kind: "choice", options: ["Relaxed", "Packed"], value: "Relaxed" },
      { id: "room", label: "Room", kind: "select", options: ["King", "Twin"] },
      { id: "extras", label: "Extras", kind: "multi", options: ["Breakfast", "Parking"], required: true },
      { id: "pets", label: "Bringing the dog", kind: "toggle", value: true },
      { id: "notes", label: "Notes", kind: "textarea", help: "Anything else" },
    ];
    const formCard = { id: "trip", type: "form", title: "Trip details", fields };
    const parsed = () => parseReplyDocument(document([formCard]))!.cards[0] as FormCard;
    it("accepts every field kind and keeps a JSON number as the text a number input holds", () => {
      const card = parsed();
      expect(card.fields.map(field => field.kind)).toEqual(["text", "number", "date", "choice", "select", "multi", "toggle", "textarea"]);
      expect(card.fields[1].value).toBe("2");
      expect(formStart(card)).toEqual({ city: "", nights: "2", when: "2026-11-20", pace: "Relaxed", room: "", extras: [], pets: true, notes: "" });
    });
    const field = (change: object, index = 0) => document([{ ...formCard, fields: fields.map((entry, at) => at === index ? { ...entry, ...change } : entry) }]);
    it.each([
      ["an unknown kind", { kind: "slider" }, 0],
      ["options on a text field", { options: ["A"] }, 0],
      ["a choice whose options are not a list", { options: "Relaxed, Packed" }, 3],
      ["repeated options", { options: ["King", " King"] }, 4],
      ["more than 20 options", { options: Array.from({ length: 21 }, (_, i) => `o${i}`) }, 4],
      ["a starting choice that is not an option", { value: "Frantic" }, 3],
      ["a starting multi value with an unknown option", { value: ["Spa"] }, 5],
      ["a starting date that is not a real day", { value: "2026-02-30" }, 2],
      ["a starting number that is not a number", { value: "two" }, 1],
      ["a toggle that starts as text", { value: "yes" }, 6],
      ["required that is not a switch", { required: "yes" }, 0],
      ["a blank label", { label: " " }, 0],
      ["an invalid field ID", { id: "has space" }, 0],
      ["an unknown field property", { max: 3 }, 1],
    ])("keeps a form with %s as code", (_, change, index) => {
      expect(parseReplyDocument(field(change, index))).toBeNull();
    });
    it("keeps a choosing field without options as code", () => {
      expect(parseReplyDocument(document([{ ...formCard, fields: [{ id: "pace", label: "Pace", kind: "choice" }] }]))).toBeNull();
    });
    it("keeps forms with repeated field IDs, no fields, more than 20 fields or a long submit label as code", () => {
      expect(parseReplyDocument(document([{ ...formCard, fields: [fields[0], fields[0]] }]))).toBeNull();
      expect(parseReplyDocument(document([{ ...formCard, fields: [] }]))).toBeNull();
      expect(parseReplyDocument(document([{ ...formCard, fields: Array.from({ length: 21 }, (_, i) => ({ ...fields[0], id: `f${i}` })) }]))).toBeNull();
      expect(parseReplyDocument(document([{ ...formCard, fields: Array.from({ length: 20 }, (_, i) => ({ ...fields[0], id: `f${i}` })) }]))).not.toBeNull();
      expect(parseReplyDocument(document([{ ...formCard, submitLabel: "x".repeat(41) }]))).toBeNull();
    });
    it("names each field that stops the answers, and why", () => {
      const card = parsed();
      expect(formProblems(card, formStart(card))).toEqual({ city: "This one needs an answer.", extras: "Choose at least one." });
      expect(formProblems(card, { ...formStart(card), city: "Marfa", extras: ["Parking"], nights: "lots", when: "2026-13-01", room: "Suite", pets: "yes" as never }))
        .toEqual({ nights: "Enter a number.", when: "Enter a real date.", room: "Choose one of the options.", pets: "Turn this on or off." });
      expect(formProblems(card, { ...formStart(card), city: "x".repeat(4001), extras: ["Parking"] })).toEqual({ city: "Keep this under 4,000 characters." });
      expect(formProblems(card, { ...formStart(card), city: "Marfa", extras: ["Parking"] })).toEqual({});
    });
    it("writes the answers as one readable message, leaving out unanswered optional fields", () => {
      const card = parsed();
      expect(formAnswerText(card, { ...formStart(card), city: " Marfa ", extras: ["Breakfast", "Parking"], pets: false, notes: "Late check-in\nQuiet room" })).toBe([
        'My answers to "Trip details":', "- Destination: Marfa", "- Nights: 2", "- Arrive: 2026-11-20", "- Pace: Relaxed",
        "- Extras: Breakfast, Parking", "- Bringing the dog: No", "- Notes:", "  Late check-in", "  Quiet room",
      ].join("\n"));
      const single: FormCard = { id: "f", type: "form", title: "One", fields: [{ id: "a", label: "A", kind: "text" }] };
      expect(formAnswerText(single, { a: "" })).toBe('My answers to "One":\n- (No answers given)');
    });
    it("saves no per-person state for drafts or forms", () => {
      const card = parsed();
      expect(validReplyCardState(card, { checkedIds: [], notes: {} })).toBe(true);
      expect(validReplyCardState(card, { checkedIds: ["city"], notes: {} })).toBe(false);
      expect(validReplyCardState(card, { checkedIds: [], notes: { city: "Marfa" } })).toBe(false);
    });
  });
});
