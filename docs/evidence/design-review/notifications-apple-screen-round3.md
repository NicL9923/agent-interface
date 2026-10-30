# Notifications and Apple devices: whole-area review, round 3, final

Reviewer: Claude Opus 5.5, Anthropic, with high effort requested. OpenAI implemented
the UI, so this review is independent of it. This is round 3 of 3 and the last.
The score covers the whole area. Reviewed at HEAD `86d7fca` on
`nic/full-app-design-review`, diff `51615f1..HEAD` plus direct callers and
callees, and the new production `ios/AgentInterface/AppleSnapshot.swift` in full.

## Score: 9.1 / 10, meets the 9 bar

Both round-2 P2 items are fixed. The quiet-hours error now has its own spacing
and clear copy, which I confirmed in pixels at both widths. The Apple snapshot
dates are correct in source and covered by standalone checks. Seven of the eight
P3 items are fixed. The headings, status wording, blocked message, Apple intro and
the reason for the disabled preview are confirmed in pixels. The iPhone Safari
item was settled by a decision, which I accept.

One new visual regression appears in pixels: the native batching picker. One
footer has awkward grammar. Three small code-only items remain. None of them
blocks the area, and none weakens a safety, account or permission protection.

Web coordinates are CSS pixels in the 1440×1000 and 390×844 frames. Native
coordinates are full-resolution pixels in the 1206×2622 frames. **[px]** means seen
in pixels. **[src]** means found in source only and not verified at runtime.

## Round-2 items

| # | Round-2 issue | Round-3 result | Evidence |
| --- | --- | --- | --- |
| 1 | Equal-time error collides with the focused field at 390 | Fixed. `.quiet-hours-error` has its own `margin: 0; padding: 12px 16px` (`device-notifications.css:32`). At 390 the Until focus ring ends at y ≈651 and the error starts at y ≈671, with clear space in between. At 1440 the ring ends at y ≈718, the error sits at y ≈743 and the group ends at y ≈766. Copy is "Start and end times can't match." on both platforms. Native uses `Palette.danger`. `aria-invalid` was not added, see item 4 below | [px] web, [src] native |
| 2 | Apple preview dates repeat, fake midnight, "1 events" | Fixed. See the data-boundary section below | [src], standalone checks reported |
| 3 | Headings name scope but not subject | Fixed. Web: "Notifications" and "Notifications on all your devices", which fit on one line at 390 (y 325). Native: "Notifications on all your devices" at y ≈836. The native "Notifications" header is still scrolled under the toolbar by the capture anchor, so I did not score it | [px] |
| 4 | Three phrasings and "disabled" | Fixed. Off says "Turn on to get alerts here for finished work and requests that need you." On says "You'll get alerts here…". The invitation says "Get alerts for finished work and requests that need you." After turning off: "Off on this device. Turn on anytime." One rare error string still names the wrong scope, see item 5 below | [px] disabled, enabled and invitation frames, [src] |
| 5 | Native blocked message over-indented | Fixed. The icon and text now sit in an `HStack` with 6 pt spacing. In `native-NotificationsBlocked.png` the icon starts at x ≈100, on the text column, and the message follows right after it. The icon is hidden from VoiceOver | [px] |
| 6 | Native batching help takes a full row | Fixed in structure, but the change introduced item 1 below | [px] |
| 7 | Apple intro says "conversation" | Fixed. It now reads "…then add it to Ranch hand's draft." (`native-Apple.png` y ≈730-805) | [px] |
| 8 | Disabled preview has no reason | Fixed. The footer says "Allow access and choose a calendar or list to preview." at y ≈2268 in `native-AppleDate.png` | [px] |
| 9 | Extra space at the bottom of the web Apple card | Fixed. The card's bottom border moved from y 671 to 663 at 1440. From the bottom of the last glyph to the border is now 29 px at both widths. That is 18 px of padding plus the row's line-height, which matches the Home Assistant card | [px] |
| 10 | iPhone Safari lost its install invitation | Settled by decision. The dead `!canEnable` branch is removed (`DeviceNotifications.tsx:31`). Install guidance stays in Settings (`use-device-notifications.ts:19`). That is the right call, because the invitation's only action would have been an Enable button that cannot work there | [src] |

## Remaining findings, most important first

All findings are P3. There are no P1 or P2 findings.

