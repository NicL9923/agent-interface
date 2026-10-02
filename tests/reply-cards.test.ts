import { describe, expect, it } from "vitest";
import { eventCalendarFile, eventGoogleCalendarUrl, parseReplyDocument, replyCardsFromText, validReplyCardState } from "../src/shared/reply-cards";
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
});
