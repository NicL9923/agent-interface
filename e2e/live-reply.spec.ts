import { assistants, conversation, expect, signIn, test } from "./fixtures.js";
import type { Page } from "@playwright/test";

/**
 * The Trail Cook streams back what follows "Echo: " and leaves its turn running, so the live row and its caret stay
 * on screen to measure. Geometry comes from Chromium's own layout of the text, one grapheme at a time.
 */
async function echo(page: Page, text: string) {
  await signIn(page);
  await assistants(page).getByRole("button", { name: /Trail Cook/ }).click();
  await page.getByRole("textbox", { name: "Message Trail Cook" }).fill(`Echo: ${text}`);
  await page.getByRole("button", { name: "Send message" }).click();
  const row = conversation(page).locator('[data-message-id="trail-inflight"]');
  // The reveal has caught up once the last word shows.
  await expect(row.locator(".message-markdown")).toContainText(text.split(/\s/).at(-1)!);
  return row;
}

type Box = { left: number; right: number; top: number; bottom: number };
/** The caret's box, and the box of each grapheme of the last `word` in the reply's text. */
const measure = (page: Page, word: string) => page.evaluate(word => {
  const row = document.querySelector('[data-message-id="trail-inflight"]')!;
  const box = (rect: DOMRect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
  const walker = document.createTreeWalker(row.querySelector(".message-markdown")!, NodeFilter.SHOW_TEXT);
  let node: Text | null = null, found: Text | null = null;
  while ((node = walker.nextNode() as Text | null)) if (node.data.includes(word)) found = node;
  const start = found!.data.lastIndexOf(word);
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(word)].map(part => {
    const range = document.createRange();
    range.setStart(found!, start + part.index);
    range.setEnd(found!, start + part.index + part.segment.length);
    return box(range.getBoundingClientRect());
  });
  return { caret: box(row.querySelector(".streaming-caret")!.getBoundingClientRect()), graphemes };
}, word) as Promise<{ caret: Box; graphemes: Box[] }>;

// The caret sits 2 px past the text's logical end and is 2 px wide.
function near(actual: number, expected: number) {
  expect(actual).toBeGreaterThanOrEqual(expected - 0.5);
  expect(actual).toBeLessThanOrEqual(expected + 4.5);
}

test.describe("a live reply's caret", () => {
  // The text's logical end is the edge of its last word where that word's own direction ends: the left
  // edge of an Arabic or Hebrew word, the right edge of a Latin word or a number, wherever on the line it sits.
  const cases = [
    { name: "right-to-left text", text: "مرحبا بالعالم", word: "بالعالم", side: "left" },
    { name: "left-to-right text", text: "Howdy, partner", word: "partner", side: "right" },
    { name: "Hebrew followed by a Latin word", text: "השער נעול latched", word: "latched", side: "right" },
    { name: "Arabic followed by a number", text: "البوابة مغلقة 2026", word: "2026", side: "right" },
  ] as const;
  for (const { name, text, word, side } of cases) test(`sits at the logical end of ${name}`, async ({ page }) => {
    const row = await echo(page, text);
    const { caret, graphemes } = await measure(page, word);
    // Wider than the row, since the caret after text flush with its left edge sits just outside it.
    const bounds = (await row.boundingBox())!;
    await page.screenshot({ path: test.info().outputPath("caret.png"), clip: { ...bounds, x: bounds.x - 16, width: bounds.width + 32 } });
    const top = Math.min(...graphemes.map(item => item.top));
    expect(caret.top).toBeGreaterThanOrEqual(top - 4);
    // Never over the word's own letters.
    for (const grapheme of graphemes) expect(caret.right <= grapheme.left + 0.5 || caret.left >= grapheme.right - 0.5, JSON.stringify({ caret, grapheme })).toBe(true);
    if (side === "left") near(Math.min(...graphemes.map(item => item.left)), caret.right);
    else near(caret.left, Math.max(...graphemes.map(item => item.right)));
  });

  test("follows the text when a code block scrolls sideways at phone width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await echo(page, `\`\`\`\n${"north_gate_latched_at_six_by_the_ranch_hand; ".repeat(6).trim()}\nend`);
    const pre = conversation(page).locator('[data-message-id="trail-inflight"] pre');
    const before = await measure(page, "end");
    near(before.caret.left, before.graphemes.at(-1)!.right);
    // A short scroll keeps the last line in view, so the caret moves with it.
    await pre.evaluate(element => { element.scrollLeft = 24; });
    await expect.poll(async () => (await measure(page, "end")).graphemes.at(-1)!.right).toBeLessThan(before.graphemes.at(-1)!.right - 20);
    await expect.poll(async () => {
      const { caret, graphemes } = await measure(page, "end");
      return caret.left - graphemes.at(-1)!.right;
    }).toBeLessThanOrEqual(4.5);
    const after = await measure(page, "end");
    near(after.caret.left, after.graphemes.at(-1)!.right);
    // Scrolled past the last line, the caret waits at the code block's visible edge instead of leaving it.
    await pre.evaluate(element => { element.scrollLeft = element.scrollWidth; });
    await expect.poll(async () => {
      const [{ caret }, clip] = await Promise.all([measure(page, "end"), pre.evaluate(element => element.getBoundingClientRect().left)]);
      return caret.left - clip;
    }).toBeGreaterThanOrEqual(-0.5);
    await conversation(page).screenshot({ path: test.info().outputPath("scrolled.png") });
  });
});
