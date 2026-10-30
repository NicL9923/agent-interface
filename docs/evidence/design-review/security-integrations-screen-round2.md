# Secure requests, saved logins and integrations: round 2 review

- Reviewer: Anthropic Claude Opus 5.5 (`claude-opus-5-5`). High effort was requested through the task options. The harness ran this session at an internal effort setting that does not map to a named level. That does not show a lower tier, and nothing here required stopping.
- Implementer: OpenAI GPT-6.1 Sol. The reviewer's provider is independent.
- Code state: `ae6fcdc4db39349bfa54f75c532d7d1d437871da`, draft PR #207. Scope: the product diff since `c98e165` in `VaultPanel.tsx`, `vault.css`, `IntegrationsPanel.tsx`, `integrations.css` and `IntegrationsView.swift`, plus the callers they rely on (`useAction`, `.actions`, `.checkbox-label`, `FormMessage`).
- Round: 2 of 3 for this combined area. Round 1 scored 7.8.

## Score

**8.8 / 10.** The bar is 9.

Every round 1 P1 and P2 is fixed, and most fixes are clean. The unlock form now reads as one task with one primary submit. Connection cards recommend the action that matches their status. Confirmations focus the safe choice and announce their question. The checkbox has a real name. Card text is now readable on a phone. Saved logins have a hierarchy and a source chip. The sign-in panel names the service and has a copy button with honest failure copy. Native picked up the same emphasis and an attention tint. Secret clearing, the uncertain-write lockout, ownership gating and exact-origin text are unchanged.

The remaining gap is small. The recommended button changes position from card to card. Web and native disagree on the color for problem states. One text-size inversion is left in saved logins. Fix P2 and the two observed P3 items and this area clears 9.

## Round 1 resolutions

| Round 1 finding | Status | Evidence |
| --- | --- | --- |
| P1 unlock form layout | Fixed | `vault-unlock-1440.png` (427–1013, 617–804): one full-width tinted form, one filled `Unlock source`, original `Unlock` hidden. At 390 the field spans the card. |
| P1 wrong primary on configured and unavailable | Fixed, with a new order issue (P2 below) | `connection-unverified-1440.png` Supabase (849–994, 786–830) and `connection-unavailable-1440.png` Cloudflare (550–695, 575–619) are filled `Check connection`. GitHub expired keeps filled `Reconnect`. Native matches in `connection-action-comparison.png`. |
| P2 confirmation focus | Fixed (code and tests, root Chromium run) | `VaultPanel.tsx:63-80`, `IntegrationsPanel.tsx:57-65`. Prompts are linked by `aria-describedby`. Cancel returns to the trigger, and a successful removal falls back to `Add login` or `Refresh status`. The screenshots don't show a focus ring. That is expected for programmatic focus after a pointer click, so I did not grade it. |
| P2 checkbox stacking and name | Fixed | `logins-1440.png` (812–924, 844): "Use 1Password" sits inline at 44px height. |
| P2 card text size | Fixed | `integrations.css:8-28`: metadata and chips are 13px, detail and buttons 14px, buttons 44px tall. Readable in `connection-unverified-390.png`. |
| P3 saved logins hierarchy | Mostly fixed | `h4` title, muted regular origin, source chip. One inversion remains (P3 below). |
| P3 sign-in panel | Fixed | `connection-signin-1440.png` (445, 335) "Finish connecting GitHub". `Cancel sign-in` (445–558, 434–477) aligns with the panel text. `Copy code` is next to the code. |
| P3 expired label and native tint | Fixed, with a cross-platform color mismatch (P3 below) | "Expired" on both platforms. Native uses `Palette.attention`. |
| P3 Reload logins width | Fixed | `vault-unlock-1440.png` (427–556, 915–958): compact and left-aligned. |
| P4 polish | Fixed | "Website address", an identifier label that follows the selected type (`login-editor-1440.png` (427, 759) "Email"), `aria-expanded` on Add login, autofocus on Label. |

## Prioritized remaining issues

### P2. The recommended connection action moves left and right between cards (observed)

- Evidence: `connection-unverified-1440.png`. GitHub's filled `Reconnect` sits on the left at (446–544, 811–855). Supabase's filled `Check connection` sits on the right at (849–994, 786–830). Cloudflare repeats the right-side placement in `connection-unavailable-1440.png` (550–695, 575–619). You see the same thing at 390. Native has it too. In `connection-action-comparison.png` (right side), the prominent `Check connection` sits between the text-style `Reconnect` and `Disconnect`.
- Why it matters: the rest of this area puts the filled action first: `Save login`, `Unlock source`, `Remove login`, `Disconnect` in confirmations. In a two-column grid, people scan for the filled button in one spot. Right now the filled button jumps around, which undercuts the round 1 fix.
- Cause: the render order is fixed as connect, then check. See `IntegrationsPanel.tsx:143-144` and `IntegrationsView.swift:260-273`.
- Fix: render the recommended action first. Pull the two buttons into a small ordered list driven by `recommendsCheck`, or swap them when the status is `configured` or `unavailable`. Do the same on native. `Disconnect` stays last on both platforms.

