// Playwright CLI function for the simulated loopback desktop and terminal.
async (page, { origin, outputDir }) => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('Use the loopback fixture preview');
  const context = await page.context().browser().newContext({ serviceWorkers: 'block', reducedMotion: 'reduce', colorScheme: 'light' });
  const tab = await context.newPage();
  const paths = [];
  const shot = async name => {
    await tab.mouse.move(0, 0);
    await tab.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const path = `${outputDir}/${name}.png`;
    await tab.screenshot({ path, animations: 'disabled' }); paths.push(path);
  };
  try {
    for (const width of [1440, 390]) {
      await tab.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await tab.goto(`${origin}/?computer=1`);
      const panel = tab.getByRole('dialog', { name: 'Computer', exact: true });
      const take = panel.getByRole('button', { name: 'Take over', exact: true });
      await take.waitFor();
      await tab.waitForFunction(() => !document.querySelector('.computer-control-actions .primary')?.disabled);
      await panel.locator('.computer-screen canvas').waitFor();
      await shot(`computer-watching-${width}`);
      await take.click();
      await panel.locator('.computer-ownership strong').filter({ hasText: 'You have control' }).waitFor();
      await shot(`computer-control-${width}`);
      if (width === 390) {
        await panel.getByRole('button', { name: 'Type text', exact: true }).click();
        await panel.getByRole('textbox').fill('Fixture text, not sent to a real desktop.');
        await shot(`computer-type-${width}`);
        await panel.getByRole('button', { name: 'Type text', exact: true }).click();
      }
      await panel.getByRole('button', { name: 'Hand back', exact: true }).click();
      await take.waitFor();
      if (width === 390) {
        await tab.route('**/api/computer', async route => {
          const response = await route.fetch();
          const status = await response.json();
          await route.fulfill({ json: { ...status, control: { kind: 'human', name: 'Jordan', mine: false } } });
        });
        await tab.evaluate(() => window.dispatchEvent(new Event('focus')));
        await panel.getByText('Jordan has control', { exact: true }).waitFor();
        if (await take.isEnabled()) throw new Error('Another member can be interrupted');
        await shot(`computer-other-member-${width}`);
        await tab.unroute('**/api/computer');
        await tab.evaluate(() => window.dispatchEvent(new Event('focus')));
      }
      await panel.getByRole('tab', { name: 'Terminal', exact: true }).click();
      await panel.getByText('Your system terminal', { exact: true }).waitFor();
      await panel.locator('.xterm-rows').waitFor();
      await shot(`computer-terminal-${width}`);
      if (width === 390) {
        await panel.getByRole('button', { name: 'Paste text', exact: true }).click();
        await panel.getByRole('textbox', { name: 'Paste into your terminal', exact: true }).fill('echo fixture-only');
        await shot(`computer-paste-${width}`);
        await panel.getByRole('button', { name: 'Send text', exact: true }).click();
        await panel.getByRole('button', { name: 'Send Ctrl+C', exact: true }).click();
      }
      await panel.getByRole('button', { name: 'End shell', exact: true }).click();
      await shot(`computer-end-confirm-${width}`);
      await panel.getByRole('button', { name: 'Keep shell', exact: true }).click();
      await panel.getByRole('button', { name: 'End shell', exact: true }).click();
      await panel.getByRole('button', { name: 'End this shell', exact: true }).click();
      await panel.getByText('Your shell has ended', { exact: true }).waitFor();
      await shot(`computer-shell-ended-${width}`);
      await panel.getByRole('button', { name: 'Close computer', exact: true }).click();
    }
    await tab.goto(`${origin}/?computer=1&computerTab=terminal`);
    const terminalPanel = tab.getByRole('dialog', { name: 'Computer', exact: true });
    await terminalPanel.getByText('Your system terminal', { exact: true }).waitFor();
    if (await terminalPanel.getByRole('tab', { name: 'Terminal', exact: true }).getAttribute('aria-selected') !== 'true') throw new Error('Terminal link opened the wrong tab');
    await shot('computer-terminal-link-390');
    await terminalPanel.getByRole('button', { name: 'End shell', exact: true }).click();
    await terminalPanel.getByRole('button', { name: 'End this shell', exact: true }).click();
    await terminalPanel.getByText('Your shell has ended', { exact: true }).waitFor();
    return { paths };
  } catch (error) {
    await tab.screenshot({ path: `${outputDir}/capture-failure.png` }).catch(() => {});
    throw error;
  } finally { await context.close(); }
}
