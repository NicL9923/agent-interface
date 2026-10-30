# Empty, offline, shared draft and widget review, round 2

**Score: 9.0/10.** The target is 9, so this round passes. Nothing blocks the area.

- Reviewer: Claude Opus 5.5 (`claude-opus-5-5`), Anthropic. High reasoning effort was requested. I can't confirm the internal effort setting from inside the session, and nothing suggests it ran lower.
- Implementer: OpenAI, so this review comes from a different provider.
- Code state: `61c81f861958f89e292b61f0c4b22fb64af69368` on `nic/full-app-design-review`.
- Scope: the diff `fe26033..61c81f8` and the code that calls it or that it calls. Round 1 is in `survival-screen-review.md` (8.3).
- Out of scope: the 24 areas that already passed, the capture tools, earlier proof chains, the Debug wrappers and unchanged assets.

## Evidence used

Raw captures from `/Volumes/DevSSD/scratch/wildbots-design-review/survival-screen-r2`, inspected at full resolution:

- Web, 1440 and 390 wide: `empty-home`, `empty-chat`, `empty-chat-draft`, `offline-chat`, `reconnected-draft`. `capture.log` lists all ten paths and reports `offlineDraftPreserved: true`.
- iPhone, 1206 x 2622: `native-Empty`, `native-ShareDraft`, `native-ShareOffline`, `native-ShareDiscard`, `native-Widget`, `native-WidgetStale`, `native-WidgetEmpty`.

I didn't score `offline-space.png` or `share-discard.png`, because they are annotated comparisons. I ignored the outer "Widget preview" title and disclaimer, since they aren't part of the product.

Coordinates are in pixels of the original file. **Seen** means visible in a capture. **Code only** means I read the source but nothing rendered it.

## Round 1 findings

| # | Round 1 issue | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Discard deleted at once | Fixed (seen, code) | `native-ShareDraft`: Add is in its own section at 47-1156 x 1576-1730, and Discard is in a separate section at 47-1156 x 1835-1993. `native-ShareDiscard`: a standard alert at 123-1083 x 1012-1694 titled "Discard this shared draft?", with "Discard shared draft" (170-1036 x 1335-1479) and "Keep draft" (170-1036 x 1504-1645). `ShareCaptureView.swift:32` only sets the flag. Deletion happens only in the alert's destructive action at `:37`. A Debug entry opened the alert, so no real tap was shown. |
| 2 | Disabled Reconnect while offline | Fixed (seen, code) | `offline-chat-390`: the panel shrank to 14-376 x 510-632, about 122 px instead of 154. The decision card (22-355 x 128-452) is now fully visible. `ConnectionPanel.tsx:58` drops the actions only when `offline` is set. The app-unavailable and Hermes cases keep the button. |
| 3 | "Offline" next to "Reconnecting" | Fixed on web (seen). Native banner fixed (code only). One native line remains, see new finding 2 | `offline-chat-1440`: the header reads "Offline" at 95-138 x 32-48, the pinned captions read "Offline" at 92-140 and 196-243 x 197-210, and the activity line reads "Ranch hand is offline…" at 595-727 x 270-285. `Avatar.tsx:287` changes the label only for `disconnected` plus `offline`, so the ARIA name follows. `RootView.swift:99` reads the observable `NetworkReachability.shared`. |
| 4 | Empty roster read like an infrastructure status | Fixed (seen) | Heading "No assistants yet" and household help text: `empty-home-1440` at 38-297 x 157-232, `empty-home-390` at 30-360 x 158-236, `native-Empty` at 161-1045 x 596-819. The CTA is unchanged (354-852 x 860-961 native). The desktop Today pane now shows "All clear · 0 at work · 0 finished" with no fake activity. The empty conversation heading is "Start with Ranch hand's role" (`empty-chat-1440`, 706-1055 x 345-377). |
| 5 | Widget empty caption | Fixed (seen, code) | `native-WidgetEmpty`: the medium widget says "Create one in WildBots." at 102-488 x 1196-1232. `WidgetViews.swift:345` keeps the open-the-app caption for a `nil` snapshot. |
| 6 | Disabled Add gave no reason | Fixed (seen, code) | `native-ShareOffline`: Add is dimmed at 96-358 x 1630-1682, with "Connect to add this. It stays saved here." at 96-800 x 1792-1829. The uploads case is code only (`ShareCaptureView.swift:30`). The editor label (`:21`) and warm background (`:34`) are present. |
| 7 | No navigation after import | **Withdrawn.** My round 1 claim was wrong | `ShareCaptureView.swift:53` awaits `store.select(botId)`. `AppStore.swift:768` defaults `navigate` to true, and `:782` sets `conversationRequest = UUID()`. `RootView.swift:83-86` observes that value and sets `destination = .conversation`, calls `openChat()` (which appends `.chat`, `:201-205`) and sets `compactColumn = .detail`. Round 1 noted correctly that RootView ignores `selectedBotId`, but it missed this second channel. An extra callback would duplicate the navigation. No real import gesture ran, so the runtime result is still unverified. |
| 8 | Stale footer dropped the age | Fixed (seen) | `native-WidgetStale`: the medium footer reads "1 hr, 0 min ago · Open to refresh" at 102-590 x 1203-1239. The small footer shows a history symbol and "1 hr, 0 min" at 102-322 x 1776-1816. See new finding 3. |
| 9 | Share extension rough edges | Fixed (code only) | Save starts disabled (`ShareViewController.swift:20`) and is enabled only after `prepare` succeeds (`:64`). Links and text say "Ready to save", and attachments are pluralized (`:65`). A failed prepare deletes its own `captureId` folder (`:68`). A failed save guard now explains itself (`:88-91`). `ShareInbox.pruneOrphans` (`ShareInbox.swift:38-50`) is checked below. |
| 10 | Copy and accessibility nits | Fixed (seen, code) | Role heading, editor accessibility label. The widget glyph color item was sample data and is not regraded. |

