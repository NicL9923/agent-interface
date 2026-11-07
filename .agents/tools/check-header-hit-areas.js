// Playwright CLI run-code function for the loopback preview on port 3000.
// Run it once with PREVIEW_PRESENTATION=advanced and once with simple. At phone and desktop
// widths it checks that no point of the chat header's name button or model chip reaches another
// control, and that closing details opened from the avatar returns focus to the name button.
// Rounded corners may hit a plain wrapper; only a different control counts as a failure.
async page => {
  const origin = 'http://127.0.0.1:3000';
  const results = [];
  for (const [width, height, label] of [[1440, 900, 'desktop'], [390, 844, 'phone']]) {
    const context = await page.context().browser().newContext({ serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width, height } });
    const tab = await context.newPage();
    try {
      await tab.goto(origin);
      await tab.getByText('Ranch hand', { exact: false }).first().click();
      await tab.locator('.chat-header .chat-identity').waitFor();
      const reach = await tab.evaluate(() => {
        const sweep = (selector, owner) => {
          const node = document.querySelector(selector);
          if (!node) return { absent: true, others: [] };
          const box = node.getBoundingClientRect(), others = [];
          for (let x = Math.ceil(box.left); x < box.right; x += 2) for (let y = Math.ceil(box.top); y < box.bottom; y += 2) {
            const hit = document.elementFromPoint(x, y);
            const control = hit?.closest('button, a, input, select, [tabindex], .chat-identity-avatar');
            if (!hit?.closest(owner) && control) others.push(`${x},${y} ${String(control.className || control.tagName).slice(0, 30)}`);
          }
          return { absent: false, others };
        };
        return { name: sweep('.chat-header .chat-identity', '.chat-identity'), chip: sweep('.chat-header .chat-model-slot .model-chip', '.chat-model-slot') };
      });
      for (const [part, value] of Object.entries(reach)) {
        if (value.others.length) throw new Error(`${label}: ${value.others.length} points of the ${part} reach another control, e.g. ${value.others.slice(0, 3).join('; ')}`);
      }
      await tab.locator('.chat-header .chat-identity-avatar').click();
      await tab.locator('.bot-details').waitFor();
      await tab.keyboard.press('Escape');
      await tab.locator('.bot-details').waitFor({ state: 'detached' });
      if (!await tab.evaluate(() => document.activeElement?.classList.contains('chat-identity'))) throw new Error(`${label}: closing details from the avatar did not return focus to the name button`);
      results.push(`${label}: name and chip reach only themselves${reach.chip.absent ? ' (no chip in Simple)' : ''}; focus returns to the name`);
    } finally { await context.close(); }
  }
  return results.join('\n');
}
