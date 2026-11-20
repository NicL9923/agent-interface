import type { Page } from "@playwright/test";
import { assistants, conversation, expect, signIn, test } from "./fixtures.js";

// On a phone the message box floats over the end of the transcript, and in a short view, such as one the keyboard
// shortened, it can cover most of it. The Quote button and Find in chat float over the transcript too and must stay
// above the box where they meet it. Each test first makes the two overlap, so it cannot pass by keeping them apart.

/** The topmost element where the overlay and the message box overlap, and whether that is the overlay. */
const overlayOnTop = (page: Page, overlay: string) =>
  page.evaluate((overlay) => {
    const a = document.querySelector(overlay)!.getBoundingClientRect();
    const b = document.querySelector(".composer")!.getBoundingClientRect();
    const left = Math.max(a.left, b.left),
      right = Math.min(a.right, b.right),
      top = Math.max(a.top, b.top),
      bottom = Math.min(a.bottom, b.bottom);
    if (right <= left || bottom <= top) return { overlap: false, onTop: false };
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    return { overlap: true, onTop: !!hit?.closest(overlay) };
  }, overlay);

test.describe("with a finger on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the Quote button below a selection stays above the message box", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signIn(page);
    await assistants(page)
      .getByRole("button", { name: /Ranch Hand/ })
      .click();
    // A reply long enough to scroll, so its first line can sit just above the box.
    const words = "The north fence runs past the creek and up the ridge to the far gate.";
    await page.getByRole("textbox", { name: "Message Ranch Hand" }).fill(words.repeat(12));
    await page.getByRole("button", { name: "Send message" }).click();
    const reply = conversation(page).locator(".message-assistant .message-markdown p").last();
    await expect(reply).toContainText("Howdy, partner.");
    // Touch puts the button 8 px below the selection, so a line 20 px above the box puts the button over it.
    await reply.evaluate((paragraph) => {
      const range = document.createRange();
      range.setStart(paragraph.firstChild!, 0);
      range.setEnd(paragraph.firstChild!, "Howdy, partner.".length);
      const box = document.querySelector(".composer")!.getBoundingClientRect();
      paragraph.closest(".transcript")!.scrollTop -=
        box.top - 20 - range.getBoundingClientRect().bottom;
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
    });
    await expect(page.locator(".quote-selection")).toBeVisible();
    expect(await overlayOnTop(page, ".quote-selection")).toEqual({ overlap: true, onTop: true });
  });
});

test.describe("in a short phone view", () => {
  test.use({ viewport: { width: 390, height: 180 } });

  test("Find in chat stays above the message box", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signIn(page);
    await assistants(page)
      .getByRole("button", { name: /Ranch Hand/ })
      .click();
    await page.getByText("Morning. The north fence is fixed.").waitFor();
    await page.getByRole("textbox", { name: "Message Ranch Hand" }).focus();
    await page.keyboard.press("ControlOrMeta+f");
    await expect(page.getByRole("searchbox", { name: "Find in chat" })).toBeVisible();
    expect(await overlayOnTop(page, ".find-bar")).toEqual({ overlap: true, onTop: true });
  });
});
