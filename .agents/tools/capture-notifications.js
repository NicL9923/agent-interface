// Playwright CLI function. Push permission and subscription are explicit fakes.
async (page, { origin, outputDir }) => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('Use the loopback fixture preview');
  const context = await page.context().browser().newContext({ serviceWorkers: 'block', reducedMotion: 'reduce', colorScheme: 'light' });
  await context.addInitScript(() => {
    let permission = 'default', subscription = null;
    const worker = { active: {}, waiting: null, installing: null, addEventListener() {}, removeEventListener() {}, update: async () => {},
      pushManager: { getSubscription: async () => subscription, subscribe: async () => {
        subscription = { endpoint: 'https://push.fixture.invalid/notifications-design',
          toJSON: () => ({ endpoint: 'https://push.fixture.invalid/notifications-design', keys: { p256dh: 'fixture-key', auth: 'fixture-auth' } }),
          unsubscribe: async () => { subscription = null; return true; } };
        return subscription;
      } } };
    Object.defineProperty(window, 'Notification', { configurable: true, value: { get permission() { return permission; }, requestPermission: async () => { permission = 'granted'; return permission; } } });
    Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
      getRegistration: async () => worker, register: async () => worker, ready: Promise.resolve(worker), controller: null,
      addEventListener() {}, removeEventListener() {},
    } });
    window.fixturePermission = value => { permission = value; window.dispatchEvent(new Event('focus')); };
  });
  const tab = await context.newPage(), paths = [];
  let initialPreferences;
  const shot = async name => {
    await tab.mouse.move(0, 0);
    await tab.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const path = `${outputDir}/${name}.png`; await tab.screenshot({ path, animations: 'disabled' }); paths.push(path);
  };
  const save = async action => {
    const response = tab.waitForResponse(response => new URL(response.url()).pathname === '/api/preferences' && response.request().method() === 'PATCH');
    await action(); if (!(await response).ok()) throw new Error('Fixture preferences did not save');
  };
  try {
    const boot = await context.request.get(`${origin}/api/bootstrap`);
    if (!boot.ok()) throw new Error('Fixture bootstrap failed');
    initialPreferences = (await boot.json()).preferences;
    for (const width of [1440, 390]) {
      await context.request.patch(`${origin}/api/preferences`, { data: { ...initialPreferences, notifications: { timezone: 'America/Chicago', batchMinutes: 0 } } });
      await tab.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await tab.goto(origin);
      await tab.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('agent-interface:notifications-prompt:')).forEach(key => localStorage.removeItem(key)));
      await tab.goto(`${origin}/?view=conversation&bot=ranch`);
      const invitation = tab.getByRole('heading', { name: 'Enable notifications on this device?', exact: true });
      await invitation.waitFor(); await shot(`notification-invitation-${width}`);
      await tab.getByRole('button', { name: 'Not now', exact: true }).click();
      if (width === 390) await tab.getByRole('button', { name: 'Back to assistants', exact: true }).click();
      await tab.getByRole('button', { name: 'Settings', exact: true }).click();
      const settings = tab.getByRole('dialog', { name: 'Settings', exact: true });
      await settings.getByRole('heading', { name: 'Notifications', exact: true }).evaluate(node => node.scrollIntoView({ block: 'start' }));
      const toggle = settings.getByRole('switch', { name: 'Notifications on this device', exact: true });
      await toggle.waitFor(); await shot(`notification-disabled-${width}`);
      await toggle.click();
      await settings.getByText('You\'ll get alerts here for finished work and requests that need you.', { exact: true }).waitFor();
      await shot(`notification-enabled-${width}`);
      await save(() => settings.getByRole('combobox', { name: /^Batching/ }).selectOption('5'));
      await save(() => settings.getByRole('switch', { name: 'Quiet hours', exact: true }).check());
      await settings.getByRole('heading', { name: 'Notifications', exact: true }).evaluate(node => node.scrollIntoView({ block: 'start' }));
      await shot(`notification-quiet-hours-${width}`);
      await settings.getByRole('button', { name: /^(Following \d+ assistants?|Not following any assistants)/ }).click();
      const following = tab.getByRole('dialog', { name: 'Following', exact: true });
      const ranch = following.getByRole('checkbox', { name: /Ranch hand/ });
      await save(() => ranch.check());
      await shot(`notification-following-${width}`);
      await save(() => ranch.uncheck());
      await following.getByRole('button', { name: 'Back to settings', exact: true }).click();
      const until = settings.getByLabel('Until', { exact: true });
      await until.fill('22:00');
      await settings.getByText('Choose an end time different from the start.', { exact: true }).waitFor();
      await shot(`notification-quiet-error-${width}`);
      await save(() => until.fill('08:00'));
      await toggle.click();
      await settings.getByText('Notifications are disabled on this device. You can enable them here later.', { exact: true }).waitFor();
      await tab.evaluate(() => window.fixturePermission('denied'));
      await settings.getByText('Notifications are blocked for this app. Allow them in your browser or device settings, then return here.', { exact: true }).waitFor();
      if (!await toggle.isDisabled()) throw new Error('Blocked notification toggle must be disabled');
      await shot(`notification-blocked-${width}`);
      await settings.getByRole('button', { name: /^Integrations/ }).click();
      const integrations = tab.getByRole('dialog', { name: 'Integrations', exact: true });
      await integrations.getByRole('heading', { name: 'Apple Calendar & Reminders', exact: true }).scrollIntoViewIfNeeded();
      await shot(`apple-handoff-${width}`);
      await integrations.getByRole('button', { name: 'Close integrations', exact: true }).click();
    }
    return { paths, simulatedPush: true, realPermissionOrDelivery: false };
  } catch (error) {
    await tab.screenshot({ path: `${outputDir}/capture-failure.png` }).catch(() => {}); throw error;
  } finally {
    if (initialPreferences) await context.request.patch(`${origin}/api/preferences`, { data: initialPreferences });
    await context.close();
  }
}
