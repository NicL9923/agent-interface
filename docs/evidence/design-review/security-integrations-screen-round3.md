# Secure requests, saved logins and integrations: round 3 review

- Reviewer: Anthropic Claude Opus 5.5 (`claude-opus-5-5`). High effort was requested through the task options. The harness ran this session at an internal effort setting that does not map to a named level. That does not show a lower tier, and nothing here required stopping.
- Implementer: OpenAI GPT-6.1 Sol. The reviewer's provider is independent.
- Code state: `a25208605b3ec66b1dd481e2d180846077a7f7e5`, draft PR #207. Scope: the diff since `ae6fcdc` in `IntegrationsPanel.tsx`, `integrations.css`, `VaultPanel.tsx`, `vault.css`, `IntegrationsView.swift` and the two UI test files, plus the code they call (`FormMessage`, `.actions`, the color tokens in `styles.css`).
- Round: 3 of 3, the final round for this combined area. Round 1 scored 7.8 and round 2 scored 8.8. Anything below is a recorded leftover, not a gate.

## Score

**9.1 / 10.** The bar is 9.

Every round 2 item is fixed, and I can see each fix in the current captures. The filled action now comes first on every connection card on both platforms. Problem states use amber instead of red. Saved logins read title, identifier, then muted origin. Recovery after a failed vault write is now visible. The error sits near the top of the panel, and `Reload logins` sits in the same toolbar and takes focus. A successful unlock lands on that source's `Lock` button, and locking lands back on `Unlock`. The secret-clearing, uncertain-write lockout, ownership and exact-origin behavior did not change.

One leftover is a real accessibility miss that the amber fix introduced. The amber status text on its gray chip measures about 4.1:1, under the 4.5:1 that WCAG AA asks for at 13px. The card's own sentence carries the same meaning, so nobody loses information, but it should be fixed. It is a one-token change. The rest is layout polish and code tidiness.

## Round 2 resolutions

| Round 2 finding | Status | Evidence |
| --- | --- | --- |
| P2 recommended action moves between cards | Fixed | `connection-unverified-1440.png`: GitHub's filled `Reconnect` and Supabase's filled `Check connection` both lead their rows, at about x 446–544 and x 745–890 in the lower card row. Cloudflare in `connection-unavailable-1440.png` leads with `Check connection`. At 390 every card leads with the filled button. Native: `connection-order-comparison.png` right side, filled `Check connection` sits above `Reconnect` and `Disconnect`. `IntegrationsPanel.tsx:143-145` and `IntegrationsView.swift:260-274` drive the order from status. `Disconnect` stays last. A new test in `tests/integrations-ui.test.ts` checks the first button and that it calls the right endpoint. |
| P3 web and native problem colors differ | Fixed, with a contrast regression (P2 below) | `integrations.css:15` now uses `var(--attention)`. "Expired", "Unavailable" and "Permission needed" render amber on web, which matches native. |
| P3 identifier larger than the title | Fixed | `logins-390.png`: title "Ranch supply account" at about y 563 in bold 15px, identifier at y 591 in 14px ink, origin below it in muted 14px. `vault.css:42` and `integrations.css:17` both use 0.875rem now, so the two tabs match. |
| P3 focus lands far from the result | Fixed and observed | Failed unlock: `vault-unlock-error-1440.png` shows the error box at (427–1012, 467–533) and the enabled `Reload logins` at (885–1012, 237–279). `Add login` and `Remove…` are visibly disabled. At 390 both fit in the first screen: Reload at (144–272, 222–264), error at (31–358, 495–580). Reload is linked to the error through `aria-describedby` (`VaultPanel.tsx:99`). Successful unlock: `vault-unlocked-1440.png` shows the notice at (427–1012, 393–439) and `Lock` at (950–1012, 821–863), both on screen. The code is `VaultPanel.tsx:69-88`. |
| P4 extra space under action rows | Fixed | `integrations.css:48`, `vault.css:43`. The space under card buttons and under the unlock form now matches the card padding. |
| P4 chip forced into a column at 390 | Fixed | `logins-390.png`: "Hermes vault" sits beside the title at about (267–358, 552–574). |
| P4 confirmations look like metadata | Fixed | `login-remove-confirm-1440.png` (427–1012, 616–716) and `connection-disconnect-confirm-390.png` show the prompt in a tinted box with the danger and safe buttons inside it. |
| P4 lone `Disconnect` on a second row at 1440 | Unchanged, and now joined by a related case (P3 below) | `connections-1440.png` (446–548, 668–710). |

## Recorded leftovers

### P2. Amber status text fails AA contrast on its chip (observed, plus token math)