### P3. Web and native use different colors for problem states (observed, plus code)

- Evidence: on web, "Expired", "Unavailable" and "Permission needed" render in danger red. See `connection-unavailable-1440.png` (612–695, 413–435) and Synology at (866–994, 787–809). Native renders "Expired" in the amber `Palette.attention` (`connection-action-comparison.png`, right side, GitHub row).
- Cause: `integrations.css:15` uses `var(--danger)`. `IntegrationsView.swift:47-51` uses `Palette.attention`. Web already has `--attention: #9b6733` (`styles.css:23`).
- Fix: switch the web rule to `var(--attention)`. These states are recoverable, and "Unavailable" is often the provider's outage, not something the person broke. Red belongs to destructive verbs, as in the `Disconnect` and `Remove login` confirmations. Using amber here keeps that meaning intact.

### P3. In saved logins, the identifier renders larger than the entry title (observed)

- Evidence: `logins-1440.png`. "ranch@example.invalid" at (427, 593) is a 16px body paragraph. The `h4` title "Ranch supply account" at (427, 534) is 15px. The identifier looks like the headline. On Connections the matching account line is 13px ink (`integrations.css:17`). The same kind of data uses two sizes across the two tabs.
- Cause: `VaultPanel.tsx:109` renders `<p>{item.identifier}</p>` with no size. Only `.vault-origin` was sized (`vault.css:20`).
- Fix: give the identifier a class at 0.875rem in ink. Set `.integration-account` to the same 0.875rem so both tabs match. Title, then identifier, then muted origin is the order native already uses.

### P3. After a vault action, focus can land far from its result (code only, not captured)

- Successful unlock: the `Unlock` trigger unmounts once the source is unlocked, so `VaultPanel.tsx:71-75` falls back to `Reload logins` at the bottom of the panel. The success notice renders at the top (`VaultPanel.tsx:90`). Focus that source's `Lock` button instead. It sits in the same row and confirms the new state.
- Failed save, unlock or remove: `mutate` sets `uncertain`, which disables the focused submit. Focus drops to `<body>`, and the explanation renders at the top of the panel. On a phone you are scrolled down to the unlock form, so you see grayed fields and no reason. `FormMessage` announces it to screen readers, but sighted users don't get the same cue. When `uncertain` turns true, move focus to `Reload logins`, the recovery step the message names. Scrolling the error into view also works. The remove path is already covered, because `Keep login` stays enabled and gets focus.
- I did not see either state in a capture, so treat this as a code reading, not an observed defect.

### P4. Small polish (observed)

- Extra space below action rows. `.actions { margin: 18px 0 }` (`styles.css:666-672`) adds about 18px under the last buttons in every connection card (`connection-disconnect-confirm-390.png` (32–358, 515–550)) and inside the unlock form (`vault-unlock-1440.png` (427–1013, 772–804)). Set `margin-bottom: 0` for `.integration-card .actions` and `.vault-unlock-form .actions`.
- At 390, the "Hermes vault" chip sits between the title and the origin (`logins-390.png` (31–123, 590–612)). The cause is the column rule at `vault.css:19`. Keep `.vault-entry-heading` as a wrapping row so the chip stays beside the title or wraps after it.
- Inline confirmation prompts look like entry metadata. "Remove Ranch supply account from Hermes?" at `login-remove-confirm-1440.png` (427, 562) has the same size and color as the identifier above it. A light `var(--rail)` background, like the one on the unlock form, would mark it as a pending decision. This is optional. The danger and safe buttons already make the state clear.
- On a 1440 two-column card, a connected card's three buttons wrap so `Disconnect` sits alone on a second row (`connections-1440.png` (446–548, 666–710)). It is acceptable as is. Fixing P2 makes the wrap less noticeable.

## What works and should stay

- One primary per form, and the status-driven recommendation logic on both platforms.
- Focus handling for Add, Unlock, Remove and Disconnect. Real tests back it (`tests/vault-ui.test.ts`, `tests/integrations-ui.test.ts`).
- Copy-code failure copy: "Select and copy it instead." It is honest, and it tells you what to do next.
- A restored flow with only a `flowId` still shows the generic "Finish connecting your account", so it doesn't claim a service it doesn't know.
- The unlock form clears the master password on cancel, on hide and before every write.

## Coverage

- Observed on web at 1440 and 390: Logins, the add form top and bottom, 1Password unlock, the remove confirmation, Connections, configured Supabase, unavailable Cloudflare, the disconnect confirmation, expired GitHub, and the GitHub device-code sign-in. I reused the round 1 secure request captures because that UI did not change.
- Observed on native: the new Connections screen and the before and after comparison. I reused the round 1 native Logins capture.
- Code only: focus paths, copy feedback, and the uncertain-write focus loss.
- Not observed, so not graded: the copy-code notice and error as rendered, a real clipboard, native secure card, forms and dialogs, VoiceOver, dark mode, large text, the custom MCP and setup-field forms, empty and error states, and real provider sign-in.
