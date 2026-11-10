// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplyMarkdown } from "../src/components/MessageMarkdown";
import { CATCH_UP_MS, arrive, graphemeCut, settledPace, visibleLength } from "../src/components/streaming-reveal";
import type { Pace } from "../src/components/streaming-reveal";
import { advance, mountRoot, stubMatchMedia } from "./ui-harness";
import type { Mount } from "./ui-harness";

// Animation frames and the clock are faked at the browser's edge; the reveal runs for real.
const FRAME = 16;
let mount: Mount;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date", "setTimeout", "clearTimeout"] });
  stubMatchMedia(false);
  mount = mountRoot();
});
afterEach(() => { Reflect.deleteProperty(document, "visibilityState"); });

const show = (text: string) => mount.render(createElement(ReplyMarkdown, { text, live: true }));
const shown = () => mount.container.querySelector(".message-markdown")?.textContent ?? "";
const words = (count: number) => Array.from({ length: count }, (_, index) => `word${index}`).join(" ");
/** What shows after each frame until `ms` have passed. */
async function frames(ms: number) {
  const seen: string[] = [];
  for (let time = 0; time < ms; time += FRAME) {
    await advance(FRAME);
    seen.push(shown());
  }
  return seen;
}

describe("revealing a live reply", () => {
  it("shows a row's first text at once, then reveals an update over several frames and catches up in time", async () => {
    await show("Checking the gate.");
    // Opening a chat mid-reply shows what already arrived without making anyone wait for it.
    expect(shown()).toBe("Checking the gate.");
    const full = `Checking the gate. ${words(80)}`;
    await show(full);
    expect(shown()).toBe("Checking the gate.");
    const seen = await frames(CATCH_UP_MS + FRAME);
    const steps = new Set(seen.filter(text => text !== full));
    expect(steps.size).toBeGreaterThan(4);
    expect(seen.at(-1)).toBe(full);
    // Halfway through, it is neither stalled nor done.
    const half = seen[Math.floor(CATCH_UP_MS / 2 / FRAME)];
    expect(half.length).toBeGreaterThan(full.length * 0.3);
    expect(half.length).toBeLessThan(full.length * 0.8);
  });

  it("clears a large backlog within the catch-up time, and an update mid-reveal never delays text that came before it", async () => {
    await show("Start.");
    const large = `Start. ${words(3000)}`;
    expect(large.length).toBeGreaterThan(20_000);
    await show(large);
    await advance(CATCH_UP_MS - 100);
    // More arrives before the reveal is done. What was already there still shows by its own deadline.
    const more = `${large} and the rest`;
    await show(more);
    await advance(100 + FRAME);
    expect(shown().startsWith(large.slice(0, -1))).toBe(true);
    await advance(CATCH_UP_MS);
    expect(shown()).toBe(more);
  });

  it("shows an update at once when the system asks for reduced motion", async () => {
    stubMatchMedia(query => query.includes("prefers-reduced-motion: reduce"));
    await show("Gate.");
    await show(`Gate. ${words(50)}`);
    expect(shown()).toBe(`Gate. ${words(50)}`);
  });

  it("shows an update at once in a hidden tab, and the rest at once when the tab hides mid-reveal", async () => {
    await show("Gate.");
    await show(`Gate. ${words(50)}`);
    await advance(FRAME * 2);
    expect(shown()).not.toBe(`Gate. ${words(50)}`);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(shown()).toBe(`Gate. ${words(50)}`);
    await show(`Gate. ${words(90)}`);
    expect(shown()).toBe(`Gate. ${words(90)}`);
  });

  it("shows a text that does not continue the shown one at once", async () => {
    await show("First.");
    // Longer than what showed, so pacing it from there would show its first characters only.
    await show(`A new reply in the same row. ${words(40)}`);
    expect(shown()).toBe(`A new reply in the same row. ${words(40)}`);
  });

  it("keeps holding back a half-revealed marker, so every frame shows a prefix of the reply and no raw asterisks", async () => {
    await show("Feed");
    const full = "Feed the horses **hay bales** before the rain, and check the trough.";
    await show(full);
    const rendered = "Feed the horses hay bales before the rain, and check the trough.";
    const seen = await frames(CATCH_UP_MS + FRAME);
    expect(seen.at(-1)).toBe(rendered);
    for (const text of seen) {
      expect(text).not.toContain("*");
      expect(rendered.startsWith(text)).toBe(true);
    }
    // The bold term shows whole, never as the reveal's half of it.
    expect(seen.some(text => text.endsWith("hay bale"))).toBe(false);
  });

  it("shows a caret after the text while the reply streams, hidden from assistive technology and holding no text", async () => {
    await show("Checking the gate.");
    const caret = mount.container.querySelector(".streaming-caret");
    expect(caret?.getAttribute("aria-hidden")).toBe("true");
    expect(caret?.textContent).toBe("");
    // A selection over the whole reply copies only the reply.
    const range = document.createRange();
    range.selectNodeContents(mount.container);
    expect(range.toString()).toBe("Checking the gate.");
  });
});

describe("the reveal's pacing rule", () => {
  // Families, flags and accents are several code units each. A cut inside one would show half of it.
  const clusters = ["👨‍👩‍👧", "🇺🇸", "é", "a", " ", "👍🏽", "\r\n"];
  it("cuts only between graphemes", () => {
    const text = clusters.join("").repeat(3);
    const boundaries = new Set([0]);
    let at = 0;
    for (const cluster of [...clusters, ...clusters, ...clusters]) boundaries.add(at += cluster.length);
    for (let cut = 0; cut <= text.length; cut++) expect(boundaries.has(graphemeCut(text, cut)), `cut at ${cut}`).toBe(true);
  });

  // Seeded runs of arrivals at random times, mostly growth with an occasional new reply, checked
  // against the contract at every frame.
  it("always shows a prefix of the latest text and every character within the catch-up time of arriving", () => {
    let seed = 11;
    const pick = (count: number) => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 8) % count;
    for (let run = 0; run < 200; run++) {
      let now = 0, text = "", pace: Pace = settledPace("");
      // When each character position last arrived, for the deadline check.
      let arrivedAt: number[] = [];
      for (let event = 0; event < 30; event++) {
        now += pick(400);
        if (pick(10) === 0) {
          text = clusters[pick(clusters.length)].repeat(1 + pick(50));
          arrivedAt = Array(text.length).fill(now);
        } else {
          const add = Array.from({ length: pick(30) }, () => clusters[pick(clusters.length)]).join("");
          arrivedAt.push(...Array(add.length).fill(now));
          text += add;
        }
        pace = arrive(pace, text, now);
        for (let frame = now; frame <= now + CATCH_UP_MS + 2 * FRAME; frame += FRAME) {
          const length = visibleLength(pace, frame);
          expect(text.startsWith(text.slice(0, length))).toBe(true);
          expect(graphemeCut(text, length)).toBe(length);
          // Everything that arrived at least CATCH_UP_MS ago shows, up to the grapheme it belongs to.
          const due = arrivedAt.findLastIndex(time => time + CATCH_UP_MS <= frame) + 1;
          expect(length).toBeGreaterThanOrEqual(graphemeCut(text, due));
        }
      }
    }
  });
});
