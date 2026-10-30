// Playwright CLI run-code function. Supply an existing preview origin and SSD outputDir.
async (page, { origin, outputDir }) => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('Use the loopback fixture preview');
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
      await panel.locator('.group-reply').first().click();
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
      const choices = await form.getByRole('checkbox').all();
      for (const choice of choices) {
        if (await form.locator('input:checked').count() === 6) break;
        if (!await choice.isChecked()) await choice.check();
      }
      await form.getByText('Six assistants selected. Deselect one to choose another.', { exact: true }).waitFor();
      await shot(`group-create-limit-${width}`);
      await form.getByRole('button', { name: 'Cancel', exact: true }).click();
      if (await composer.inputValue() !== '@ranch Can we keep the walk under an hour?') throw new Error('Creating then cancelling lost the conversation draft');
      if (width === 390) {
        await panel.getByRole('button', { name: 'Send to group', exact: true }).click();
        await panel.locator('.group-message').filter({ hasText: '@ranch Can we keep the walk under an hour?' }).waitFor();
        await tab.waitForFunction(() => document.querySelector('#group-message')?.value === '');
        if (await composer.inputValue()) throw new Error('Confirmed send kept the draft');
        await tab.waitForFunction(() => {
          const last = [...document.querySelectorAll('.group-message')].at(-1)?.getBoundingClientRect();
          const composer = document.querySelector('.group-composer')?.getBoundingClientRect();
          return last && composer && last.bottom <= composer.top - 8;
        });
        await shot(`group-sent-${width}`);
      }
    }
    // Render a named pending approval without running its command or changing production data.
    await context.route(url => /^\/api\/groups\/[^/]+$/.test(url.pathname), async route => {
      const response = await route.fetch();
      const data = await response.json();
      data.driver_status = { running: true, working: false, blocked: true, pending_actions: [{
        kind: 'approval', task_id: 'fixture-weather', member_id: 'ranch', execution_generation: 1,
        request_id: 'fixture-approval', approval: { description: 'Read the local weather forecast before planning the walk.' },
      }] };
      await route.fulfill({ response, json: data });
    });
    for (const width of [1440, 390]) {
      await tab.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await tab.goto(`${origin}/?view=groups`);
      const card = tab.locator('.group-panel .approval-card');
      await card.waitFor();
      await card.evaluate(node => node.scrollIntoView({ block: 'center' }));
      const decision = await card.getByRole('button', { name: 'Deny', exact: true }).boundingBox();
      const composer = await tab.locator('.group-composer').boundingBox();
      if (!decision || !composer || decision.y + decision.height > composer.y) throw new Error('Approval controls are hidden by the composer');
      await shot(`group-approval-${width}`);
    }
    return { paths };
  } catch (error) {
    await tab.screenshot({ path: `${outputDir}/capture-failure.png` }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}
