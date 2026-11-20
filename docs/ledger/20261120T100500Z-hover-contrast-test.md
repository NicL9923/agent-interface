# November 20 hover contrast test

Code state: the working tree on top of `198e2e18` on `t3/research-openbot-chat-bubbles`. Node
v24.22.2. Hermes did not take part; the browser checks use the e2e server and its fixtures.

A fifth independent review found no blockers and one gap: the two hover contrast fixes in
`863fc5ce` had no automated check, and the cascade guard cannot see them, because both cascades
give the same low-contrast colors. This adds one browser test per theme to
`e2e/accessibility.spec.ts`. It hovers the selected avatar preview state and a routine card in the
warning and running tones with the real pointer, and requires the text to keep 4.5:1 against the
fill behind it. The controls are bare elements with the components' classes, placed inside the open
assistant settings dialog, since the page behind a modal cannot be hovered. The test first checks a
value that only each component's own stylesheet sets, so a stylesheet that never loaded fails
there.

The review's nit about the layer guard's computer screen is fixed too: the screen now waits for the
peek's close button, so a peek that failed to open cannot pass unread.

## Checks

| Check                                                                       | Result                                                                                          | Evidence                                            |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Typecheck, lint, format check                                               | Compiled and passed                                                                             |                                                     |
| Build                                                                       | Built                                                                                           |                                                     |
| New test, both fixes in place, Chromium                                     | Runtime-exercised: 2 passed                                                                     | `.private/hover-contrast/green.log`                 |
| New test with `avatar-editor.css` as on `b180694a`                          | Failed as intended: selected avatar state 1.18:1 in light and 1.54:1 in dark                    | `.private/hover-contrast/red-avatar.log`            |
| New test with `routine-runs.css` as on `b180694a`                           | Failed as intended in light: warning routine card 3.83:1. Dark passed, as it did before the fix | `.private/hover-contrast/red-routine.log`           |
| Layer guard, "a chat with the assistant at the computer", 4 views, Chromium | Runtime-exercised: 4 passed with the added wait                                                 | `.private/hover-contrast/guard-computer-screen.log` |

Each stylesheet was put back from a saved copy and the app rebuilt before the green run;
`git status` showed only the two test files changed.

The first version of the test passed against both broken stylesheets. It read the colors while the
button was still easing toward its hover fill, so it saw the fill the button had left. The test now
turns transitions off before it hovers, as the stylesheet-order spec does, and the red runs above
are from that version.

## Not done

- The review's other nit: paging earlier history in measures each loaded row twice in the rail,
  once in the layout effect and once after the mutation observer invalidates those positions. It
  costs time, not correctness, and is left for a follow-up.
- WebKit, which cannot start on this host.
