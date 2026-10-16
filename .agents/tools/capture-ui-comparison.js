// Playwright CLI run-code function. Optional second argument sets outputDir/prefix.
async (page, { outputDir = ".private/ui-comparison", prefix = "current" } = {}) => {
  const origin = new URL(page.url());
  if (!["127.0.0.1", "localhost"].includes(origin.hostname)) throw Error("Use a loopback fixture.");
  const fixture = await (await page.request.get(`${origin.origin}/api/bootstrap`)).json();
  if (fixture.user?.email !== "preview@localhost.invalid") throw Error("Use the synthetic household preview.");
  const context = await page.context().browser().newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });
  const tab = await context.newPage();
  const paths = [];
  const capture = async state => {
    const path = `${outputDir}/${prefix}-${state}.png`;
    await tab.screenshot({ path, animations: "disabled" });
    paths.push(path);
  };
  const settings = async () => {
    await tab.getByRole("button", { name: "Settings", exact: true }).click();
    await tab.locator(".settings-sheet[open]").waitFor();
  };
  try {
    await tab.goto(`${origin.origin}/?bot=ranch`);
    await settings();
    await tab.getByRole("combobox", { name: "Appearance" }).selectOption("light");
    await tab.getByRole("switch", { name: "Advanced details" }).check();
    await tab.getByRole("button", { name: "Close settings" }).click();
    await tab.getByRole("button", { name: "Model: openrouter / configured-model", exact: true }).waitFor();
    await tab.getByText("Add a shared reminder for both of you?", { exact: true }).waitFor();
    await tab.addStyleTag({ content: "*,*::before,*::after { animation: none !important; transition: none !important; caret-color: transparent !important; }" });
    await capture("desktop-chat");
    await tab.locator('.pinned-bot[aria-current="page"]').click({ button: "right" });
    await tab.getByRole("menu", { name: "Ranch hand", exact: true }).waitFor();
    await capture("desktop-menu");
    await tab.keyboard.press("Escape");
    await tab.getByRole("button", { name: "Model: openrouter / configured-model", exact: true }).click();
    await tab.getByText("OpenAI subscription", { exact: true }).waitFor();
    await capture("desktop-model");
    await tab.keyboard.press("Escape");
    await settings();
    await capture("desktop-settings");
    await tab.getByRole("button", { name: "Close settings" }).click();
    await tab.getByRole("button", { name: "Edit assistant", exact: true }).click();
    await tab.locator(".settings-dialog[open]").waitFor();
    await capture("desktop-assistant-settings");
    await tab.keyboard.press("Escape");
    await settings();
    await tab.setViewportSize({ width: 390, height: 844 });
    await tab.getByRole("combobox", { name: "Appearance" }).selectOption("dark");
    await tab.locator('html[data-theme="dark"]').waitFor();
    await capture("mobile-settings-dark");
    return { origin: origin.origin, prefix, paths };
  } finally {
    await context.close();
  }
}
