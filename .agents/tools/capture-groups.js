// Playwright CLI run-code function. Supply an existing preview origin and SSD outputDir.
async (page, { origin, outputDir }) => {
  const context = await page.context().browser().newContext({
    serviceWorkers: 'block', reducedMotion: 'reduce',
  });
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
  try {
    for (const width of [1440, 390]) {
      await tab.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await tab.goto(`${origin}/?view=groups`);
      const panel = tab.locator('.group-panel');
      const composer = panel.getByRole('textbox', { name: 'Message the group', exact: true });
      await panel.locator('.group-message').first().waitFor();
      await shot(`group-conversation-${width}`);

      await composer.fill('@ra');
      await panel.getByRole('listbox', { name: 'Assistants in this group' }).waitFor();
      await shot(`group-mention-${width}`);
      const count = await panel.locator('.group-message').count();
      await composer.press('Enter');
      if (!(await composer.inputValue()).startsWith('@ranch ')) throw new Error('Mention did not insert its handle');
      if (await panel.locator('.group-message').count() !== count) throw new Error('Mention Enter sent a message');

      await composer.fill('@ranch Can we keep the walk under an hour?');
      await panel.getByRole('button', { name: 'Reply in thread', exact: true }).first().click();
      await panel.locator('.group-thread').waitFor();
      await composer.scrollIntoViewIfNeeded();
      await shot(`group-thread-${width}`);
      await panel.getByRole('button', { name: 'New topic', exact: true }).click();
      if (await panel.locator('.group-thread').count()) throw new Error('New topic kept the thread selected');

      await panel.getByRole('button', { name: 'New group', exact: true }).click();
      const form = panel.locator('.group-create');
      await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Weekend plans');
      await form.getByRole('checkbox', { name: 'Ranch hand', exact: true }).check();
      await form.getByRole('checkbox', { name: 'Garden planner', exact: true }).check();
      if (!(await form.getByRole('button', { name: 'Create group', exact: true }).isEnabled())) throw new Error('Two selected assistants did not enable creation');
      await shot(`group-create-${width}`);
      await form.getByRole('button', { name: 'Cancel', exact: true }).click();
      if (await composer.inputValue() !== '@ranch Can we keep the walk under an hour?') throw new Error('Creating then cancelling lost the conversation draft');
      if (width === 390) {
        await panel.getByRole('button', { name: 'Send to group', exact: true }).click();
        await panel.locator('.group-message').filter({ hasText: '@ranch Can we keep the walk under an hour?' }).waitFor();
        if (await composer.inputValue()) throw new Error('Confirmed send kept the draft');
        await shot(`group-sent-${width}`);
      }
    }
    return { paths };
  } finally {
    await context.close();
  }
}
