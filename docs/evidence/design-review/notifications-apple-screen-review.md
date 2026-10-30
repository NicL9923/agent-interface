# Notifications and Apple devices: whole-area review, round 1

Reviewer: Claude Opus 5.5, Anthropic, with high effort requested. OpenAI implemented
the UI. Round 1 of at most 3. The score covers the whole area, not single frames.
Reviewed at HEAD `72dbb90` on `nic/full-app-design-review`.

## Score: 7.5 / 10, not yet passing (bar 9)

The parts that protect people are good. iOS and the browser ask for permission only
after an explicit Enable tap. Late results can't change another account's choice.
Turning notifications off keeps the switch on if the server might still deliver.
The Apple screen says plainly that nothing leaves the phone until you send it, and
sharing adds to a draft instead of sending.

The score is held down by how the settings read, not by how they behave:

- A blocked device looks almost the same as one the user turned off.
- One card mixes a per-device switch with account-wide settings and never says
  which is which.
- The explanatory copy repeats itself in one spot and is missing in another.
- On native, the obvious Apple card in Integrations is a dead end. The working entry
  sits at the bottom of the page.

Web coordinates are CSS pixels in the 1440×1000 and 390×844 frames. Native
coordinates are full-resolution pixels in the 1206×2622 frames. **[px]** means seen
in pixels. **[src]** means found in source only and not verified at runtime.

## Issues, most important first

### P1

