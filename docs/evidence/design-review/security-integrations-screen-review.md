# Secure requests, saved logins and integrations: round 1 review

- Reviewer: Anthropic Claude Opus 5.5 (`claude-opus-5-5`), requested at high effort. The harness ran this session at an internal effort setting that does not map to a named level. I don't take that as evidence of lower effort.
- Implementers: OpenAI Sol and Terra. The provider is independent.
- Code state: `c98e165be58c524570472c16b892e5296a4493c6`, draft PR #207.
- Round: 1 of 3 for this combined area.

## Score

**7.8 / 10.** The bar is 9.

The area is trustworthy and works. Secrets stay out of the conversation, fields clear, the uncertain-write path refuses blind retries, ownership gating is clear, and remove and disconnect both ask for confirmation. The secure request card is the strongest piece. Its copy is calm and specific, it has one clear primary action, and it reads well at both widths.

The score loses most of its points in the Logins source rows and on the Connections cards. Those places have layout breaks you can see at both widths, a wrong primary action on two connection states, inline confirmations that drop keyboard focus, and card text too small to read comfortably on a phone. None of these is a large rewrite. Fixing P1 and P2 should reach 9.

## Prioritized issues

### P1. The 1Password unlock form breaks the source row layout

- Evidence: `vault-unlock-1440.png` around (640–1015, 730–860). The master password form sits on the right inside the actions flex row. The original `Unlock` button stays visible at (701–780, 779–821), right next to the `Unlock source` button at (790–922, 814–856). The person sees two near-identical buttons. At 390 (`vault-unlock-390.png`) the password field is only about 230px wide, sitting under a stacked checkbox.
- Cause: `src/components/VaultPanel.tsx:91-96` renders the `<form>` as a sibling of the Enable and Unlock controls inside `.vault-source-actions`, which is a wrapping flex row (`vault.css:7`).
- Fix: Hide the `Unlock` button while `unlock === source.name`. Render the form as a full-width row under the source, either outside `.vault-source-actions` or with `flex-basis: 100%`. Give the submit `className="primary"`. Every other secret form in this area has a filled primary submit, and this one is the only exception (`VaultPanel.tsx:95`).

### P1. The connection card picks the wrong primary action for "Configured · not checked" and "Unavailable"

- Evidence: `connection-expired-1440.png` Supabase card (745–833, 790–830). The status reads "Configured · not checked" and the detail says "Run a check to verify access." The filled green button is still `Reconnect`, and `Check connection` is secondary. Cloudflare is "Unavailable" with "Check again when the service is available," and it gets the same rule.
- Cause: `src/components/IntegrationsPanel.tsx:124` makes connect primary whenever `status !== "connected"`.
- Fix: Make the primary action follow the status. `not_connected` and `unsupported` get Connect. `expired` and `missing_permission` get Reconnect. `configured` and `unavailable` get Check connection, so make connect secondary for them. The GitHub expired card at (446–534, 815–855) already shows the correct pattern. Native (`ios/AgentInterface/IntegrationsView.swift:254-259`) gives all three buttons equal weight. It needs the same status-driven emphasis. Consider `.borderedProminent` or the existing `.accentProminent` style on the recommended action.

### P2. Inline remove and disconnect confirmations drop keyboard focus

- Evidence: `src/components/VaultPanel.tsx:82-84`. Activating `Remove…` unmounts that button and mounts `Remove login` and `Keep login`. Nothing receives focus, so a keyboard or screen reader user lands on `<body>`. `Keep login` also unmounts itself without returning focus. `IntegrationsPanel.tsx:123-126` does the same for `Disconnect` and `Keep connected`.
- Visual result: `login-remove-confirm-*.png` looks correct, which is why this is invisible in screenshots.
- Fix: When the confirmation opens, focus the safe choice (`Keep login` or `Keep connected`). When it closes, return focus to the trigger. Give the prompt text `role="alert"` or reference it with `aria-describedby` so the question is announced. Native already uses `confirmationDialog` (`VaultViews.swift:258`, `IntegrationsView.swift:218`) and is fine. Your Routines pass restored editor focus. Apply the same rule here.

### P2. The "Enable" checkbox stacks above its label at every width

- Evidence: `logins-1440.png` (880–924, 825–866). The checkbox sits above the word "Enable" instead of beside it. You can see the same in `vault-unlock-390.png` and in `login-remove-confirm-1440.png` at (1120–1165, 790–832).
- Cause: the global `label` rule is `flex-direction: column` (`src/styles.css:140-146`). `VaultPanel.tsx:88` doesn't use the existing `.checkbox-label` class (`styles.css:892`), which `AdvancedRoutineFields.tsx:43` uses.
- Fix: Add `className="checkbox-label"` to that label. While you're there, use a clearer name than "Enable", such as "Use 1Password". As written, a screen reader announces "Enable, checkbox" with no source attached.

### P2. Connection card text is too small to read on a phone

