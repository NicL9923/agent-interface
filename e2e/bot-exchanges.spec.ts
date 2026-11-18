import AxeBuilder from "@axe-core/playwright";
import { assistants, conversation, expect, signIn, test } from "./fixtures.js";

// This fixture replaces a conversation response. Worker-owned requests bypass page routing in WebKit.
test.use({ serviceWorkers: "block" });

for (const width of [320, 1280])
  test(`bot exchanges collapse and reveal with a keyboard at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({
      colorScheme: width === 320 ? "light" : "dark",
      reducedMotion: "reduce",
    });
    await page.route("**/api/bots/ranch/conversation**", async (route) => {
      const headers = { ...route.request().headers() };
      delete headers["if-none-match"];
      const response = await route.fetch({ headers });
      const data = await response.json();
      await route.fulfill({
        response,
        json: {
          ...data,
          messages: [
            {
              id: "human",
              role: "user",
              text: "Please coordinate the fence check.",
              sender: { id: "local", name: "Nicolas" },
            },
            {
              id: "bot-in",
              role: "user",
              text: "Message from Trail Cook (@trail): The north gate needs a check.",
              createdAt: "2026-11-15T16:00:00Z",
            },
            {
              id: "bot-reply",
              role: "assistant",
              text: "The north gate is shut.",
              origin: {
                kind: "agent",
                visibility: "activity",
                name: "Trail Cook",
                handle: "trail",
              },
            },
            {
              id: "bot-out",
              role: "tool",
              text: "",
              toolCall: {
                id: "handoff",
                name: "message_agent",
                status: "failed",
                arguments: '{"target":"trail","message":"The fence check is complete."}',
                error: "Trail Cook is offline.",
              },
            },
          ],
        },
      });
    });
    await signIn(page);
    await assistants(page)
      .getByRole("button", { name: /Ranch Hand/ })
      .click();
    const group = conversation(page).locator(".agent-exchange-group");
    const summary = group.locator(":scope > summary");
    await expect(summary).toContainText("3 bot messages");
    await expect(summary).toContainText("1 failed");
    await expect(group.getByText("The north gate is shut.", { exact: true })).toBeHidden();
    await expect(
      summary.getByRole("group", { name: "Trail Cook to Ranch Hand", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("collapsed.png") });
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(group.getByText("The north gate is shut.", { exact: true })).toBeVisible();
    await expect(group.getByText("The fence check is complete.", { exact: true })).toBeVisible();
    const scan = await new AxeBuilder({ page })
      .include(".agent-exchange-group")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(scan.violations).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("expanded.png") });
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: test.info().outputPath("large-text.png") });
    await page.keyboard.press("Enter");
    await expect(group.getByText("The north gate is shut.", { exact: true })).toBeHidden();
  });
