// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearEnd, LiveMarkdown, logicalEndSide } from "../src/components/MessageMarkdown";
import { CATCH_UP_MS, MIN_FRAME_MS, graphemeCut, useRevealed } from "../src/components/streaming-reveal";
import { advance, mountRoot, stubMatchMedia } from "./ui-harness";
import type { Mount } from "./ui-harness";

// Animation frames and the clock are faked at the browser's edge; the reveal runs for real.
const FRAME = 16;
/** The longest a due character waits for the paced frame that shows it. */
const PACED = MIN_FRAME_MS + FRAME;
let mount: Mount;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date", "setTimeout", "clearTimeout"] });
  stubMatchMedia(false);
  mount = mountRoot();
});
afterEach(() => { Reflect.deleteProperty(document, "visibilityState"); });

const show = (text: string) => mount.render(createElement(LiveMarkdown, { text }));
const shown = () => mount.container.querySelector(".message-markdown")?.textContent ?? "";
const words = (count: number) => Array.from({ length: count }, (_, index) => `word${index}`).join(" ");
type Shown = { at: number; text: string };
/** Records each text the real hook returned that React committed, and when. */
function Probe({ text, log }: { text: string; log: Shown[] }) {
  const shown = useRevealed(text);
  useLayoutEffect(() => { if (log.at(-1)?.text !== shown) log.push({ at: performance.now(), text: shown }); });
  return null;
}
/**
 * Moves time `ms` forward, stopping at each frame, so React commits each frame's update at the time
 * the frame ran. The faked frames run on 16 ms boundaries.
 */
async function frameByFrame(ms: number) {
  for (let left = ms; left > 0;) {
    const step = Math.min(FRAME - Math.floor(performance.now()) % FRAME, left);
    await advance(step);
    left -= step;
  }
}
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
    const seen = await frames(CATCH_UP_MS + PACED);
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
    // Over 20,000 characters.
    const large = `Start. ${words(3000)}`;
    await show(large);
    await advance(CATCH_UP_MS - 100);
    // More arrives before the reveal is done. What was already there still shows by its own deadline.
    const more = `${large} and the rest`;
    await show(more);
    await advance(100 + PACED);
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
    const seen = await frames(CATCH_UP_MS + PACED);
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
  // against the contract at every frame, on what the real hook returned and React committed.
  it("always shows a prefix of the latest text and every character within the catch-up time of arriving", async () => {
    let seed = 11;
    const pick = (count: number) => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 8) % count;
    for (let run = 0; run < 30; run++) {
      let text = "";
      const log: Shown[] = [];
      const render = () => mount.render(createElement(Probe, { key: run, text, log }));
      await render();
      // When each character position last arrived, for the deadline check.
      let arrivedAt: number[] = [];
      for (let event = 0; event < 30; event++) {
        // Steps a frame at a time to the next arrival, checking what shows after each.
        for (let wait = pick(400); wait > 0; wait -= FRAME) {
          await advance(Math.min(FRAME, wait));
          const shown = log.at(-1)!.text, now = performance.now();
          expect(text.startsWith(shown), `run ${run}: "${shown}" is a prefix of "${text}"`).toBe(true);
          expect(graphemeCut(text, shown.length), `run ${run}: cut between graphemes`).toBe(shown.length);
          // Everything that arrived at least the catch-up time ago shows, up to the grapheme it belongs to.
          const due = arrivedAt.findLastIndex(time => time + CATCH_UP_MS + PACED <= now) + 1;
          expect(shown.length, `run ${run} at ${now}`).toBeGreaterThanOrEqual(graphemeCut(text, due));
        }
        const now = performance.now();
        if (pick(10) === 0) {
          text = clusters[pick(clusters.length)].repeat(1 + pick(50));
          arrivedAt = Array(text.length).fill(now);
        } else {
          const add = Array.from({ length: pick(30) }, () => clusters[pick(clusters.length)]).join("");
          arrivedAt.push(...Array(add.length).fill(now));
          text += add;
        }
        await render();
      }
    }
  });

  it("paints at most once per paced frame across arrivals, so a reply growing four times a second stays near 30 updates a second", async () => {
    // A long open code block, the case where each paint re-parses the most.
    let text = `\`\`\`\n${"let gate = latched;\n".repeat(1000)}`;
    const log: Shown[] = [];
    const render = () => mount.render(createElement(Probe, { text, log }));
    await render();
    const started = performance.now();
    for (let arrival = 0; arrival < 12; arrival++) {
      await frameByFrame(250);
      text += "let gate = latched;\n".repeat(12);
      await render();
    }
    await frameByFrame(CATCH_UP_MS + PACED);
    expect(log.at(-1)!.text).toBe(text);
    const paints = log.slice(1).map(entry => entry.at);
    // The gap between any two paints, arrival or frame, respects the cap. The 1 ms is the frame-time
    // jitter the hook allows, so a 60 Hz screen paints every second frame.
    const gaps = paints.slice(1).map((at, index) => at - paints[index]);
    expect(Math.min(...gaps), gaps.join(" ")).toBeGreaterThanOrEqual(MIN_FRAME_MS - 1);
    for (let second = 0; second < 3; second++) {
      const count = paints.filter(at => at >= started + second * 1000 && at < started + (second + 1) * 1000).length;
      expect(count, `paints in second ${second + 1}`).toBeLessThanOrEqual(30);
    }
  });
});

