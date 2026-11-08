# Notifications and Apple devices: whole-area review, round 2

Reviewer: Claude Opus 5.5, Anthropic, with high effort requested. OpenAI implemented
the UI, so this review is independent of it. This is round 2 of at most 3, and the
score covers the whole area. Reviewed at HEAD `51615f1` on
`nic/full-app-design-review`, diff `72dbb90..HEAD` plus direct callers and callees.

## Score: 8.7 / 10, close but below the 9 bar

All 14 round-1 items were addressed. Most are confirmed in pixels, and none of the
round-1 safeguards regressed. Blocked no longer looks like Off. Device and account
settings are now separate groups. Each state has one status sentence. The Apple
card no longer claims "Setup needed" forever. The Apple screen uses the household
background.

The remaining issues are small. One new state has a pixel collision at 390. The
Apple preview, which is the step where people check what they share, formats
dates clumsily. That part is source-only. A few copy and spacing details are also
left. The P2 fixes and items 3 and 4 below should reach 9 without new design work.

Web coordinates are CSS pixels in the 1440×1000 and 390×844 frames. Native
coordinates are full-resolution pixels in the 1206×2622 frames. **[px]** means seen
in pixels. **[src]** means found in source only and not verified at runtime.

## Round-1 items

| # | Round-1 issue | Round-2 result | Evidence |
| --- | --- | --- | --- |
| 1 | Blocked looks like Off | Fixed. "Blocked" in attention color with an outlined switch and an icon on the message. Text measures 4.71:1, `#9b6733` on `#fffdf7`, which passes AA | [px] web, native |
| 2 | Native Apple card is a dead end | Fixed. The catalog row is a `NavigationLink`, and the fallback link appears only without a catalog entry (`IntegrationsView.swift:175`, `:240`) | [src] |
| 3 | Device and account settings mixed | Fixed. "This device" and "All your devices" groups, with a scope footnote. See item 3 below for a naming nit | [px] |
| 4 | Enabled state repeats itself | Fixed. One status sentence | [px] |
| 5 | iPhone install hint shown to everyone | Fixed. See item 10 below for a side effect | [px] |
| 6 | Batching explained only during quiet hours | Fixed. The batching line is always visible, and the time-zone sentence reads well | [px] |
| 7 | Native Following under Until | Fixed. Order matches web | [px] |
| 8 | Web Apple card says "Setup needed" forever | Fixed. "On iPhone", "Your iPhone", no Last checked row and no empty action row. Spacing nit in item 9 | [px] |
| 9 | Apple share button, preview, confirmation | Button, initial expansion, counts and range are fixed. Date formatting is new, see item 2 | [src] |
| 10 | Invitation competes with a decision | Improved. The banner at 390 is y 82-206, 124 px or 15% of the screen, down from 163 px | [px] |
| 11 | Invitation remembered per browser and on display | Fixed. Scoped to the account and remembered on Enable or Not now | [src], tests reported |
| 12 | Equal quiet times hit the server | Fixed on web, with the layout issue in item 1. Native is source-only | [px] web, [src] native |
| 13 | Native Apple gray background | Fixed. `#faf8f2` at (30, 600) and (60, 1700) in `native-Apple.png` | [px] |
| 14 | Undated-reminder toggle before access | Fixed. Hidden before access in both native Apple frames | [px] |

## Remaining findings, most important first

### P2

1. **Web: the equal-time error collides with the focused field at 390 and sits
   inside the Until row.** [px] [src]
   - `notification-quiet-error-390.png`: the focus ring of the Until input spans
     x 260-358, y 605-650. The error line runs y 645-656 and ends at x ≈355, so the
     ring's lower-left corner crosses "start." at x 262-277, y 645-651. Crop:
     `notifications-screen-r2-review/quiet-error-390-crop-x4.png`. At 1440 they don't
     touch, with text at x 515-753 and ring at x 838-930, but the error still sits
     inside the Until cell at y 711-724 with no padding below it.
   - Cause: the error uses `settings-footnote` (`PreferencesDialog.tsx:162`). That
     class has `margin: -14px 16px 22px` (`home.css:345`) for footnotes *below* a
     group, so inside a group it pulls the text up into the row above. The batching
     footnote avoids this with its own override (`device-notifications.css:29`).
   - Copy: the same message, "Choose an end time different from the start.", also
     appears when the user edits From (`PreferencesDialog.tsx:50-53`,
     `PreferencesView.swift:220`).
   - The refused value is reverted. In the frame, Until shows `07:00` with the hour
     selected, so the reader sees the old time next to an error about a time they
     can no longer see. This is acceptable once the copy names the rule.
   - *Fix:* Give the error its own rule, `margin: 0; padding: 0 16px 12px`,
     matching the batching footnote. Use "Start and end times can't match." on
     both platforms. Add `aria-invalid` to the edited input and point its
     `aria-describedby` at the error. On native, use `Palette.danger` instead of
     `.red` (`PreferencesView.swift:95`), as the rest of the app does.

