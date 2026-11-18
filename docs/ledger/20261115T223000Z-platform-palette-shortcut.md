# November 15 platform palette shortcut in dev tools

Branch `t3/fix-platform-palette-shortcut` from `origin/main` at `92b3fadc`, source fingerprint
`sha256:5308a205b1863fcfd6311789e2a807259bd01ce8437be3d77b0871f62530e096` before this entry, Node 24.22.2 on
NicolasLaptop (Fedora, Linux x64), Chromium from the installed Playwright.

## Change

GPT-6.1 Sol's review of PR #355 found that `.agents/tools/diff-computed-styles.mjs` opened the command palette with
`Control+k`. The app's `matchCombo` takes Command on Apple platforms and rejects Control there, so on macOS the palette
never opened and the tool timed out. `capture-app-settings.js` had the reverse defect: `Meta+k` and `Meta+f` fail on
Linux and Windows. Both now read the browser's platform with the same test as `applePlatform()` in
`src/app/shortcuts.ts` and the e2e fix in 78ab235e (`e2e/stylesheet-order.spec.ts`), then press Meta on Apple
platforms and Control elsewhere. No other hardcoded modifier shortcut remains in `.agents/tools/` or `e2e/`.

## Runs

| Run                                                                               | Result                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run build && node .agents/tools/diff-computed-styles.mjs`                    | exit 0, all six screens read, no differences (light, dark, 900px, motion reduce)                                                                                                                                   |
| Red: the palette step forced to `Meta+k`, `SCHEMES=light`                         | exit 1, `locator.waitFor` timed out on `.command-palette[open]`; file restored                                                                                                                                     |
| `capture-app-settings.js` on `preview-app.mjs` (port 3299) through playwright-cli | exit 1 at line 35, before the changed key presses: no `Settings` button, since Settings moved into the Account menu. The platform read at the top ran. This drift predates the change and is left for its own fix. |

The tools have no unit tests, and none were added for a dev tool. The macOS branch is the same browser-platform test the
app and the e2e spec use, so it presses Meta wherever `matchCombo` requires Meta.