1. **Native: the batching value wraps under its label and sits off the text
   column.** [px] `native-Notifications.png`: "Batching" and its caption start at
   x 99, like every other row. "Every 5 minutes ⌃⌄" drops to its own line at
   y ≈1121 and starts at x 137, 38 px to the right of the column. Every other
   value in the group is right-aligned on the label's line: the Quiet hours
   switch and the From and Until pills. The web keeps the value on the label's
   line. The Picker label is a `VStack` with `.fixedSize(horizontal: false,
   vertical: true)` (`PreferencesView.swift:85-89`). It probably claims the full
   row width, which pushes the menu value onto the next line. *Fix:* Drop the
   `VStack` and `fixedSize`. Pass two `Text` views to the label, which iOS 17+
   renders as a title and subtitle with the value on the trailing side. Or use
   `LabeledContent` with the Picker as its content. Recapture the frame to
   confirm.

2. **Native Apple footer: a list with two "and"s and a stale hint.** [px] [src]
   `native-AppleDate.png` y ≈2333-2477: "Only event titles, times, reminder
   titles, due dates, and selected calendar and list names, and the snapshot time
   zone are included." That is hard to parse. Also, "Allow access and choose a
   calendar or list to preview." still shows after access is granted if nothing
   is selected (`AppleDeviceConnectionsView.swift:110`). And the footer never says
   that overdue reminders are left out. That is a deliberate data rule, so it
   should be stated. *Fix:* "Choose up to 90 days. The snapshot includes event
   titles and times, reminder titles and due dates, the selected calendar and list
   names, and your time zone. Completed reminders and reminders due before From
   are left out." Show "Choose a calendar or list to preview." when access
   exists, and the "Allow access" version only when it doesn't.

3. **Shared JSON: all-day `end` and `windowEnd` are exclusive, and the note
   doesn't say so.** [src] The note now explains `dueDate` well
   (`AppleSnapshot.swift:25`). A one-day all-day event still encodes as `start`
   `2026-10-31T00:00:00+11:00` and `end` `2026-11-01T00:00:00+11:00`. An
   assistant can read that as two days. `windowEnd` behaves the same way. The
   preview handles this correctly. The JSON is what the assistant actually reads,
   and the round-3 work closed the matching ambiguity for reminders. *Fix:*
   Mistake-proof it in the data. Add `startDate` and `lastDate` as `YYYY-MM-DD`
   to all-day events, and `lastDay` to the snapshot, mirroring `dueDate`. At a
   minimum, add "All-day event ends and windowEnd are exclusive." to the note.

4. **Web: the quiet-hours error isn't tied to its input.** [src] The error uses
   `role="alert"`, so it is announced once (`PreferencesDialog.tsx:162`). Neither
   time input gets `aria-invalid` or `aria-describedby`, unlike the section-name
   input in the same dialog (`:262`). A screen reader user who returns to Until
   won't hear why it was refused. *Fix:* Track which field failed. Set
   `aria-invalid` on that input and point its `aria-describedby` at an `id` on
   the error.

5. **A rare web error names the account instead of the device.**
   [src] `use-device-notifications.ts:148`: "Notifications are off for your
   account, but this browser couldn't remove its subscription." Only this
   device's registration was removed, and scope honesty is what rounds 1 and 2
   fixed. *Fix:* "Off on this device, but this browser kept its push
   subscription. Try again or use browser settings."

## Apple snapshot data boundary

I checked the production code against the brief. Each claim holds. [src]

- **Date-only reminders** get `dueDate` `YYYY-MM-DD` and `due` nil
  (`AppleSnapshot.swift:54-56`). The filter key is midnight in the capture zone,
  built from new Gregorian components, so any component time zone is ignored.
  No midnight is invented in the JSON or the preview (`:113-121`).
- **Timed reminders** convert with `components.timeZone ?? zone`. They clear the
  attached calendar and zone first, so a floating time cannot pick up the attached
  calendar's zone (`:58-62`). Components without a full date stay undated
  (`:51-53`).
- **The same key drives the filter and the payload** (`AppleDeviceConnectionsView.swift:34-36`).
  The window is half-open. Its end is Through plus one calendar day, which is
  DST-safe (`:104`, `AppleSnapshot.swift:65-67`). Undated reminders follow the
  toggle. Overdue reminders are not added, which matches the brief. Item 2 asks to
  say so in the UI.
- **Sorting is deterministic**: date first, then date-only before timed at the
  same key, then title, then list. Undated reminders come last (`:69-83`).
- **JSON** records `timeZone` and encodes every instant with its offset
  (`:27-39`). An unknown zone throws instead of silently falling back.