1. **Blocked looks like off.** [px] [src]
   - `notification-blocked-1440.png`: the switch at x 811-861, y 178-208 says
     "Disabled" (x 872-925, y 192), the same word as `notification-disabled-1440.png`.
     The only difference is a fade. The track is `#eeefe6` blocked and `#d9ded2` off,
     on a `#fffdf7` card, so the blocked switch nearly disappears. The 390 frame
     matches at x 237-288, y 118-148.
   - The recovery text at y 229-247 is right ("Allow them in your browser or device
     settings, then return here."), but it is small muted body text. Nothing marks
     this row as needing attention.
   - "Disabled" next to a disabled control can mean either "notifications are off"
     or "you can't use this switch". Blocked is the one state where both are true.
   - Source: `src/components/DeviceNotifications.tsx:16` always picks between
     "Enabled" and "Disabled". `device-notifications.css:9` only sets
     `opacity: 0.65`. Native uses the same words at
     `ios/AgentInterface/DeviceNotifications.swift:85`.
   - *Fix:* Use "On" and "Off" for the user's choice, and "Blocked" when permission
     is denied. In the blocked state, give the message the attention tone and a
     small warning icon, the way other recovery rows in the app do. Native already
     adds "Open iOS Settings" (`DeviceNotifications.swift:96`). Web can't deep-link,
     so keep the text and make it stand out.

2. **Native: the Apple card in Integrations is a dead end, and the real entry is at
   the bottom.** [src]
   - The server always sends an `apple` card with status `unsupported`, no actions,
     and the detail "Use the iOS app to choose calendars or reminder lists on this
     iPhone and share a snapshot with a bot. The server has no Apple account grant."
     (`src/hermes/integrations.py:583`).
   - Native renders every catalog card in its category (`IntegrationsView.swift:161-168`),
     so iPhone users see "Setup needed" under "On your devices". The card tells them
     to use the iOS app, which they are already in, and offers no button
     (`IntegrationsView.swift:239-268`).
   - The working `NavigationLink` to `AppleDeviceConnectionsView` is a separate section
     after "Add custom MCP connection" (`IntegrationsView.swift:174-178`), the last
     thing on a long page.
   - I can't see this in the captures, because the Apple view was opened directly.
     The brief says normal navigation goes through Integrations, so this is the path
     real users take.
   - *Fix:* In `connectionRow`, when `connection.id == "apple"`, render the row as a
     `NavigationLink` to `AppleDeviceConnectionsView` with the label "Choose and share
     from this iPhone". Then drop the bottom section, or filter the server card on
     native and move the bottom link into the "On your devices" section.

### P2

3. **Device-only and account-wide settings share one card with no scope cue.** [px] [src]
   - `notification-disabled-1440.png`: "This device" (y 192) is per device. Batching
     (y 336), Following (y 383) and Quiet hours (y 448) are account preferences saved
     to the server (`PreferencesDialog.tsx:47-48`, `:135-150`). They apply on every
     device.
   - The only scope sentence is "This setting applies to your account on this
     device." (y 271). It sits above the account rows, so it reads as if it covers
     them too.
   - With the device off or blocked, the account rows stay fully active. That is
     correct, since they still govern your other devices, but nothing says so.
   - Native has the same structure: `PreferencesView.swift:74-94`.
   - *Fix:* Split into two groups. "This device" holds the switch and its status.
     "All your devices" holds Batching, Following and Quiet hours, with the footnote
     "These apply wherever you get notifications." Delete the per-row scope
     sentence, since the group heading now carries it.

4. **The enabled state says the same thing twice.** [px] [src]
   - `notification-enabled-1440.png` y 232: "Notifications are enabled for your
     account on this device." Then y 257: "This setting applies to your account on
     this device." The 390 frame repeats it at y 170 and y 193. Quiet-hours frames
     have the same pair.
   - Source: the message at `use-device-notifications.ts:61` and `:120` plus the fixed
     note at `DeviceNotifications.tsx:23`. On native, the two are separate Form rows
     with their own dividers (`DeviceNotifications.swift:89`, `:97`).
     `native-Notifications.png` shows rows at y ≈642-734 and y ≈838-891 between
     dividers at y ≈593, 783 and 939. That gives about 350 px of chrome to two lines
     of help text.
   - *Fix:* Make the enabled message say what arrives: "You'll get alerts here for
     finished work and requests that need you." Remove the fixed note, which item 3's
     grouping replaces. On native, put the message in the toggle's label stack, or in
     a section footer.

5. **The iPhone install hint is shown to everyone and placed under Sign out.** [px] [src]
   - `notification-disabled-1440.png` x 515-878, y 757-776, and
     `notification-enabled-1440.png` y 742-761: "On iPhone, choose Share, then Add to
     Home Screen. Install before enabling notifications." It appears in desktop
     Chromium, after notifications are already enabled, and below the Sign out row,
     away from the switch it explains.
   - Source: unconditional at `PreferencesDialog.tsx:165`. The hook already returns
     a better, platform-detected message for iOS outside Home Screen mode
     (`use-device-notifications.ts:17-19`), and that message shows in the device row.
   - *Fix:* Delete line 165. If install help is still wanted for iPhone readers on
     desktop, put one line in the device group, shown only while notifications are
     off.

6. **The batching explanation exists only while quiet hours are on, and it starts
   with a time-zone ID.** [px] [src]
   - With quiet hours off (`notification-disabled-1440.png`, `-enabled-`), nothing
     explains Batching. The fact that matters most, that decisions and failures
     skip batching, is invisible. The server does exempt them
     (`src/server/store-notifications.ts:249-250`), so the promise is real.
   - With quiet hours on (`notification-quiet-hours-1440.png` x 515-915, y 581-617;
     390 y 532-575), one paragraph opens with the bare "America/Chicago." and then
     packs three rules into two sentences with a semicolon.
   - Source: `PreferencesDialog.tsx:152-154`. Native has the same text at
     `PreferencesView.swift:90-93`.
   - *Fix:* Give Batching a detail line that is always visible: "Decisions and
     failures still arrive right away." Make the quiet-hours footnote "Times are in
     America/Chicago. During quiet hours, alerts wait until the end, except security
     alerts."

7. **Native: Following sits under Until, and the quiet-hours footer reads as if it
   explains Following.** [px] [src]
   - `native-Notifications.png`: the order is Batching (y ≈1022), Quiet hours
     (y ≈1178), From, Until (y ≈1507-1598), then "Not following any assistants"
     (y ≈1703-1814). The quiet-hours footer comes after the Following row at
     y ≈1886-2011.
   - Web orders the rows Batching, Following, Quiet hours, with the footnote directly
     under Until.
   - Source: `PreferencesView.swift:89` puts `followRow` last in the section.
   - *Fix:* Move `followRow` above the Quiet hours toggle, matching web. If item 3
     lands, this ordering falls out of the new groups anyway.

8. **The Apple card on web says "Setup needed" forever, and production copy is weaker
   than the frame.** [px] [src]
   - `apple-handoff-1440.png`: "Setup needed" (x 597-695, y 491-514) and "Last
     checked: Not checked yet" (y 631). The server can never check this card, so
     both stay that way permanently, even after someone shares a snapshot every day.
     "Managed by: This iPhone" (x 446-514, y 583) is wrong when the reader is on a
     desktop browser. The card also leaves an empty band at the bottom where buttons
     would go (y 645-672; 390 frame y 597-627).
   - The frame's copy, "Open Integrations in the iPhone app to choose and share data
     from this device.", comes from the preview fixture
     (`.agents/tools/preview-app.mjs:239`). Production sends "Apple device calendars
     and reminders" and "…share a snapshot with a bot. The server has no Apple account
     grant." (`integrations.py:583`). The production text says "bot" where the product
     says "assistant", and it uses server jargon.
   - Source: `unsupported` maps to "Setup needed" (`IntegrationsPanel.tsx:19`).
   - *Fix:* Ship the fixture's name and detail from the server. Use owner "Your
     iPhone". For a card with no check action, show a neutral status such as "On
     iPhone" and hide "Last checked".

9. **Apple share: the button says "Share", the preview starts collapsed, and the
   confirmation doesn't restate what's in it.** [src]
   - `AppleDeviceConnectionsView.swift:147` labels the button "Share with Ranch hand".
     The action adds the snapshot to a draft (`:155-161`). The footer, the dialog
     and the notice are honest about this. The button is the one place that
     overstates it.
   - The item list is inside a collapsed `DisclosureGroup("Preview snapshot")`
     (`:139`), so someone can confirm after seeing only "12 events · 4 reminders".
     The confirmation message (`:164`) restates neither the counts nor the dates.
   - The reminder preview rows show the title and list but not the due date
     (`:144`), although the due date is shared (`:67`). Event rows omit the end time
     and the all-day flag (`:141`).
   - The window footer lists "selected list names" but not calendar names, which are
     also included (`:134`, `:57`).
   - *Fix:* Rename the button "Add to Ranch hand's draft…". Expand the preview by
     default when it has 20 items or fewer. Add the counts and date range to the
     confirmation message. Show due dates in the reminder rows. Say "calendar and
     list names".

### P3

10. **The invitation competes with a waiting decision.** [px]
    `notification-invitation-1440.png` shows three filled green buttons at once:
    Enable notifications (x 1141-1313, y 107-151), Approve (x 554-647, y 673-717) and
    Review (x 1183-1255, y 810-842). At 390, the banner takes y 82-245, about 19% of
    the screen, above the decision card. The timing makes sense, since a pending
    decision is a good reason to want alerts. The emphasis does not. *Fix:* Keep
    Enable filled but shorten the banner at 390 by moving "You can change this later
    in Settings > Notifications." onto the Not now path. Or tie the copy to the
    moment: "Get an alert next time a decision like this needs you."

11. **Web remembers the invitation per browser, not per account, and remembers it
    when shown rather than when answered.** [src]
    `use-device-notifications.ts:7-14`, `:85-88` with the global key at
    `src/app/storage.ts:63`. A second household member who signs in on the same
    browser never sees the invitation. A reload before answering also hides it for
    good. Native scopes the key to the account and records it only on Enable or Not
    now (`AgentInterfaceApp.swift:258-260`, `:297`, `:346-349`). *Fix:* Scope the
    web key by user ID, and call `rememberPrompt` in `enable` and `dismissPrompt`
    instead of on display.

12. **Quiet hours accept a zero-length window that the server rejects.** [src]
    The server requires `quietStart !== quietEnd` (`src/server/schemas.ts:81`). Web
    time inputs (`PreferencesDialog.tsx:146-149`) and native pickers
    (`PreferencesView.swift:86-87`) allow equal times. The save then fails through
    the app-level error handler (`src/app/use-session.ts:170`) and the field reverts.
    *Fix:* Under Until, show "Choose an end time different from the start." and skip
    the save while the times match.

13. **Native Apple screen uses the system gray background.** [px] [src]
    `native-Apple.png` is `#f2f2f7` at (30, 600) and (60, 1700). Settings is the
    household cream: `#faf8f2` at (30, 2000) in `native-Notifications.png`. The
    Form at `AppleDeviceConnectionsView.swift:152` lacks `.householdListBackground()`,
    which 27 other screens use. *Fix:* Add the modifier.

14. **Native Apple: "Include reminders with no due date" is live before reminders
    access.** [px] [src]
    `native-Apple.png` x ≈927-1114, y ≈2083-2162, directly under "Not allowed yet".
    The toggle does nothing until access is allowed (`AppleDeviceConnectionsView.swift:117`).
    *Fix:* Show it only when `reminderStatus == .fullAccess`, next to the list toggles.

## Strengths

- **Deliberate permission gestures.** Both platforms ask the OS only inside Enable.
  Web calls `requestPermission` before any other await, so the browser keeps the
  user gesture (`use-device-notifications.ts:101-102`). Native records this in its
  doc comment and its code (`AgentInterfaceApp.swift:292-307`).
- **Account and device ownership.** Every async step re-checks the account that
  started it. Native writes intent to a key captured up front
  (`DeviceNotifications.swift:37-40`). Web unsubscribes a subscription created for
  an account that has since signed out (`use-device-notifications.ts:115`).
- **Honest failure on disable.** A failed DELETE re-checks the server before
  reporting the device as off (`use-device-notifications.ts:155-162`). Native puts
  the intent back to on when the server may still deliver
  (`AgentInterfaceApp.swift:331-335`).
- **Blocked recovery refreshes itself.** Web re-checks on focus and visibility, so
  "return here" works without a reload. Native offers "Open iOS Settings".
- **The quiet-hours copy matches the server.** Security alerts bypass quiet hours
  (`src/server/notifications.ts:214-215`). Decisions and failures bypass batching
  (`store-notifications.ts:250`).
- **Apple privacy copy is the best on the screen.** "Hermes cannot read this phone
  while the app is closed. Nothing is shared until you send the snapshot in your
  conversation." (`native-Apple.png` y ≈969-1100) is specific and true. Nothing is
  selected by default. Changing a choice or returning to the app clears a stale
  snapshot (`AppleDeviceConnectionsView.swift:154`, `:173`). The snapshot file calls
  itself "a snapshot, not a live connection" and lists what it omits (`:23`).
- **Safe draft behavior.** The confirmation says existing draft text is kept and
  who can read the snapshot once sent (`:164`). The notice tells the user to open
  the conversation and send it themselves (`:161`).

## Coverage and gaps

- Pixels: all 12 web frames, `native-Notifications.png` and `native-Apple.png`, read
  at full size. I cropped the native header and the web blocked switch, and sampled
  colors with a stdlib PNG reader. I did not use `native-contact.png` or
  `capture-failure.png`.
- The web frames come from the agent's runs with a fake permission, service worker
  and subscription. No real push permission prompt or delivery took place.
- In `native-Notifications.png`, the "Notifications" section header is scrolled under
  the toolbar by the capture's scroll anchor (`PreferencesView.swift:128-130`). I
  have not scored this.
- Not seen: the native onboarding card, native blocked, native enabled, and the
  Following page on either platform. On the Apple screen, I did not see the date
  window controls, preview, share confirmation, the denied state, or anything after
  permission was granted. Items 2, 9, 11 and 12 are source-only.
- No VoiceOver, dark mode or large-text claims.
- Unverified question, not scored: the reminder filter uses
  `reminder.dueDateComponents?.date` (`AppleDeviceConnectionsView.swift:66-67`).
  `DateComponents.date` returns nil when the components carry no calendar. If
  EventKit leaves out the calendar for some reminders, dated reminders would be
  treated as undated. A device test with a real dated reminder would settle it.
  `Calendar.current.date(from:)` would be the defensive form.

## Suggested round-2 priorities

1. Item 1: "On", "Off" and "Blocked" status words, plus an attention tone for the
   blocked message. This is a small change in `DeviceNotifications.tsx` and
   `DeviceNotifications.swift`.
2. Item 2: make the native Apple card itself the entry point.
3. Items 3, 4 and 7 together: a "This device" group and an "All your devices"
   group, one status sentence, and the same row order on both platforms.
4. Items 5 and 6: delete the unconditional iPhone footnote, and give Batching a
   detail line that is always visible.
5. Items 8 and 9: the server card copy and status, plus the share button label,
   expanded preview and counts in the confirmation.
6. P3 items as time allows. Items 13 and 14 are one-line fixes.

A round-2 capture should add native blocked, the web Following page, and the Apple
screen scrolled to the date window. If a fixture permission can be granted, it
should also cover the Apple preview and its confirmation.

## Model, effort and commands

- Reviewer: Claude Opus 5.5 (`claude-opus-5-5`), Anthropic, high effort as
  requested. I did the review myself and started no subagents. This review is
  independent of the OpenAI implementation.
- Commands, all run in the foreground and all finished: `ls` and `sips` to list the
  frames and their sizes, `cat`, `sed` and `grep` to read source, `sips` to crop
  three regions into
  `/Volumes/DevSSD/scratch/wildbots-design-review/notifications-screen-r1-review/`,
  and `python3 -I` with a stdlib PNG sampler stored in that folder's `tools/`. One
  early command exited 1 only because `magick` and Pillow are not installed.
- No source edits, builds, tests, browser or native runs, commits, or external
  messages. The only file written in the repository is this one.
