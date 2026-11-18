// @vitest-environment jsdom
import { expect, it } from "vitest";
import { firstMessageBelow } from "../src/app/use-conversation";

it("keeps collapsed bot messages out of the ordered reading-position search", () => {
  const container = document.createElement("div");
  container.innerHTML =
    '<article data-message-id="before"></article><details><summary>Bot messages</summary><article data-message-id="one"></article><article data-message-id="two"></article></details><article data-message-id="after"></article>';
  const bottom: Record<string, number> = { before: 400, one: 0, two: 0, after: 600 };
  for (const row of container.querySelectorAll<HTMLElement>("article")) {
    row.getBoundingClientRect = () => ({ bottom: bottom[row.dataset.messageId!] }) as DOMRect;
  }
  expect(firstMessageBelow(container, 250)?.dataset.messageId).toBe("before");
  container.querySelector("details")!.open = true;
  bottom.one = 450;
  bottom.two = 500;
  expect(firstMessageBelow(container, 410)?.dataset.messageId).toBe("one");
  container.querySelector("details")!.open = false;
  bottom.one = 0;
  bottom.two = 0;
  expect(firstMessageBelow(container, 250)?.dataset.messageId).toBe("before");
  expect(firstMessageBelow(container, 700)).toBeUndefined();
});