2. **Apple preview: dates repeat, and date-only reminders show a fake midnight.**
   [src]
   - `AppleDeviceConnectionsView.swift:145` formats each end of an event in full.
     A normal 30-minute event reads "Oct 30, 2026 at 9:00 AM to Oct 30, 2026 at
     9:30 AM". A single-day all-day event, which is the most common kind, reads
     "All day: Oct 30, 2026 to Oct 30, 2026". This is the review step before
     sharing, so it should be easy to scan.
   - `:148` shows "Due Oct 31, 2026 at 12:00 AM" for a reminder with only a date,
     because `dueDateComponents?.date` (`:67`) turns a date-only due into midnight.
     The shared JSON carries the same midnight, so an assistant could read it as a
     midnight deadline. This belongs with the issue206 coverage question and is not
     a confirmed regression.
   - `:141` and `:180` print "1 events" and "1 reminders".
   - *Fix:* Use `(event.start..<event.end).formatted(.interval.month().day().hour().minute())`,
     which drops the shared date, and show "All day, Oct 30" when an all-day event
     starts and ends on the same day. Store whether the due components include an
     hour, and show only the date when they don't. For counts, use
     `^[\(n) event](inflect: true)` in both strings.

### P3

3. **The group headings name the scope but not the subject.** [px] [src]
   - Web: "All your devices" (`PreferencesDialog.tsx:142`; blocked-1440 y 419) has
     the same style and level as "Notifications" (`:138`; y 265). Batching therefore
     reads as a new settings category instead of part of Notifications. The footnote
     at y 758 fixes this, but only after the rows.
   - Native: neither header mentions notifications. They are "This device"
     (`PreferencesView.swift:77`) and "All your devices" (`:97`; `native-Notifications.png`
     y ≈836).
   - *Fix:* Web: rename the second heading "Notifications on all your devices". It
     fits at 390. Native: rename `:77` to "Notifications" and `:97` to
     "Notifications on all your devices".

4. **Device status copy uses three phrasings and the old "disabled" wording.** [px] [src]
   - Off: "Enable notifications for completed work and requests that need your
     attention." (`use-device-notifications.ts:60`, `DeviceNotifications.swift:18`;
     disabled-1440 y 229-248). On: "You'll get alerts here for finished work and
     requests that need you." Invitation: "Get an alert when work finishes or an
     assistant needs you."
   - After a turn-off or a dismissed prompt: "Notifications are disabled on this
     device…" and "Notifications stay disabled…" (`use-device-notifications.ts:105`,
     `:151`, `DeviceNotifications.swift:22`). These appear next to a label that now
     says Off.
   - *Fix:* Off: "Turn on to get alerts here for finished work and requests that
     need you." After turn-off or Not now: "Off on this device. Turn on anytime."

5. **Native blocked message indents far past its row.** [px]
   `native-NotificationsBlocked.png`: the title, "Blocked" and "Open iOS Settings"
   start at x ≈97. The `Label` icon sits at x ≈105-157, y ≈596-655, and the message
   text starts at x ≈216, the width of a full Form icon column
   (`DeviceNotifications.swift:91`). Web keeps a tight 8 px gap. *Fix:*
   `HStack(alignment: .firstTextBaseline, spacing: 6) { Image(systemName:); Text }`.

6. **Native batching help takes a full Form row.** [px] `native-Notifications.png`
   dividers at y ≈1048 and ≈1205 frame one footnote line, about 157 px
   (`PreferencesView.swift:85`). This is the same chrome-for-help-text pattern as
   round-1 item 4. *Fix:* Put the line in the Picker's label as a caption, the way
   `followRow` carries its subtitle.

7. **The Apple intro says "conversation" where the button says "draft".** [px] [src]
   `native-Apple.png` y ≈707-891: "…then add it to Ranch hand's conversation."
   (`AppleDeviceConnectionsView.swift:99`). The button (`:151`) and the
   confirmation say draft, which is the accurate word. *Fix:* "…then add it to
   Ranch hand's draft."

8. **"Preview selected data" is disabled without a reason.** [px]
   `native-AppleDate.png` x ≈97-580, y ≈2257 shows gray text, and the footer below
   explains data scope but not why the button is off (`:132-137`). *Fix:* While no
   calendar or list is selected, add one footnote line: "Allow access and choose a
   calendar or list to preview."

9. **The web Apple card has extra space at the bottom.** [px] `apple-handoff-1440.png`
   card x 338-713, y 472-671: about 33 px below the Assistants row, against 18 px
   below Home Assistant's buttons (y 395 to 413). The 390 frame matches, 34 px
   against 18 px. Cause: the `dl` bottom margin plus card padding
   (`integrations.css:18`). The action row used to absorb this. *Fix:*
   `.integration-card > :last-child { margin-bottom: 0; }`.

