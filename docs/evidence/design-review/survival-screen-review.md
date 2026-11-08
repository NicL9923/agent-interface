# Empty, offline, shared draft and widget review, round 1

**Score: 8.3/10.** The target is 9, so this round does not pass.

- Reviewer: Claude Opus 5.5 (`claude-opus-5-5`), Anthropic. High reasoning effort was requested. I can't confirm the internal effort setting from inside the session, and nothing suggests it ran lower.
- Implementer: OpenAI, so this review comes from a different provider.
- Code state: `fe260336cf39f695da36c319b305de1b5b14e40a` on `nic/full-app-design-review`.
- Scope: one grouped area covering the empty assistant list, the empty conversation, offline reading and draft preservation, the shared-draft review form, the share extension (source only), and the widgets.
- Out of scope: empty states inside Today, Work, Memory and artifact panels, Notifications, the capture tooling, and the Debug wrapper around the widget captures.

## Evidence used

I inspected these at full resolution:

- Web, 1440 and 390 wide:
  - `empty-home`
  - `empty-chat`
  - `empty-chat-draft`
  - `offline-chat`
  - `reconnected-draft`
- iPhone, 1206 x 2622:
  - `native-Empty`
  - `native-ShareDraft`
  - `native-Widget`
  - `native-WidgetStale`
  - `native-WidgetEmpty`

I excluded `native-AppleDate.png` and `capture-failure.png`. `capture-failure.png` is byte-identical to `reconnected-draft-1440.png` (same MD5). That fits the explanation that only the selector failed, so it doesn't count as product evidence either way.

Coordinates are in pixels of the original file. Native coordinates use the 1206 x 2622 original. Items marked **seen** are visible in the captures. Items marked **code only** come from reading source and were not rendered.

## What works

- **Drafts survive going offline (seen).** A draft typed offline stays in the composer at both widths. Send is disabled while offline and comes back on reconnection with the same text.
  - Evidence: `offline-chat-1440` composer at 513-1263 x 862-985 and `reconnected-draft-1440` at the same place.
  - `use-draft.ts:296` always saves a local copy, keyed by user and assistant. The server save is skipped while offline.
- **The empty-conversation action fills the draft and never sends (seen).** It adds its text to an existing draft instead of replacing it. `empty-chat-draft-390` at 15-375 x 652-832 shows the earlier draft, a blank line, then the role text. Nothing sends until the person presses Send.
- **Offline decisions are honest (seen).** Approve and Decline are disabled while offline, and "Reconnect to Hermes to answer." explains why (`offline-chat-1440`, 554-760 x 494-568).
- **The share review form says what will happen (seen).** "Existing draft text and attachments are kept. Review before sending." (`native-ShareDraft`, about 97-1050 x 1330-1420). The code matches. `ShareCaptureView.swift:43` and `:57` only add to the draft. Account scope is checked before and after every await (`:35`, `:38`, `:48`, `:55`).
- **Stale widgets don't claim live work (seen).** Past 30 minutes, working and needs-approval rows read "Out of date" with a history symbol (`native-WidgetStale`, 795-1040 x 820-985).
  - Sign-out removes the widget snapshot.
  - During an outage, the snapshot is kept only for the same account (`WidgetSync.swift:25-33`).
- **The offline library is scoped and pruned (code only).**
  - It is keyed by origin and token digest.
  - It expires after 7 days and is excluded from backup.
  - It drops approvals, tool output and drafts (`OfflineLibrary.swift:24-55`, `:80-92`).

## Issues, in priority order

### 1. "Discard shared draft" deletes at once, one row below "Add to draft". Medium, safety (seen and code)

- **Seen.** Add is at about 98-356 x 1624-1683 in `native-ShareDraft`, and Discard is at 98-544 x 1782-1841. Both rows sit in the same grouped card.
- **Code.** `ShareCaptureView.swift:26` calls `ShareInbox.remove(capture)` and dismisses with no confirmation. That permanently deletes the person's edited text and any shared files from the App Group.
- **Fix.** Put Discard in its own `Section` and add a `.confirmationDialog` ("Discard this shared draft? The text and files you shared are deleted from this device."). "Later" already covers "not now".

