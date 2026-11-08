// @vitest-environment jsdom
import { expect, it } from "vitest";
import { matchRanges, shownMessages } from "../src/app/find-ranges";

it("finds case-insensitive, non-overlapping ranges within readable text nodes", () => {
  const container = document.createElement("div");
  container.innerHTML = `<article data-message-id="one"><div class="message-text">BanAna BANANA <b>banana</b></div><div>banana outside</div></article>
    <article data-message-id="two"><div class="message-markdown">Other</div></article>`;
  expect(shownMessages(container)).toEqual([{ id: "one", text: "BanAna BANANA banana" }, { id: "two", text: "Other" }]);
  const item = container.querySelector("article")!;
  const ranges = matchRanges(item, "ana");
  expect(ranges.map(range => [range.toString(), range.startOffset, range.endOffset])).toEqual([
    ["anA", 1, 4], ["ANA", 8, 11], ["ana", 1, 4],
  ]);
  expect(matchRanges(item, "missing")).toEqual([]);
});

it("returns no ranges for an empty needle instead of looping", () => {
  const item = document.createElement("article");
  item.innerHTML = `<div class="message-text">anything</div>`;
  expect(matchRanges(item, "")).toEqual([]);
});
