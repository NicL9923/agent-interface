import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { assistants, conversation, expect, signIn, test } from "./fixtures.js";

async function useTheme(page: Page, theme: string) {
  const saved = await page.evaluate(async (selectedTheme) => {
    const boot = (await (await fetch("/api/bootstrap")).json()) as {
      csrfToken: string;
      preferences: Record<string, unknown>;
    };
    return (
      await fetch("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": boot.csrfToken },
        body: JSON.stringify({ ...boot.preferences, theme: selectedTheme }),
      })
    ).status;
  }, theme);
  expect(saved).toBe(200);
}

// A local noon inside each season's window in src/app/season.ts. The calendar decides the season, so the
// screen scans above cover only whichever season the run date falls in.
const seasonDays = {
  winter: "2026-12-15",
  clover: "2027-03-15",
  spring: "2027-03-25",
  stars: "2027-07-01",
  spooky: "2026-10-20",
  harvest: "2026-11-20",
};

for (const [width, height] of [
  [390, 844],
  [1280, 800],
]) {
  for (const theme of ["light", "dark"]) {
    test(`WCAG accessibility at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
      await signIn(page);
      await useTheme(page, theme);
      await page.goto("/");
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
        .toBe(theme);
      // Scan the settled screen, not a transient frame of an entrance or theme transition.
      await page.addStyleTag({
        content:
          "*, *::before, *::after { transition: none !important; animation: none !important; }",
      });
      await expect(assistants(page).getByRole("button", { name: /Ranch Hand/ })).toBeVisible();
      const scan = async (screen: string) => {
        const result = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze();
        expect(
          result.violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
          screen,
        ).toEqual([]);
      };
      await scan("home");
      await assistants(page)
        .getByRole("button", { name: /Ranch Hand/ })
        .click();
      await page.getByRole("textbox", { name: "Message Ranch Hand" }).fill("Is the gate latched?");
      await page.getByRole("button", { name: "Send message" }).click();
      await expect(
        conversation(page).getByText("Howdy, partner. You said: Is the gate latched?", {
          exact: true,
        }),
      ).toBeVisible();
      await scan("chat");
      await page.locator(".chat-identity").click();
      await expect(page.getByRole("dialog").first()).toBeVisible();
      await scan("assistant details");
      await page.keyboard.press("Escape");
      if (width === 390) await page.getByRole("button", { name: "Back to assistants" }).click();
      await page.getByRole("button", { name: "Account" }).click();
      await page
        .getByRole("menu", { name: "Account" })
        .getByRole("menuitem", { name: /Settings/ })
        .click();
      await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
      await scan("Settings");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Today" }).click();
      await expect(page.getByRole("heading", { name: /Today/ }).first()).toBeVisible();
      await scan("Today");
    });
  }
}

for (const theme of ["light", "dark"]) {
  test(`seasonal home keeps WCAG contrast in every season in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signIn(page);
    await useTheme(page, theme);
    for (const [season, day] of Object.entries(seasonDays)) {
      await page.clock.setFixedTime(new Date(`${day}T12:00:00`));
      await page.goto("/");
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
        .toBe(theme);
      await page.addStyleTag({
        content:
          "*, *::before, *::after { transition: none !important; animation: none !important; }",
      });
      await expect(page.locator(`.bot-rail[data-season="${season}"]`)).toBeVisible();
      await expect(assistants(page).getByRole("button", { name: /Ranch Hand/ })).toBeVisible();
      const result = await new AxeBuilder({ page })
        .include(".bot-rail")
        .withRules(["color-contrast"])
        .analyze();
      expect(result.violations, season).toEqual([]);
    }
  });
}

// Both bubbles carry a transparent border that only increased contrast and forced colors draw, so their edge shows
// where the fill alone does not. The reply bubble's default lives in the components layer, which ranks above base.
for (const [mode, media] of [
  ["increased contrast", { contrast: "more" }],
  ["forced colors", { forcedColors: "active" }],
] as const) {
  test(`both chat bubbles draw an edge under ${mode}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce", ...media });
    await signIn(page);
    await assistants(page)
      .getByRole("button", { name: /Ranch Hand/ })
      .click();
    await page.getByText("Morning. The north fence is fixed.").waitFor();
    const edges = await page.evaluate(() => {
      // The seeded chat holds no message of the person's, so a bare one carries the cascade's answer for its classes.
      const person = document.createElement("article");
      person.className = "message message-user";
      person.innerHTML = '<div class="message-bubble">Fix the south fence too</div>';
      document.querySelector(".transcript-content")!.appendChild(person);
      const edge = (selector: string) => {
        const style = getComputedStyle(document.querySelector(selector)!);
        return { width: style.borderTopWidth, color: style.borderTopColor };
      };
      return { reply: edge(".reply-bubble"), person: edge(".message-user > .message-bubble") };
    });
    for (const [bubble, edge] of Object.entries(edges)) {
      expect(edge.width, bubble).toBe("1px");
      expect(edge.color, bubble).not.toMatch(/^rgba\(\d+, \d+, \d+, 0\)$|transparent/);
    }
  });
}
