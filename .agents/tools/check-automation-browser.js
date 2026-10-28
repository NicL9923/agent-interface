// Evaluate in the collaborative loopback preview at phone and desktop widths.
(async () => {
  if (location.origin !== 'http://127.0.0.1:3021' || !document.querySelector('script[src="/preview-fixture.js"]')) throw Error('Synthetic port-3021 preview required');
  const wait = async (predicate, description) => {
    const end = Date.now() + 8000;
    while (Date.now() < end) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw Error('Timed out: ' + description);
  };
  const textButton = (name, scope = document) => [...scope.querySelectorAll('button')].find(item => item.textContent.trim() === name);
  const click = async name => { const item = await wait(() => textButton(name), name); if (item.disabled) throw Error(name + ' is disabled'); item.click(); };
  const dialog = () => document.querySelector('dialog[open][aria-labelledby="assistant-settings-title"]');
  if (!dialog()) {
    (await wait(() => document.querySelector('button[aria-label="Ranch hand"]'), 'chat header')).click();
    (await wait(() => textButton('Settings', document.querySelector('.bot-details-actions') || document.createElement('div')), 'assistant settings')).click();
  }
  await wait(dialog, 'settings dialog');
  const section = async name => {
    const menu = document.querySelector('.settings-tabs-overflow'); if (menu) menu.open = true;
    const item = await wait(() => textButton(name, document.querySelector('.settings-tabs')), name + ' tab');
    item.click();
    await wait(() => document.querySelector('.automation-panel') && textButton('Refresh status') && !textButton('Refresh status').disabled, 'loaded ' + name);
  };
  await section('work');
  await wait(() => textButton('Resume goal') || textButton('Pause goal'), 'goal controls');
  if (textButton('Resume goal')) { await click('Resume goal'); await wait(() => textButton('Pause goal'), 'goal started'); }
  await click('Pause goal'); await wait(() => textButton('Resume goal'), 'goal paused');
  await click('New task');
  const fill = (label, value) => {
    const input = [...dialog().querySelectorAll('label')].find(item => item.firstChild?.textContent === label)?.querySelector('input,textarea');
    if (!input) throw Error('Missing field: ' + label);
    const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const title = 'Browser fixture task ' + Date.now();
  fill('Task title', title); fill('Instructions (optional)', 'Read the last inspection report. Ask before purchases.');
  await new Promise(resolve => setTimeout(resolve, 40));
  await click('Create task');
  const created = await wait(() => [...dialog().querySelectorAll('details.automation-item')].find(item => item.querySelector('summary')?.textContent.includes(title)), 'created blocked task');
  if (!created.querySelector('.automation-task-status')?.textContent.includes('Blocked')) throw Error('Task did not start blocked');
  if (!created.open) created.querySelector('summary').click();
  textButton('Start task', created).click();
  await wait(() => created.querySelector('.automation-task-status')?.textContent.includes('Ready'), 'native task status refreshed');
  const overflow = [...dialog().querySelectorAll('.automation-panel, .automation-form, .automation-code')].some(item => item.scrollWidth > item.clientWidth + 1);
  if (overflow) throw Error('Automation content overflows');
  await section('learning');
  if (textButton('Review change')) {
    await click('Review change');
    await wait(() => document.querySelector('.automation-code')?.textContent.includes('+Check water'), 'actual skill diff');
    if (!textButton('Approve change') || textButton('Approve change').disabled) throw Error('Full diff approval unavailable');
  }
  return { viewport: { width: innerWidth, height: innerHeight }, goalResumePause: true, taskCreateStart: true, skillDiffReview: true, noOverflow: true, fixtureOnly: true };
})()