- Evidence: "Expired" in `connection-expired-1440.png` at about (634–695, 640–662), "Unavailable" in `connection-unavailable-390.png` at about (257–340, 516–538), and "Permission needed" in `connection-unavailable-1440.png` at about (865–994, 780–802).
- Measurement: `--attention` `#9b6733` on the chip's `--rail` `#eeeee6` is about 4.1:1. The chip text is 13px regular, so it needs 4.5:1. The old `--danger` `#a33c32` was about 5.5:1, so this is a regression from the round 2 fix. Native is fine. It draws the same amber on a white card with no chip fill, which is about 4.8:1.
- Fix: darken the light-mode attention color used for text. `#8a5a2b` is about 5.0:1 on `#eeeee6` and stays in the same hue. Check the other light-mode text uses at `styles.css:305` and `:319` at the same time. Or add a `--attention-text` token if the fills at `home.css:60` and `:385` should keep the current shade. The dark value `#ebc188` on `#151c18` already passes.
- Related, found now, missed in rounds 1 and 2: the muted gray chips, such as "Configured · not checked" and "Hermes vault", are `--muted` `#697268` on `--rail`. That is about 4.3:1, also a little short. That fix belongs to the shared chip or the muted token, not to this area alone, so I am logging it rather than counting it here.

### P3. Connection cards on desktop are narrower than on a phone (observed)

- Evidence: in the 1440 settings dialog the two-column grid gives each card about 286px. On a 390 phone the card is about 328px. On desktop the three buttons on a connected card wrap, leaving `Disconnect` alone on a second row (`connections-1440.png` at 446–548, 668–710). Now the disconnect confirmation stacks `Disconnect` at (458–560, 534–578) above `Keep connected` at (458–593, 584–628) in `connection-disconnect-confirm-1440.png`. The same buttons sit side by side on the phone. When a category has only one card, as with Accounts & productivity, the right column stays empty.
- Cause: `integrations.css:9` fixes `repeat(2, minmax(0, 1fr))`. Line 40 switches to one column only by viewport width, so it cannot see that the settings dialog is narrow.
- Fix: `grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr))`. The settings dialog then gets one roomy column, and the wider standalone `.integrations-panel` (up to 820px) still gets two. The viewport media rule can go.

### P4. Small code tidiness (code only)

- The web recommendation rule is spelled out three times: `["configured", "unavailable"]` at `IntegrationsPanel.tsx:143` and `:145`, and the connect list at `:144`. Native names it once as `recommendsCheck` and `recommendsConnect` (`IntegrationsView.swift:46`). A small `recommends(item)` helper on web would keep order and emphasis from drifting apart. That drift is the exact bug round 2 found.
- Both stylesheets add override rules at the end instead of editing the originals: `.integration-card .actions` at `integrations.css:27` and `:48`, `.integration-confirmation` at `:36` and `:49`, `.vault-entry-heading` at `vault.css:2` and `:40`, and the entry `h4` at `vault.css:23` and `:41`. Folding each pair into one rule makes the next change less likely to edit the losing copy.
- "Use 1Password" is 13px next to the larger `Unlock` and `Lock` buttons in the same row (`vault-unlocked-390.png` at about 31–214, 690–733). It reads as fine print next to a control of equal importance. Use 0.875rem to match the other labels.

## What works and should stay

- Status-driven order and emphasis, with `Disconnect` always last and always secondary, on both platforms.
- The toolbar placement of `Reload logins`. It puts the recovery action next to where the error appears and makes the focus move short.
- Focus moves after success, and in the uncertain-write path, back up by the new unlock, lock and failure tests in `tests/vault-ui.test.ts`. The failure test also confirms the secret is cleared, never echoed, and a second submit does not retry.
- Tinted confirmation boxes. The danger button stays outlined red, so destruction still reads differently from recovery.

## Coverage

- Observed on web at 1440 and 390, from the round 3 captures: Logins, the add form top and bottom, 1Password unlock, the failed unlock, the unlocked source, the remove confirmation, Connections, configured Supabase, unavailable Cloudflare, the disconnect confirmation, expired GitHub, and the GitHub device-code sign-in.
- Observed on native: the round 3 Connections screen and the before and after order comparison. I reused the round 1 native Logins and web secure request captures, because that code did not change.
- Code only: lock-to-`Unlock` focus, focus after Reload, and the web recommendation helper and duplicate CSS notes. Programmatic focus after a pointer click shows no ring in the captures, which is expected, so I did not grade ring visibility.
- Not observed, so not graded: a real clipboard, provider sign-in, native forms and dialogs, VoiceOver, dark mode, large text, the custom MCP and setup-field forms, and empty states. All secret values in the captures are synthetic and masked.