### 2. On a phone, the offline stack covers almost half the screen with a button that can't work. Medium, usability (seen)

- **Seen.** In `offline-chat-390`, the offline panel (14-376 x 478-632), the decision bar (14-376 x 640-690) and the composer (14-376 x 700-832) fill about 355 of 844 px. The decision card above them is cut off mid-sentence at y 467.
- **Seen.** "Reconnect now" (`offline-chat-1440`, 527-634 x 716-747) is faint and disabled. It can do nothing while the device is offline.
- **Code.** `ConnectionPanel.tsx:57` renders the button with `disabled={busy || offline}`.
- **Fix.** When `offline` is set, skip the Reconnect button. The panel text already says it reconnects automatically. That leaves the title, one line of detail and "Connection details", and gives back about 45 px on the phone. Keep the button for the app-unavailable and Hermes cases, where it works.

### 3. The same moment is labeled both "Offline" and "Reconnecting". Medium-low, honesty and consistency (seen and code)

- **Seen.** The `offline-chat-1440` header reads "Offline" (95-138 x 32-48), and so does the panel title. The pinned avatar captions read "Reconnecting" (87-157 x 198-210 and 191-260 x 198-210), and the activity line reads "Ranch hand is reconnecting…" (595-770 x 236-252). The 390 capture matches at 82-256 x 220-236.
- **Code.**
  - `Avatar.tsx:64` maps `disconnected` to "Reconnecting".
  - `Conversation.tsx:68` maps it to "reconnecting".
  - Native `RootView.swift:98` shows "Reconnecting…" under the saved-copy banner even when `reachability.offline` is true.
- **Fix.** When the device is offline, use "Offline" for the avatar caption and "Ranch hand is offline" for the activity line. Native should drop "Reconnecting…" from the banner in the same case. The `offline` flag already reaches `Sidebar` and `Conversation`.

### 4. The first-run empty list reads like an infrastructure status. Medium-low, hierarchy and copy (seen)

- **Seen.** "No assistants are available from Hermes yet." is small, muted body text above the button:
  - `empty-home-390`: 65-325 x 158-174
  - `empty-home-1440`: 38-298 x 157-171
  - `native-Empty`: 111-1091 x 592-648, with the rest of the screen blank below it
- **Code.** `Sidebar.tsx:134` and `RootView.swift:499`.
- **Why it matters.** For a new household this is the first screen. "Available from Hermes yet" suggests waiting for something, while the real next step is to create one. The CTA itself is clear and well placed.
- **Fix.** Use a heading-weight line, "No assistants yet", plus one muted sentence saying what an assistant does for the household. Keep the existing button and `assistantSetupBlock` reason.
- **Capture limitation.** On desktop, the main pane in `empty-home-1440` shows Today items from assistants that the empty roster doesn't contain, such as "3 need you" and Ranch hand. Those come from the fixture's separate Today data, not a product state, so I didn't grade them. A real empty-home desktop capture would need Today in its own empty state.

### 5. The widget empty state tells a signed-in person to open the app. Medium-low, copy (seen)

- **Seen.** In `native-WidgetEmpty`, the medium widget says "Your assistants appear here after you open the app." (103-946 x 1195-1231).
- **Code.**
  - `WidgetViews.swift:220` shows "No assistants yet" only when a snapshot exists, which means the person is signed in and connected with zero assistants. Opening the app won't change that.
  - "Sign in to WildBots" (snapshot `nil`) shares the same caption. The caption fits that case.
- **Fix.** Choose the caption by case. For an empty snapshot, use "Create one in WildBots." For no snapshot, keep the current text.

### 6. Disabled "Add to draft" never says why. Medium-low, offline honesty (code only)

- **Code.** `ShareCaptureView.swift:25` disables Add when `!store.connected`, or when files are attached and uploads aren't supported. The form gives no reason, so offline it looks broken.
- **Fix.** Add a footnote under the button for each case. Offline: "Connect to add this. It stays saved here." Uploads unsupported: "This assistant can't receive files."

### 7. After "Add to draft", the person isn't taken to the draft. Medium-low, flow (code only, plausible)

