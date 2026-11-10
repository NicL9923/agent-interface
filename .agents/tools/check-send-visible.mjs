#!/usr/bin/env node
// Checks that Send and Stop stay whole and tappable above a phone's on-screen keyboard, in an assistant chat and a
// group chat, across phone sizes, keyboard heights and drafts. Chromium shows no keyboard, so the visual viewport
// is replaced with one this script shrinks, as Safari's does. Run against the loopback preview:
//   npm run build && node .agents/tools/preview-app.mjs   (another shell)
//   node .agents/tools/check-send-visible.mjs [http://127.0.0.1:3000] [report.json]
// Exits 1 when any case leaves the button outside the visible frame or covered.
import { writeFileSync } from 'node:fs';
import { chromium, devices } from '@playwright/test';

const [base = 'http://127.0.0.1:3000', report] = process.argv.slice(2);
// [width, height, visible frames with the keyboard up; null is no keyboard]
const views = [[375, 667, [null, 363]], [430, 932, [null, 548]], [667, 375, [null, 120]], [932, 430, [null, 190, 150]], [1280, 800, [null]]];
const long = Array.from({ length: 10 }, (_, line) => `Line ${line + 1} of the feed order`).join('\n');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const cases = [
  { chat: 'assistant', draft: '', button: 'Stop response' },
  { chat: 'assistant', draft: 'Feed the horses', button: /^Send (message|guidance)$/ },
  { chat: 'assistant', draft: long, button: /^Send (message|guidance)$/ },
  { chat: 'assistant', draft: long, attach: true, button: /^Send (message|guidance)$/ },
  { chat: 'group', draft: 'Plan Saturday', button: 'Send to group' },
  { chat: 'group', draft: long, button: 'Send to group' },
  { chat: 'group', draft: long, thread: true, button: 'Send to group' },
  // A send the server refuses shows an error above the conversation and a retry button in Send's place.
  { chat: 'group', draft: long, fail: true, button: 'Retry same saved message' },
];

const browser = await chromium.launch();
const rows = [];
for (const [width, height, frames] of views) for (const frame of frames) for (const item of cases) {
  const phone = width !== 1280;
  const context = await browser.newContext({ ...(phone ? devices['iPhone 15 Pro Max'] : {}), viewport: { width, height } });
  await context.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { height: innerHeight, width: innerWidth, scale: 1, pageTop: 0, pageLeft: 0, offsetTop: 0, offsetLeft: 0 });
    Object.defineProperty(window, 'visualViewport', { value: viewport });
    window.openKeyboard = visible => { viewport.height = visible; viewport.dispatchEvent(new Event('resize')); };
  });
  const page = await context.newPage();
  await page.goto(base);
  await page.getByRole('button', { name: item.chat === 'group' ? /Weekend at the ranch/ : /Ranch hand/ }).first().click();
  const field = page.locator(item.chat === 'group' ? '#group-message' : '#message');
  await field.waitFor();
  // A phone opens a chat with a view transition, which takes taps until it ends.
  await page.waitForTimeout(700);
  if (item.thread) await page.getByRole('button', { name: /Reply in thread/ }).last().click();
  if (item.attach) await page.locator('input[type="file"]').setInputFiles(Array.from({ length: 4 }, (_, index) => ({ name: `photo-${index}.png`, mimeType: 'image/png', buffer: png })));
  await field.focus();
  if (frame) await page.evaluate(visible => window.openKeyboard(visible), frame);
  await field.fill(item.draft);
  if (item.fail) {
    await page.route('**/groups/*/messages', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Hermes is unavailable."}' }) : route.fallback());
    await page.getByRole('button', { name: 'Send to group' }).click();
    await page.getByRole('button', { name: item.button }).waitFor();
  }
  await page.waitForTimeout(250);
  const seen = await page.getByRole('button', { name: item.button }).evaluate(button => {
    const box = button.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { top: Math.round(box.top), bottom: Math.round(box.bottom), tappable: !!hit && button.contains(hit),
      shellScrolled: document.querySelector('.app-shell').scrollTop };
  });
  const visible = frame ?? height;
  // After a failed send, the explanation must be readable too: with the panel scrolled to its top, the composer
  // must not lie over it. A landscape keyboard frame under 300 px cannot hold the explanation and a one-line
  // composer together, so there it is reported and not required; it shows once the keyboard closes.
  const note = !item.fail ? null : await page.locator('.group-panel [role="alert"]').evaluate(alert => {
    alert.closest('.group-panel').scrollTop = 0;
    const box = alert.getBoundingClientRect();
    const uncovered = [box.top + 2, (box.top + box.bottom) / 2, box.bottom - 2].every(y => alert.contains(document.elementFromPoint(box.left + box.width / 2, y)));
    return { top: Math.round(box.top), bottom: Math.round(box.bottom), uncovered };
  });
  const ok = seen.top >= 0 && seen.bottom <= visible && seen.tappable && seen.shellScrolled === 0 && (!note || note.uncovered || visible < 300);
  rows.push({ width, height, frame, chat: item.chat, draft: item.draft === long ? 'long' : item.draft ? 'short' : 'empty',
    attach: !!item.attach, thread: !!item.thread, failed: !!item.fail, button: String(item.button), ...seen, note, ok });
  await context.close();
}
await browser.close();
for (const row of rows) console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${row.width}x${row.height} frame=${row.frame ?? 'none'} ${row.chat} ${row.draft}${row.attach ? '+files' : ''}${row.thread ? '+thread' : ''}${row.failed ? '+failed send' : ''}: ${String(row.button)} at ${row.top}-${row.bottom}${row.note ? `, explanation at ${row.note.top}-${row.note.bottom}${row.note.uncovered ? '' : ' covered'}` : ''}`);
const failed = rows.filter(row => !row.ok).length;
console.log(`${rows.length - failed} of ${rows.length} cases keep the button whole and tappable.`);
if (report) writeFileSync(report, JSON.stringify(rows, null, 1));
process.exit(failed ? 1 : 0);
