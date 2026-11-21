import { assistants, conversation, expect, signIn, test } from "./fixtures.js";

/**
 * A tool's output box sets `overscroll-behavior: contain`. At its end, Chromium keeps Down and Page Down in the box,
 * and WebKit passes them on to the transcript. After a send, the transcript holds the sent message near the top
 * while the reply grows, and a reader WebKit scrolled must not be pulled back to it.
 */
test("a reader who scrolls on from the end of a tool's output stays where they scrolled", async ({
  page,
  browserName,
}) => {
  await signIn(page);
  await assistants(page)
    .getByRole("button", { name: /Trail Cook/ })
    .click();
  await page.getByRole("textbox", { name: "Message Trail Cook" }).fill("Read the gate log");
  await page.getByRole("button", { name: "Send message" }).click();
  const transcript = conversation(page);
  await expect(transcript.locator(".turn-work > summary")).toBeVisible();
  await transcript.locator(".turn-work > summary").click();
  await transcript.locator(".tool-calls > summary").click();
  await transcript.locator(".message-detail > summary").click();
  const output = transcript.getByRole("region", { name: "Activity output" });
  await expect(output).toContainText("gate 80: latched");
  // Focus rests at the end of the output, which shows only part of its 80 lines.
  await output.evaluate((box) => {
    box.scrollTop = box.scrollHeight;
    box.focus({ preventScroll: true });
  });
  const top = () => transcript.evaluate((view) => view.scrollTop);
  const before = await top();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("PageDown");
  await page.waitForTimeout(400);
  const scrolled = await top();
  // The reply keeps growing for several seconds, and each update lays the transcript out again.
  await page.waitForTimeout(2000);
  if (browserName === "webkit") {
    // WebKit moved the reader down. Before the fix the anchor pulled them back to the sent message before any
    // scroll event reported the move.
    expect(scrolled).toBeGreaterThan(before);
    expect(await top()).toBeGreaterThanOrEqual(scrolled - 1);
  } else {
    // Chromium keeps the keys in the box, so nothing moves.
    expect(await top()).toBe(before);
  }
});
