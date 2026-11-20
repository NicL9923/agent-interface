import type { Page } from "@playwright/test";
import { assistants, expect } from "./fixtures.js";

/** Screens the cascade checks read, each reached from a signed-in home. */
export type Screen = [string, (page: Page) => Promise<void>];

export const SCREENS: Screen[] = [
  ["home", async () => {}],
  [
    "the assistant menu",
    async (page) => {
      await assistants(page)
        .getByRole("button", { name: /Trail Cook/ })
        .click({ button: "right" });
      await page.locator(".bot-menu").waitFor();
    },
  ],
  [
    "the account menu",
    async (page) => {
      await page.getByRole("button", { name: "Account" }).click();
      await page.getByRole("menu", { name: "Account" }).waitFor();
    },
  ],
  [
    "Settings",
    async (page) => {
      await page.getByRole("button", { name: "Account" }).click();
      await page
        .getByRole("menu", { name: "Account" })
        .getByRole("menuitem", { name: /Settings/ })
        .click();
      await page.locator(".settings-sheet[open]").waitFor();
    },
  ],
  // The e2e server has no push key, so the card never reaches its blocked state here; its class is what the card's
  // warning color hangs on, and Settings' own rules for the same toggle have to leave that color alone.
  [
    "Settings with notifications blocked",
    async (page) => {
      await page.getByRole("button", { name: "Account" }).click();
      await page
        .getByRole("menu", { name: "Account" })
        .getByRole("menuitem", { name: /Settings/ })
        .click();
      await page.locator(".settings-sheet[open]").waitFor();
      await page.evaluate(() =>
        document
          .querySelector(".settings-notifications .notification-settings")
          ?.classList.add("is-blocked"),
      );
      await expect(
        page.locator(
          ".settings-notifications .notification-settings.is-blocked .notification-toggle",
        ),
      ).toBeVisible();
    },
  ],
  [
    "the command palette",
    async (page) => {
      const apple = await page.evaluate(() =>
        /Mac|iPhone|iPad|iPod/i.test(
          (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
            ?.platform ||
            navigator.platform ||
            navigator.userAgent,
        ),
      );
      await page.keyboard.press(apple ? "Meta+k" : "Control+k");
      await page.locator(".command-palette[open]").waitFor();
    },
  ],
  [
    "a chat",
    async (page) => {
      await assistants(page)
        .getByRole("button", { name: /Ranch Hand/ })
        .click();
      await page.getByText("Morning. The north fence is fixed.").waitFor();
      // The jump button shows only after scrolling up; a bare one carries the cascade's answer for its class.
      await page.evaluate(() => {
        const button = document.createElement("button");
        button.className = "jump-latest";
        document.querySelector(".conversation-panel")?.appendChild(button);
      });
    },
  ],
];