- **Code.**
  - `ShareCaptureView.swift:37` calls `store.select(botId)`, and `:60` dismisses.
  - `RootView` keeps `destination` and `path` in local state and doesn't react to `selectedBotId` (`RootView.swift:225-238` and the `RootSheets` setup at `:256`).
  - On a phone that started on home or Today, the sheet closes with no visible result. That breaks the "Review before sending" promise from issue 1's form.
- **Fix.** Pass an `onAdded` closure from `RootSheets` that runs the same navigation as `go(.bot(id))`.

### 8. The stale widget footer drops the snapshot's age. Low, honesty (seen)

- **Seen.** In `native-WidgetStale`, both footers read "Open WildBots to refresh" (103-485 x 1203-1238 and 103-485 x 1779-1814). A 31-minute-old snapshot and a 3-day-old one look the same.
- **Code.** `WidgetViews.swift:235` replaces "As of" with the refresh prompt.
- **Fix.** Medium: "As of 2:15 PM · Open to refresh". Small: `Text(snapshot.generatedAt, style: .relative)` with the history symbol, since its width is tight.

### 9. Share extension rough edges. Low, code only

The system-hosted page was not rendered.

- `ShareViewController.swift:62` says "0 attachment(s) ready" for a shared webpage or text, which looks like a failure. Use "Ready to save" when `files` is empty, and pluralize properly otherwise.
- `:19` and `:81`: "Save draft" stays enabled while preparing and after a failure, and silently does nothing. Disable it until `prepare()` succeeds.
- `:63` and `:86-88`: files already written to `ShareInbox/<id>/` are removed only by Cancel. A failed prepare followed by a swipe-dismiss leaves shared photos or PDFs in the App Group. `ShareInbox.pending` (`ShareInbox.swift:26-34`) only prunes `.json` captures, so nothing else removes them. This is plausible: I haven't confirmed whether iOS calls Cancel on swipe-dismiss. Fix it by also deleting capture directories older than a day that have no matching JSON.

### 10. Small copy and accessibility items. Low

- **Seen.** "Let's discuss your role." (`empty-chat-1440`, 741-1020 x 345-377) is written as the person speaking to the assistant, but it appears as a heading addressed to the person, who may read "your role" as their own. "Start with Ranch hand's role" says what the button does. The source is `Conversation.tsx:216` and the matching native view.
- **Code only.** The share form's `TextEditor` (`ShareCaptureView.swift:19`) has no accessibility label, so VoiceOver announces a nameless text view. Add `.accessibilityLabel("Shared text")`.
- **Code only.** The widget glyph uses the brand green whenever an assistant has a portrait avatar or no color (`WidgetSync.swift:13`). The identical glyphs in the captures come from sample data with `color: nil` (`DebugSurvivalView.swift:11-13`), so I didn't grade the pixels. Real households with several portrait avatars will still see identical icons in the medium widget.

## Recommended fixes over the next two rounds

Round 2, small and in the visible flows:

1. Discard confirmation and its own section (issue 1).
2. Hide the Reconnect button when offline (issue 2).
3. "Offline" wording across avatar, activity and native banner (issue 3).
4. Empty-list heading and copy on web and native (issue 4).
5. Case-specific widget empty caption (issue 5).
6. Disabled-reason footnotes on the share form (issue 6).

Round 3:

1. Navigate after import (issue 7).
2. Stale footer age (issue 8).
3. Share extension copy, Save gating and orphan sweep (issue 9).
4. Items from issue 10.
5. Recapture empty-home desktop with an empty Today pane. If feasible, add a native capture of the saved-copy banner on cold start.

None of these needs backend data or a rewrite.

## Gaps, not graded as defects

These were not demonstrated:

- The system-hosted share extension page and a real incoming share or file import.
- Native cold-start reading from the offline library.
- Widgets in a real WidgetKit host: timelines, taps, Lock Screen and accessory families, the large family, and the Dynamic Island.
- Permissions, VoiceOver, dark mode and large text.
- A cold-start offline web load. Service workers were blocked in the browser flow.
- Native XCTest, which was not run because of the CoreSimulator and Xcode mismatch.

## Terminal state

I wrote only this file. I made no source edits or commits. I ran no browser, native, test or build commands, started no agents and sent no messages. A collage attempt failed because Pillow isn't installed. I removed the empty scratch directory it left behind and left nothing running.