- Evidence: `connections-390.png` and `connection-expired-390.png`. The Managed by, Assistants, and Last checked rows, the status chips, and the permission states render at 11px in muted gray. Detail copy and card buttons render at 12px.
- Cause: `src/components/integrations.css:13,16,18,26,28` (`0.6875rem` and `0.75rem`).
- Fix: Use 13px as the floor for metadata and status chips, 14px for detail text, and 14px for button labels. That matches `.muted` at `0.8125rem` and the settings content override at `styles.css:1035`. This is the densest information in the area, and it is also the smallest text in the settings dialog.

### P3. Saved logins hierarchy is flat

- Evidence: `logins-1440.png`. The section heading "Saved logins" (427, 478) and the item title "Ranch supply account" (427, 534) are both `h3` at the same size and weight. The origin line below them is bold too, so three weights compete. The source tag "Hermes vault" at (933, 534) is plain right-aligned text with no visual treatment.
- Cause: `VaultPanel.tsx:79-81`, `vault.css:10`.
- Fix: Render each entry title as `h4`, or lower it one step in size. Drop the origin to regular weight with muted color, which keeps exact-origin legibility through `overflow-wrap`. Render the source as a small chip like `.integration-status` so the two panels share a style. Native already orders this well with headline, footnote, and caption (`VaultViews.swift:214-217`).

### P3. The sign-in flow panel doesn't name the service and has a misaligned button

- Evidence: `connection-signin-1440.png` (427–1013, 307–490). The heading "Finish connecting your account" doesn't say which account. The person has to infer GitHub. `Cancel sign-in` at (457, 432) is indented 12px from the panel text at x=445.
- Cause: `IntegrationsPanel.tsx:106`. The `.integration-flow > button { margin: 12px 0 0 12px }` rule is at `integrations.css:31`.
- Fix: Track the connection that started the flow, since `act` already knows `id`, and title the panel "Finish connecting GitHub." Change the button margin to `12px 0 0`. Add a copy button next to the device code, because on a phone people switch apps to type it. Native already uses `.textSelection(.enabled)` at `IntegrationsView.swift:268`.

### P3. Expired status needs one name, and native needs a status color

- Evidence: on web, the GitHub card's chip says "Sign in again," the detail says "Your sign-in expired," and the button says "Reconnect." That is three phrasings for one state. On native (`native-Connections.png`, GitHub row), "Sign in again" renders in secondary gray, so it looks the same as "Configured · not checked."
- Cause: `IntegrationsPanel.tsx:19`, `IntegrationsView.swift:49`, and `IntegrationsView.swift:237`, which only colors `connected`.
- Fix: Change the status label to "Expired" on both platforms and keep `Reconnect` as the verb. On native, color expired, missing permission, and unavailable with the danger or attention tint, the same way web does at `integrations.css:15`.

### P3. Reload logins is a full-width button at the bottom

- Evidence: `login-remove-confirm-1440.png`, the right panel at (667–1253, 945–985). The grid parent stretches it to a 586px secondary bar. Connections puts "Refresh status" in a compact toolbar at the top.
- Fix: Move it into `.vault-heading` next to `Add login`, or give it `justify-self: start` (`VaultPanel.tsx:99`). Matching the Connections toolbar would make the two tabs read as one system.

### P4. Small polish

- `VaultPanel.tsx:70`: the label "Website origin" is developer vocabulary. The validation error already says "website address." Use "Website address" in both places.
- `VaultPanel.tsx:74`: after the person picks "Identifier type: Email," the field below still says "Username, email or phone." Label it from the selection, so "Email" shows "Email."
- `VaultPanel.tsx:55-58`: `Add login` toggles the form but has no `aria-expanded`. Moving focus to the Label field on open would also help on phones, where the form opens above the fold.
- `secure-request-390.png` (128–262, 580–615): the transcript's "Jump to latest" pill covers the privacy sentence "Fields clear when you submit or leave this screen." The pill belongs to the conversation layer, not this card. Note it only if the same card hides it after a scroll settles. Scrolling to the actions frame clears it.

## What works and should stay

- The secure request card has clear hierarchy, a single filled primary action, a `Website:` line for exact-origin trust, and calm reassurance copy. It holds up at both widths with no clipping.
- On the uncertain-write paths, `SecureRequestCard.tsx:51-67` and `VaultPanel.tsx:41-52` clear secrets, block resubmission, and point to a refresh. The copy is plain and actionable.
- Ownership gating at `SecureRequestCard.tsx:94` names who can answer the request.
- Remove and disconnect confirmations use the safe-default wording "Keep login" and "Keep connected," and the danger color goes only on the destructive verb.
- The add login form's validation guards and the exact-origin helper text are good.
- Native Logins uses sensible grouped sections, has a real confirmation dialog, and keeps Add login as a list row.

## Coverage

- Observed on web at 1440 and 390: the filled secure request and its actions, the Logins list, the add login form top and bottom, 1Password unlock, the remove confirmation, Connections, the expired GitHub card, and the device code sign-in.
- Observed on native: only the Logins and Connections landing screens.
- Read: the listed web and native sources, the global label, button, and type rules, and the vault UI test entry points.
- Not observed, so not graded as defects: the native secure request card, native add and edit, native unlock and dialogs, VoiceOver, dark mode, large text, real provider sign-in pages, the custom MCP form, the setup-field connect form, error and empty states, and the Bitwarden installed state. The focus finding comes from reading the code, not from a captured run.