- **Preview, Refreshed time and confirmation** all use the frozen snapshot zone
  (`AppleDeviceConnectionsView.swift:117-123`, `:155`). The confirmation names
  the zone, the inflected counts, the range and who can read the snapshot.
- **Presentation**: `DateIntervalFormatter` collapses shared dates. A single-day
  all-day event reads "All day · Oct 31, 2026". The exclusive end and the 25-hour
  fall-back day resolve through `startOfDay` (`:98-112`).
- `AppleSnapshot.swift` imports only Foundation. Its types are `Sendable`, and
  the `@Sendable` EventKit callback captures only `Sendable` values. The project
  builds with Swift 6 and `SWIFT_STRICT_CONCURRENCY = complete`.
- I read `tests/apple-snapshot-checks.swift`. Its checks are specific and can
  fail: the Auckland date-only case, the UTC-calendar floating case, the Eastern
  explicit case, the Through boundary, Sydney offsets in the JSON, the fall-back
  day and the counts. The implementer's log ends with "checks passed". I did not
  rerun it.
- The updated `NativeContractTests` boundary test is equivalent to the old one.
  It did not run, because XCTest is blocked.

## Strengths and preserved protections

- **Quiet hours now explain themselves.** The error is short, names the rule,
  and has room at both widths. The refused value is still reverted locally and
  never reaches the server.
- **One vocabulary for device status.** On, Off, Blocked and the invitation all
  describe the same alerts in the same words on both platforms.
- **Scope is explicit in the headings.** "Notifications" and "Notifications on
  all your devices", plus the "These apply wherever…" footnote, leave no doubt
  about which rows affect other devices.
- **Blocked stays distinct.** It keeps the attention color, outlined switch, icon
  and "Open iOS Settings" on native. The icon now hugs its text.
- **The Apple share step is honest about time.** No fabricated midnights. The
  zone is stated, and the counts read naturally.
- **Protections unchanged in this diff:** account-keyed invitations, Enable as
  the only path to `requestPermission`, account checks after every await, the
  recheck on a failed DELETE, snapshot clearing on selection or scene change,
  the access-gated undated toggle, and the confirmation before anything joins a
  draft.

## Coverage and honest gaps

- **Seen in pixels:** I read these r3 frames at full size: quiet-error,
  invitation and apple-handoff at both widths, blocked-390, disabled at both
  widths, following-390, and all four native frames. I measured the
  quiet-error spacing, the Apple card's bottom spacing at both widths and the
  native batching alignment with a stdlib PNG scanner. I did not open
  blocked-1440, enabled at either width, following-1440 or quiet-hours at either
  width. The diff changes only copy and headings in those frames, and the frames
  I read show the same copy and headings.
- **Source only:** the whole Apple preview and confirmation, native quiet-hours
  validation and its error color, native catalog navigation, gestures, and items
  3-5.
- **Not verified:** no real EventKit data was read, so real reminder components
  and calendar sources are untested. That includes iCloud, Exchange and CalDAV
  date-only reminders, and floating versus zoned dues. Push permission, the
  service worker and subscriptions are simulated on web. There was no real
  permission prompt or delivery on any platform. VoiceOver, dark mode, large text
  and Dynamic Type are not covered. That matters most for item 1, where a larger
  caption changes the picker layout. Native XCTest did not run because of the
  CoreSimulator and Xcode mismatch.
- I did not rerun any tests or builds. The logs report 32 of 32 web tests
  passing, a completed web build, a native build with captures, and passing
  Apple snapshot checks.

## If anyone touches this area again

1. Item 1: the native batching picker layout, with a recapture.
2. Item 3: date-only fields for all-day events in the JSON.
3. Items 2, 4 and 5 are copy and attribute changes of a line or two each.

This is the final round. No follow-up review is planned.

## Model, effort and commands

- Reviewer: Claude Opus 5.5 (`claude-opus-5-5`), Anthropic. High effort was
  requested. The session does not show an effort setting I can confirm, which
  does not mean it ran lower. I worked alone and started no subagents.
- Commands, all run in the foreground and all finished: `git diff` for the round
  diff, `cat`, `sed`, `grep` and `tail` to read source, tests and the
  implementer's logs, `sips` to list frame sizes, and `python3 -I` with a stdlib
  PNG scanner. The scanner is adapted from the round-2 contrast helper and
  saved at
  `/Volumes/DevSSD/scratch/wildbots-design-review/notifications-screen-r3-review/tools/pngload.py`.
- No source edits, builds, tests, browser or simulator runs, commits, or
  external messages. The only file written in the repository is this one.
