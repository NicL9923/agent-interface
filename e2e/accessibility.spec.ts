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

// A hover fill sits under text that keeps its own color. Two of them once took that text under 4.5:1: the selected
// avatar preview state, whose light text met the pale hover fill at 1.18:1, and a routine card whose status word, in
// the attention color, met the app's hover fill at 3.83:1. Bare elements with the components' classes carry the
// cascade's answer; they sit inside the settings dialog because the page behind a modal cannot be hovered.
test.describe("hover fills under text", () => {
  // The route below changes an API answer. Worker-owned requests bypass page routing in WebKit.
  test.use({ serviceWorkers: "block" });
  for (const colorScheme of ["light", "dark"] as const) hoverContrast(colorScheme);
});

function hoverContrast(colorScheme: "light" | "dark") {
  test(`hovered routine cards and the selected avatar state keep readable text, ${colorScheme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    // The e2e runtime's assistant has no instructions, which the settings read requires.
    await page.route(/\/api\/bots\/ranch$/, async (route) => {
      const headers = { ...route.request().headers() };
      delete headers["if-none-match"];
      const body = await (await route.fetch({ headers })).json();
      await route.fulfill({ json: { ...body, instructions: "Keep the gates latched." } });
    });
    await signIn(page);
    // The chat loads the routine card's stylesheet and the settings load the avatar editor's.
    await assistants(page)
      .getByRole("button", { name: /Ranch Hand/ })
      .click();
    await page.getByText("Morning. The north fence is fixed.").waitFor();
    await assistants(page)
      .getByRole("button", { name: /Ranch Hand/ })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: /Assistant settings/ }).click();
    await page
      .locator(".settings-dialog[open] .settings-content:not(.settings-load-state)")
      .waitFor();
    // A hovered control eases toward its hover fill, and a value read mid-ease is the fill it left.
    await page.addStyleTag({
      content:
        "*, *::before, *::after { transition: none !important; animation: none !important; }",
    });
    const loaded = await page.evaluate(() => {
      const card = (tone: string, state: string) =>
        `<div class="routine-run run-${tone}" data-probe="${tone}"><button type="button" class="routine-run-summary">` +
        `<span class="run-dot"></span><span class="routine-run-heading"><span class="routine-run-name">Feed inventory</span>` +
        `<span class="routine-run-meta"><span class="routine-run-state">${state}</span></span></span></button></div>`;
      const probe = document.createElement("div");
      probe.innerHTML =
        `<div class="avatar-stage-states"><button type="button" aria-pressed="true" data-probe="avatar">Working</button></div>` +
        card("warning", "Finished, not delivered") +
        card("running", "Running");
      document.querySelector(".settings-dialog[open]")!.prepend(probe);
      // Each value comes from the component's own stylesheet, so a sheet that never loaded fails here, not below.
      return {
        avatar: getComputedStyle(probe.querySelector('[data-probe="avatar"]')!).borderTopLeftRadius,
        card: getComputedStyle(probe.querySelector(".routine-run-summary")!).display,
      };
    });
    expect(loaded).toEqual({ avatar: "999px", card: "grid" });
    const hoveredContrast = async (hover: string, text: string) => {
      await page.locator(hover).hover();
      return page.locator(text).evaluate((element) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        // The canvas turns any CSS color, color-mix and oklab included, into sRGB bytes.
        const bytes = (color: string) => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data];
        };
        const over = (top: number[], under: number[]) =>
          [0, 1, 2].map((at) => (top[at] * top[3] + under[at] * (255 - top[3])) / 255).concat(255);
        const fills: number[][] = [];
        for (let node: Element | null = element; node; node = node.parentElement) {
          const fill = bytes(getComputedStyle(node).backgroundColor);
          if (fill[3] > 0) fills.push(fill);
          if (fill[3] === 255) break;
        }
        const behind = fills.reduceRight((under, fill) => over(fill, under), [255, 255, 255, 255]);
        const ink = over(bytes(getComputedStyle(element).color), behind);
        const channel = (value: number) =>
          value / 255 <= 0.04045 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4;
        const light = (color: number[]) =>
          0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
        const [upper, lower] = [light(ink), light(behind)].sort((a, b) => b - a);
        return (upper + 0.05) / (lower + 0.05);
      });
    };
    const avatar = '[data-probe="avatar"]';
    expect(await hoveredContrast(avatar, avatar), "selected avatar state").toBeGreaterThanOrEqual(
      4.5,
    );
    for (const tone of ["warning", "running"]) {
      const card = `[data-probe="${tone}"]`;
      expect(
        await hoveredContrast(`${card} .routine-run-summary`, `${card} .routine-run-state`),
        `${tone} routine card`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
}

// A message on its way is drawn faint. Fading a solid bubble mixes its fill toward the page while its text stays
// white, which takes the text under 4.5:1, so only the tinted bubble fades.
test("a solid bubble keeps its fill while its message sends", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await signIn(page);
  await assistants(page)
    .getByRole("button", { name: /Ranch Hand/ })
    .click();
  await page.getByText("Morning. The north fence is fixed.").waitFor();
  const opacity = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(".conversation-panel")!;
    // The seeded assistant has a portrait, so the chat has no tint of its own; a drawn avatar's color stands in.
    panel.setAttribute("data-tint", "");
    panel.style.setProperty("--bot-tint", "#1084FE");
    const sending = document.createElement("article");
    sending.className = "message message-user message-outgoing message-sending";
    sending.innerHTML = '<div class="message-bubble">Fix the south fence too</div>';
    // A sent message eases between the two, and a value read mid-ease is neither.
    sending.style.transition = "none";
    document.querySelector(".transcript-content")!.appendChild(sending);
    const read = (fill: string) => {
      panel.setAttribute("data-own-bubble", fill);
      return getComputedStyle(sending).opacity;
    };
    return { tint: read("tint"), solid: read("solid") };
  });
  expect(opacity).toEqual({ tint: "0.66", solid: "1" });
});

// Both bubbles carry a transparent border that only increased contrast and forced colors draw, so their edge shows
// where the fill alone does not. The reply bubble's default lives in the components layer, which ranks above base.
for (const [mode, media] of [
  ["increased contrast", { contrast: "more" }],
  ["forced colors", { forcedColors: "active" }],
] as const) {
  test(`both chat bubbles draw an edge under ${mode}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce", ...media });
    await signIn(page);
    // Asked of the page itself: a browser that takes the setting and draws as if it were off has nothing to read.
    const applied = await page.evaluate(
      (query) => matchMedia(query).matches,
      mode === "forced colors" ? "(forced-colors: active)" : "(prefers-contrast: more)",
    );
    test.skip(!applied, `This browser does not apply the ${mode} setting`);
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
