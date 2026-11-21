# November 20 solid bubble while sending

Code state: the working tree on top of the merge of `t3/fix-cascade-fallout-message-rail` into
`t3/research-openbot-chat-bubbles`. Node v24.22.2. Hermes did not take part; the browser checks use
the e2e server and its fixtures.

An independent review of the iOS bubbles found that a message on its way is drawn at 66% opacity,
fill and text together. With the solid fill that mixes the fill toward the page while the text stays
white, which the reviewer computed at about 2.83:1 for a gray fill on the light surface. The web has
the same rule (`.message-sending` in `src/styles.css`), so it gets the same fix as the app: a solid
bubble stays whole while it sends, and the "Sending…" line under it carries the state. The tinted
bubble still fades. The rule sits beside the solid fill in `src/motion.css`.

## Checks

| Check                                                                                      | Result                                                                             | Evidence                                        |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------- |
| Typecheck, lint, format check                                                              | Compiled and passed                                                                |                                                 |
| Build                                                                                      | Built                                                                              |                                                 |
| New test in `e2e/accessibility.spec.ts` on the build made before the rule                  | Failed as intended: the solid bubble read `0.66`                                   | `.private/solid-sending/red-old-build.log`      |
| `accessibility`, `cascade-layers`, `phone-overlays` and `stylesheet-order` specs, Chromium | Runtime-exercised: 67 passed on the build with the rule and the merged layer fixes | `.private/solid-sending/green-merged-build.log` |

The cascade layer guard reads every screen with the layers as built and unwrapped. The new rule has
five classes and attributes against the base rule's one, so it wins either way, and the guard passed.

Text contrast inside the web bubbles was measured on the same build before this change, in light and
dark, tinted and solid: 44 pairs, lowest 4.91:1 for a link in a light reply bubble, quote text 5.25:1.

## Not checked

- WebKit, which cannot start on this host.
- The contrast of a sending solid bubble by measurement. The rule removes the fade, so its text has
  the settled bubble's ratio, 4.88:1 or better for the nine avatar colors.
