// Playwright CLI run-code function for the loopback fixture preview.
async (page, { origin, outputDir }) => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('Use the loopback fixture preview');
  const context = await page.context().browser().newContext({ serviceWorkers: 'block', reducedMotion: 'reduce', colorScheme: 'light' });
  const tab = await context.newPage();
  const paths = [];
  const shot = async name => {
    await tab.mouse.move(0, 0);
    await tab.evaluate(async () => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const path = `${outputDir}/${name}.png`;
    await tab.screenshot({ path, animations: 'disabled' });
    paths.push(path);
  };
  const save = async action => {
    const response = tab.waitForResponse(response => new URL(response.url()).pathname === '/api/preferences' && response.request().method() === 'PATCH');
    await action();
    if (!(await response).ok()) throw new Error('Fixture preferences did not save');
  };
  try {
    for (const width of [1440, 390]) {
      await tab.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await tab.goto(`${origin}/?view=conversation&bot=ranch`);
      await tab.locator('article[data-message-id]').first().waitFor();
      if (width === 390) await tab.getByRole('button', { name: 'Back to assistants', exact: true }).click();
      await tab.getByRole('button', { name: 'Settings', exact: true }).click();
      const sheet = tab.getByRole('dialog', { name: 'Settings', exact: true });
      await sheet.waitFor();
      await shot(`settings-main-${width}`);
      const advanced = sheet.getByRole('switch', { name: /^Advanced details/ });
      await save(() => advanced.setChecked(true));
      await save(() => advanced.setChecked(false));

      await sheet.getByRole('button', { name: /^Following \d+ assistants?/ }).click();
      const following = tab.getByRole('dialog', { name: 'Following', exact: true });
      const ranch = following.getByRole('checkbox', { name: /Ranch hand/ });
      await save(() => ranch.check());
      await shot(`settings-following-${width}`);
      await save(() => ranch.uncheck());
      await following.getByRole('button', { name: 'Back to settings', exact: true }).click();

      await sheet.getByRole('textbox', { name: 'New section name', exact: true }).fill('Weekend');
      await save(() => sheet.getByRole('button', { name: 'Add', exact: true }).click());
      await sheet.getByRole('button', { name: /^Weekend/ }).click();
      let section = tab.getByRole('dialog', { name: 'Weekend', exact: true });
      await section.getByRole('textbox', { name: 'Section name', exact: true }).fill('Weekend plans');
      await save(() => section.getByRole('button', { name: 'Rename', exact: true }).click());
      section = tab.getByRole('dialog', { name: 'Weekend plans', exact: true });
      await save(() => section.getByRole('checkbox', { name: /Homework helper/ }).check());
      await shot(`settings-section-${width}`);
      await section.getByRole('button', { name: 'Back to settings', exact: true }).click();
      await save(() => sheet.getByRole('button', { name: 'Move Weekend plans up', exact: true }).click());
      await sheet.getByRole('heading', { name: 'Home sections', exact: true }).scrollIntoViewIfNeeded();
      await shot(`settings-sections-${width}`);
      await sheet.getByRole('button', { name: /^Weekend plans/ }).click();
      await save(() => tab.getByRole('button', { name: 'Delete section', exact: true }).click());

      await sheet.getByRole('button', { name: /^Keyboard shortcuts/ }).click();
      const help = tab.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true });
      await help.waitFor();
      await shot(`settings-shortcuts-${width}`);
      await help.getByRole('button', { name: 'Close keyboard shortcuts', exact: true }).click();
      await sheet.getByRole('button', { name: 'Close settings', exact: true }).click();

      await tab.keyboard.press('Meta+k');
      const palette = tab.getByRole('dialog', { name: 'Command palette', exact: true });
      await palette.waitFor();
      await shot(`settings-palette-${width}`);
      await palette.getByRole('combobox', { name: 'Search assistants and actions', exact: true }).fill('settings');
      await shot(`settings-palette-filtered-${width}`);
      await tab.keyboard.press('Enter');
      await sheet.waitFor();
      await sheet.getByRole('button', { name: 'Close settings', exact: true }).click();

      await tab.goto(`${origin}/?view=conversation&bot=ranch`);
      await tab.locator('article[data-message-id]').first().waitFor();
      await tab.keyboard.press('Meta+f');
      const find = tab.getByRole('searchbox', { name: 'Find in chat', exact: true });
      await find.fill('gate');
      await tab.waitForFunction(() => document.querySelector('.find-count')?.textContent.includes(' of '));
      await shot(`settings-find-chat-${width}`);
      await tab.getByRole('button', { name: 'Older match', exact: true }).click();
      await find.press('Escape');
      if (await find.count()) throw new Error('Escape did not close Find');
    }
    return { paths };
  } catch (error) {
    await tab.screenshot({ path: `${outputDir}/capture-failure.png` }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}
