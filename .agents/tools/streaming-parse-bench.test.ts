// Counts and times how often a live reply re-parses while about 20,000 characters stream, as the
// transcript showed it before pacing (StreamingMarkdown at each update) and after (LiveMarkdown on
// animation frames). Run: npx vitest run --config .agents/tools/streaming-parse-bench.config.ts
// jsdom is slower than a browser, so the times are an upper bound; the counts are exact.
import { act, createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { mountRoot } from "../../tests/ui-harness";

const parses = vi.hoisted(() => ({ count: 0, ms: [] as number[] }));
vi.mock("react-markdown", async importActual => {
  const actual = await importActual<typeof import("react-markdown")>();
  const Markdown = (props: Parameters<typeof actual.default>[0]) => {
    const start = process.hrtime.bigint();
    try { return actual.default(props); } finally {
      parses.count++;
      parses.ms.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
  };
  return { ...actual, default: Markdown };
});
const { LiveMarkdown, StreamingMarkdown } = await import("../../src/components/MessageMarkdown");

const UPDATE_MS = 250, FRAME_MS = 1000 / 60;
// A prose reply of the kind assistants write, and the worst case: one fence that is still open, so
// the whole reply is its last block.
const paragraph = (index: number) => `Step ${index}: check the **water trough**, then the [gate log](https://example.test/${index}) and \`fence.ts\`. ` +
  "Feed the horses at dawn and dusk, and keep the hay dry under the lean-to before the rain comes in. ".repeat(3);
const prose = Array.from({ length: 60 }, (_, index) => index % 7 === 3 ? `- Item one\n- Item two ${index}` : paragraph(index)).join("\n\n");
const code = "```ts\n" + Array.from({ length: 900 }, (_, index) => `const line${index} = feed(${index});`).join("\n");
const replies = { prose: prose.slice(0, 20_000), "one open code block": code.slice(0, 20_000) };

afterEach(() => { vi.useRealTimers(); });
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)] ?? 0;

// The last two seconds of the stream, when the reply is longest: 8 updates of 125 characters.
async function measure(name: string, text: string, live: boolean) {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date", "setTimeout"] });
  const { root } = mountRoot();
  const component = live ? LiveMarkdown : StreamingMarkdown;
  const step = 125, start = text.length - 8 * step;
  await act(async () => root.render(createElement(component, { text: text.slice(0, start) })));
  parses.count = 0;
  parses.ms = [];
  // Everything a render costs: splitting, holding back, parsing and React's commit to the DOM.
  let rendering = 0;
  const timed = async (work: () => void) => {
    const begin = process.hrtime.bigint();
    await act(async () => work());
    rendering += Number(process.hrtime.bigint() - begin) / 1e6;
  };
  for (let update = 1; update <= 8; update++) {
    await timed(() => root.render(createElement(component, { text: text.slice(0, start + update * step) })));
    for (let frame = 0; frame < UPDATE_MS / FRAME_MS; frame++) await timed(() => vi.advanceTimersByTime(FRAME_MS));
  }
  const seconds = 8 * UPDATE_MS / 1000;
  console.log(`${name}, ${live ? "after (paced)" : "before"}: ${(parses.count / seconds).toFixed(1)} parses/s, `
    + `median ${median(parses.ms).toFixed(2)} ms, p95 ${p95(parses.ms).toFixed(2)} ms, ${(parses.ms.reduce((a, b) => a + b, 0) / seconds).toFixed(0)} ms parsing and ${(rendering / seconds).toFixed(0)} ms rendering per second`);
  await act(async () => root.unmount());
}

it("measures parses per second and their cost", async () => {
  for (const [name, text] of Object.entries(replies)) {
    expect(text.length).toBe(20_000);
    // Warm the parser so the first run is not charged for loading it.
    await measure(name, text, false);
    await measure(name, text, false);
    await measure(name, text, true);
  }
});