describe("where the caret goes", () => {
  // Boxes as the browser lays them out: 10 px a grapheme, one line.
  const at = (left: number, top = 0) => ({ left, right: left + 10, top, bottom: top + 16 });
  it.each([
    ["an Arabic letter, whatever lies beside it", "م", at(0), at(10), "ltr", "left"],
    ["a Hebrew letter", "ם", at(40), at(30), "ltr", "left"],
    ["a Latin letter, even in a right-to-left paragraph", "d", at(0), at(10), "rtl", "right"],
    ["a digit, which runs left to right inside Arabic text", "٦", at(40), at(50), "rtl", "right"],
    ["punctuation after text laid out right to left", ".", at(0), at(10), "ltr", "left"],
    ["punctuation after text laid out left to right", ".", at(10), at(0), "rtl", "right"],
    ["punctuation first on its line, in a right-to-left paragraph", ".", at(0, 20), at(10, 0), "rtl", "left"],
    ["punctuation alone, in a left-to-right paragraph", "!", at(0), undefined, "ltr", "right"],
  ] as const)("ends %s on its trailing side", (_name, grapheme, last, previous, direction, side) => {
    expect(logicalEndSide(grapheme, last, previous, direction)).toBe(side);
  });

  // The caret's gap and width come to 4 px. "o" ends at 50 where an Arabic letter's trailing edge
  // touches it, as in "helloمرحبا"; the line runs from 0 to 90. `last` is the reply's final grapheme.
  it.each([
    ["stays past the logical end when nothing lies there", at(50), "left", [at(10), at(70)], "ltr", { x: 50, side: "left" }],
    ["stays past the logical end when a space's width lies between it and the next glyph", at(40), "right", [at(55)], "ltr", { x: 50, side: "right" }],
    ["moves past the line's right end when a glyph touches the logical end", at(50), "left", [at(40), at(80)], "ltr", { x: 90, side: "right" }],
    ["moves past the line's left end in a right-to-left paragraph", at(40), "right", [at(0), at(50)], "rtl", { x: 0, side: "left" }],
    // "helloم": the final letter is itself the line's right end, so the caret clears it too.
    ["moves past the final grapheme when it ends the line, left to right", at(50), "left", [at(40)], "ltr", { x: 60, side: "right" }],
    // "مرحباA" in a right-to-left paragraph: "A" is the line's left end.
    ["moves past the final grapheme when it ends the line, right to left", at(40), "right", [at(50)], "rtl", { x: 40, side: "left" }],
  ] as const)("%s", (_name, last, side, line, direction, spot) => {
    expect(clearEnd(last, side, [...line], direction, 4)).toEqual(spot);
  });

  it("places the caret again once a frame while a code block in the reply scrolls sideways", async () => {
    // Layout is faked at the browser's edge: each character of a text node is 10 px wide, shifted
    // left by however far the code is scrolled, and the caret's containing block is its parent.
    let scrolled = 0, measured = 0;
    const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent")!;
    const rects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get(this: HTMLElement) { return this.parentElement; } });
    const box = (left: number, width: number) => ({ left, right: left + width, top: 0, bottom: 16, width, height: 16, x: left, y: 0 }) as DOMRect;
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value(this: Range) {
      measured++;
      return [box(this.startOffset * 10 - scrolled, (this.endOffset - this.startOffset) * 10)];
    } });
    const bounds = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.classList.contains("message-markdown") ? box(0, 2000) : box(0, 0);
    });
    try {
      await show("```\nlet gate = latched;\nend");
      const caret = mount.container.querySelector<HTMLElement>(".streaming-caret")!, pre = mount.container.querySelector("pre")!;
      const end = pre.textContent!.trimEnd().length;
      expect(caret.style.transform).toBe(`translate(${end * 10 + 2}px, 0px)`);

      const scroll = async (to: number, events: number) => {
        scrolled = to;
        const before = measured, transform = caret.style.transform;
        for (let event = 0; event < events; event++) await act(async () => { pre.dispatchEvent(new Event("scroll")); });
        // Not before the next frame.
        expect(caret.style.transform).toBe(transform);
        await advance(FRAME);
        expect(caret.style.transform).toBe(`translate(${end * 10 - to + 2}px, 0px)`);
        return measured - before;
      };
      // Three scroll events in one frame measure the text as often as one does.
      const once = await scroll(30, 1);
      expect(once).toBeGreaterThan(0);
      expect(await scroll(60, 3)).toBe(once);
    } finally {
      Object.defineProperty(HTMLElement.prototype, "offsetParent", offsetParent);
      if (rects) Object.defineProperty(Range.prototype, "getClientRects", rects);
      else Reflect.deleteProperty(Range.prototype, "getClientRects");
      bounds.mockRestore();
    }
  });
});