## Guard, privacy and data checks (code only)

- **`pruneOrphans` is tightly bounded.**
  - It only lists the `ShareInbox` App Group folder (`ShareInbox.swift:18`).
  - It only touches entries named as a UUID that are real directories, not symbolic links, and more than 86,400 s old.
  - It skips any folder with a matching `<id>.json`.
  - `removeItem` removes a symlink found inside a folder, not the file it points to.
  - Captures from another account keep their JSON, so their files survive.
  - The standalone check (`tests/share-inbox-checks.swift`) covers the orphan, fresh, saved, unrelated and symlink cases and the `..` file rejection.
- **No account, permission or sending rule changed.**
  - The scope checks around each await in `importDraft` (`ShareCaptureView.swift:51`, `:54`, `:64`, `:71`) are unchanged.
  - Discard and Add both stay disabled while `busy`.
  - Nothing sends automatically.
- **Changes behind Debug flags.** The `share-offline` bootstrap override (`DebugFixtures.swift:451`) and the alert auto-open (`ShareCaptureView.swift:42-44`) only run in Debug builds. Using a UUID `captureId` in `DebugSurvivalView` makes the sample pass `ShareInbox.valid`.

## New findings, in priority order

None of these blocks the area. Each fix fits in round 3 if you want one.

### 1. "It stays saved here" doesn't cover edits. Low-medium, data integrity (code only)

- **Code.** The editor changes only `@State capture` (`ShareCaptureView.swift:7`, `:21`). `persist()` runs only during import (`:60`, `:74`). "Later" just dismisses (`:35`). `RootView.checkShares` then reloads the original JSON (`RootView.swift:244`).
- **Why it matters.** Offline is exactly when someone would trim the shared text and tap Later. The new footnote promises "It stays saved here", but their edits disappear.
- **Fix.** Call `try? persist()` before `dismiss()` in Later, or in `.onDisappear` when the text changed. The capture's id and scope don't change, so this can't leak across accounts.

### 2. Native chat still says "is reconnecting…" while the device is offline. Low, consistency (code only)

- **Code.** `ActivitySentence.text` (`ConversationView.swift:1034-1039`) maps any lost connection to "reconnecting". The caller at `:588` passes only `connectionLost: !store.connected`. `ConversationView` already holds `reachability` (`:37`), and the roster uses it (`RootView.swift:518`).
- **Why it matters.** Web now says "Ranch hand is offline…". Native gives the same moment two different words, which was round 1's issue 3.
- **Fix.** Add an `offline` parameter that returns "offline", the way `Conversation.tsx:73` does.
- **Not seen.** No native offline chat capture was taken. Round 1 asked only for the native banner fix, so this is new and not a regression.

### 3. Small stale widget footer reads as a duration. Low, copy (seen)

- **Seen.** "1 hr, 0 min" next to a history symbol (`native-WidgetStale`, 102-322 x 1776-1816) has no "ago".
- **Plausible, not seen.** `Text(_:style: .relative)` counts live in WidgetKit, so a snapshot between 30 and 60 minutes old probably shows ticking seconds, such as "31 min, 5 sec". That's a lot of motion for a stale marker.
- **Fix.** Optional. Add "ago" to the small footer, or use a named relative format that the timeline reload refreshes. Leave as is if the person agrees it reads fine.

### 4. Nits

- **Dead branch.** `Sidebar.tsx:67` adds `offline ? "Offline"` inside `working ? …`. But `working` requires `!connectionLost` (`:54`), and `offline` implies `connectionLost` (`App.tsx:78`), so this branch never runs. Remove it or leave it.
- **Repeated copy.** The empty-chat heading "Start with Ranch hand's role" and the button "Discuss Ranch hand's role" (`empty-chat-1440`, 706-1055 x 345-377 and 771-990 x 430-473) say nearly the same thing. A shorter heading such as "Ranch hand" or "New conversation" would let the button carry the action. This is optional.
- **Wrong tap target.** Tapping the empty widget opens Today (`WidgetViews.swift:349`). The caption now says "Create one". Today shows no create action in `empty-home-1440`, so a deep link to assistant creation would match the caption better. This is code only.

## Not graded

- The Today pane in `empty-home-1440` shows "Since you were away", "Mark caught up" and "Since yesterday, 2:28 PM" with no assistants. Today is a separately passed area.
- The two primary buttons, Review and Send, in `reconnected-draft-390` aren't part of this diff.

## Gaps, not graded as defects

- The share sheet in the system host, a real incoming share, file transfer and a real import gesture. Finding 7's navigation is source evidence only.
- A native Discard tap. A Debug entry opened the alert.
- Widgets in a real WidgetKit host: timelines, taps, accessory families and the large size.
- Native offline chat and native cold-start reading from the offline library.
- Cold-start offline web load. Service workers were blocked.
- VoiceOver, dark mode and large text.
- Native XCTest, which didn't run because of the CoreSimulator and Xcode mismatch.

## Score rationale

All nine round 1 fixes landed, and I withdrew finding 7 after reading the code. The flows people see most now show what the source promises:

- Empty roster on both clients.
- Offline web chat.
- Share form, online and offline.
- Discard confirmation.
- All three widget states.

The remaining items are code only or nits. Finding 1 is the only one that touches user data, and it affects edits rather than the shared content itself. That puts the area at 9.0.

## Terminal state

I wrote only this file. I made no source edits or commits. I ran no tests, builds, browser, native or simulator commands, started no agents and sent no messages. I created no crops or scratch files. Every command finished in the foreground, and nothing is left running.