10. **iPhone Safari readers lost their one-time install invitation.** [src]
    The prompt now requires `state.canEnable` (`use-device-notifications.ts:84-85`).
    Before this change, an iPhone Safari reader saw the invitation with "Add to Home
    Screen" guidance, because `Notification` is missing there and the old check let
    it through. With the Settings footnote gone too, as round 1 asked, install help
    now appears only in Settings. That is defensible, since the old invitation had a
    dead Enable button. It should be a deliberate choice, though. The
    `!notifications.canEnable` branch in `DeviceNotifications.tsx:32` is now
    unreachable. *Fix:* Accept it and delete the dead branch. Or, for the
    iPhone-install case only, show the invitation with the install sentence and a
    single "Got it" button.

Noted, not scored: on web, the device switch and the Quiet hours switch end at
different x positions, 897 and 925 in disabled-1440, because the device switch
carries its On, Off or Blocked word. The word is worth more than the alignment.

## Strengths

- **Blocked is clear.** The word, the color, the outlined switch and the icon all
  agree on both platforms. Native also offers "Open iOS Settings" in the same
  group. The attention color passes AA.
- **Scope is honest.** Account rows stay active when this device is off or blocked,
  which is correct because they govern other devices. The footnote "These apply
  wherever you get notifications." now says so.
- **Quiet-hours copy is short and true.** "Times are in America/Chicago. During
  quiet hours, alerts wait until the end, except security alerts." matches the
  server exemptions. "Decisions and failures skip batching." matches
  `store-notifications.ts`.
- **The invitation is fixed for accounts.** It is keyed by account, remembered only
  on an answer, and survives a reload. A second household member gets their own,
  and Enable is still the only path to `requestPermission`
  (`use-device-notifications.ts:93-100`). Settled ownership guards are intact,
  including the account checks after every await and the recheck on a failed
  DELETE.
- **The Apple handoff is unambiguous.** On web, "On iPhone" and "Your iPhone"
  state a fact instead of an unmet task. On native, the catalog row itself is the
  entry point, and the fallback link covers a missing catalog without duplicating
  the row.
- **Apple share safeguards improved.** The confirmation restates counts, the date
  range and who can read the snapshot. Small previews start expanded. Snapshots
  still clear on selection change and on return to the app. The window end
  correctly subtracts one second from the exclusive end (`:180`).

## Coverage and honest gaps

- Pixels: 12 of the 16 web frames read at full size: blocked, quiet-error,
  invitation, following and apple-handoff at both widths, plus disabled-1440 and
  enabled-390. I did not open disabled-390, enabled-1440 or the two quiet-hours
  frames, because blocked and quiet-error show the same quiet-hours layout. I also
  read the four native frames. I cropped the 390 quiet error and measured text contrast
  with a stdlib PNG reader. Native coordinates marked ≈ are scaled from a 920 px
  view by 1.31.
- Web frames use simulated permission, service worker and subscription. No real
  permission prompt or delivery.
- Source-only: the native catalog link, the whole Apple snapshot preview and
  confirmation, native equal-time validation, and items 2 and 10. No EventKit data
  was read, so the date formatting in item 2 and the issue206 question are
  unverified on a device.
- In both native Settings frames, the "This device" header is scrolled under the
  toolbar at y ≈338 by the capture anchor. I did not score it. The Apple frames
  lack Back navigation because of the direct Debug entry, which is also not scored.
- Not covered: VoiceOver, dark mode, large text, native XCTest, which is blocked by
  the CoreSimulator mismatch, and real push delivery.
- I did not rerun the reported 67 web and 11 Python checks.

## Round-3 priorities

1. Item 1: the error's spacing class, neutral copy, `aria-invalid`, and
   `Palette.danger`. Recapture `notification-quiet-error-390.png` with the field
   focused.
2. Item 2: interval formatting, date-only dues, and plural counts. If a fixture can
   supply a snapshot, capture the expanded preview and the confirmation.
3. Items 3 and 4: heading names and one vocabulary for device status.
4. Items 5-9 as one-line fixes. Item 10 needs a decision, not necessarily code.

## Model, effort and commands

- Reviewer: Claude Opus 5.5 (`claude-opus-5-5`), Anthropic, high effort as
  requested. I worked alone and started no subagents.
- Commands, all run in the foreground and all finished: `git diff` and `git show`
  for the round diff, `cat`, `sed` and `grep` to read source and tests, `sips` to
  list sizes and crop one region into
  `/Volumes/DevSSD/scratch/wildbots-design-review/notifications-screen-r2-review/`,
  and `python3 -I` with stdlib PNG samplers. One is the round-1 `sample.py`. The
  other, `darkest.py` for contrast, is in that folder's `tools/`.
- No source edits, builds, tests, browser or native runs, commits, or external
  messages. The only file written in the repository is this one.
