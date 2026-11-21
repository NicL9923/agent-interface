# November 20 cascade layer order

Code state: the working tree on top of `d17ba687` on `t3/research-openbot-chat-bubbles`, which
includes origin/main `d6b53105`. Node v24.22.2. Hermes did not take part; the browser checks use
the e2e server and its fixtures.

## The defect

#457 wrapped every component stylesheet in `@layer components` and left the statement that ranks
the layers in `src/ui.css`. A cascade layer's rank is fixed where its name first appears. The
build links six component stylesheets ahead of the stylesheet that holds `ui.css`:

```
Avatar, main-assistant, reply-cards, MessageMarkdown, DeviceNotifications, collaboration, index, home, shell
```

So `components` appeared first and ranked under `base`, and the base `button` rule beat every
component's own button rules. On a build of origin/main `d6b53105`, a reply's action button, written
with `border: 0; padding: 0`, rendered with the base rule's 1 px border and padding. The message
rail's ticks drew as boxes for the same reason. The implementer of the chat review fixes found it
in the browser; this entry confirms it in the built files and fixes it.

Moving `import "./ui.css"` to the top of `src/main.tsx` was tried first. It put the statement at
the start of the index stylesheet (offset 66, ahead of the first components block at 34073), and
the new browser test still failed, because six component stylesheets load before that one. No
import order fixes the build. That attempt was reverted.

## The fix

`index.html` now ranks the layers in a `<style>` element in its head, ahead of the boot script and
every stylesheet. The content security policy already allows inline styles (`style-src 'self'
'unsafe-inline'` in `src/server/security-headers.ts`). `src/ui.css` keeps its own statement for the
pages that do not go through `index.html`, and a test holds the two to one order. In the built
page the statement sits at offset 1105 and the first stylesheet link at 4563.

## Checks

| Check                                                                    | Result                                                                                 | Evidence                                                        |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Typecheck                                                                | Compiled                                                                               |                                                                 |
| Lint                                                                     | Passed                                                                                 |                                                                 |
| Build                                                                    | Built                                                                                  |                                                                 |
| `tests/motion-css-order.test.ts`                                         | Unit-passed: 6 tests, 2 of them new                                                    |                                                                 |
| `e2e/stylesheet-order.spec.ts` and `e2e/accessibility.spec.ts`, Chromium | Runtime-exercised: 22 passed, with the new test among them                             | `.private/cascade-layer-order/e2e-stylesheet-accessibility.log` |
| New browser test on the build made before the fix                        | Failed as intended: the first layer rule was a `components` block, not the statement   | `.private/cascade-layer-order/red-e2e-old-build.log`            |
| New browser test on the build with the fix                               | Passed: the statement comes first, and a bare `.reply-action` button has a 0 px border | `.private/cascade-layer-order/green-e2e.log`                    |

The full battery runs on the commit that carries this fix and is recorded with the pull request.
WebKit was not run: this host lacks its system libraries, which fails the same way on origin/main.

### Red runs of the two new unit tests

Each line was broken by hand and restored from a saved copy; `git status` showed only the intended
changes afterwards.

| Break                                                        | Test that failed                                                  | Evidence                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| `index.html` as on `d17ba687`, with no statement             | both new tests                                                    | `.private/cascade-layer-order/red-no-statement-in-page.log`   |
| The `<style>` element moved after the boot script            | "is declared in the page before anything that loads a stylesheet" | `.private/cascade-layer-order/red-statement-after-script.log` |
| `ui.css` naming `theme, components, base, motion, utilities` | "is the order ui.css names"                                       | `.private/cascade-layer-order/red-ui-css-order.log`           |

## Not checked

- The dev server. The page's statement comes first there too, since the same `index.html` is
  served, but no browser read confirmed it.
- `native-computer.html`, `native-terminal.html` and the avatar specimen page. They do not go
  through `index.html`; none loads a base layer beside a components layer today.
- Every screen by eye. The fix restores the order `ui.css` always named, so component rules that
  lost to the base layer since #457 win again across the app.
