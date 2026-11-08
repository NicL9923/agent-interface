async page => {
  const checked = [];
  for (const width of [390, 1280]) {
    const paths = [];
    const observe = request => { if (request.url().includes('/history/')) paths.push(new URL(request.url()).pathname + new URL(request.url()).search); };
    page.on('request', observe);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('http://127.0.0.1:3017');
    const search = page.getByRole('button', { name: 'Search & saved', exact: true });
    if (!await search.isVisible()) await page.getByRole('button', { name: 'Back to assistants', exact: true }).click();
    await search.click();
    await page.getByRole('textbox', { name: 'Search conversations', exact: true }).fill('battery');
    await page.locator('.discovery-search button').click();
    await page.getByRole('button', { name: /Gate battery plan/ }).click();
    const target = page.locator('#history-m2');
    await target.waitFor({ state: 'visible' });
    const result = await target.evaluate(element => ({ top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom, border: element.style.borderLeft, text: element.textContent }));
    if (!paths.some(path => path.includes('messageId=m2'))) throw new Error('History request lost the matching message pointer');
    if (!result.border.includes('3px')) throw new Error('The matching answer was not highlighted');
    if (result.bottom <= 0 || result.top >= 900) throw new Error('The matching answer did not scroll into view');
    await page.screenshot({ path: `.private/search-pointer-${width}.png` });
    checked.push({ width, paths, top: result.top, bottom: result.bottom });
    page.off('request', observe);
  }
  return checked;
}
