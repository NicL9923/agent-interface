# October 30 compact composer and design follow-ups

Implementation commits `b630d93` and `452ddfe` on `nic/design-followups-compact-composer`, based on
the merge of PR #207 at `3812a91`. These changes address product follow-ups in
[#206](https://github.com/NicL9923/agent-interface/issues/206). They do not close
the device and service coverage gaps in that issue.

## Application checks

Node 24.21.0 ran the revised full web suite: all 1,531 tests in 107 files passed.
The earlier run found one test that still expected Sign out to skip the new
confirmation; that expectation is corrected. The web production build and its
pinned no-emit typecheck completed successfully.

The native app and its extension targets built with the simulator SDK under
`mac-heavy-lock.sh`. The shared-inbox implementation agent also ran the
production Foundation checks under the lock and typechecked the app and all
XCTest sources with Swift 6 strict concurrency. The new relaunch regression
typechecks but has not executed.

XCTest remains blocked by the installed CoreSimulator service mismatch:
1174.9.2 is installed while the selected Xcode expects 1174.21.0. The existing
simulator capture tool can boot, install and capture the built app. Each capture
run shut down its simulator inside the same lock command.

## Agent use and visual checks

The agent used Chromium against the loopback fixture app at 1440, 768, 390 and 320
pixels. At 390, the idle composer card shrank from 132 to 54 pixels. The short
draft uses 98 pixels and the five-line draft uses 194. At 320, the controls
deliberately stack, giving a 98-pixel idle card. Buttons retain 44-pixel targets.

Browser interaction covered recording, transcription failure and manual retry,
playback and replay, upload failure and retry, long paste becoming an attachment,
advanced presentation, and the offline layout. The capture used explicit media
and provider fixtures, not a microphone or real provider. It checked that the
textarea and focus survive layout changes and that Enter during Japanese IME
composition sends no message. The run recorded zero message submissions. A
150-character single line also stays within the page at each width.

Initial native iPhone captures cover the idle composer, multiline draft, focused input
with keyboard, dark appearance, and accessibility text. The accessibility
capture caught a compressed control row. Keeping the card's full vertical size
and stacking accessibility text fixed it in the next capture. The reviewer
caught incorrect Groups and Notifications capture entry points; those images
showed the widget preview and are not evidence for either change. The entry
point is corrected, and new native captures are queued under the machine lock.
Web settings were captured after scrolling at desktop and phone widths.

Saved captures are under
`/Volumes/DevSSD/scratch/wildbots-design-review/followups-composer/`. The PR
attaches the before/after comparison and representative native captures.
The owned browser and preview server were closed after capture.

## Independent review

[The OpenAI review](../evidence/design-review/shared-text-persistence-review.md)
of the Anthropic shared-text implementation found no blocking defects. The fix
deduplicates capture acceptance after an emptied-inbox save fails. It does not
make draft landing transactional. A process stopping after the draft save and
before queued-text removal can still cause duplicate editable text on relaunch,
including after the receipt write. This never sends a message automatically.

[The Anthropic review](../evidence/design-review/compact-composer-round1.md)
of the composer and OpenAI changes scored the composer 7.6/10 in round 1.
Commit `452ddfe` fixes the hidden measurement overflow, moves replay into the
existing speaker button, shortens the placeholder, hides the mobile Listen
control while typing, and caps native glyph sizes. It also restores 44-pixel
routine recipient rows, clears consumed native navigation tokens, aligns Tab
order with the inline layout, and removes obsolete CSS.

The Artifacts caller already removes the button and sheet if its conversation
disappears. Its defensive standalone reload state now reports unavailable
instead of claiming there are no files. Routine cards already stay mounted
during reload through the existing resource loader and focus-return check.

The final native icon and accessibility-keyboard captures, followed by the
second composer rating, are pending. The follow-up PR remains draft meanwhile.

## Still needs a device or service

No physical iPhone was connected. Real EventKit data and permission prompts,
push delivery, incoming system shares and file transfer, native cold-start
offline reading, system-hosted widget placement and taps, Live Activities,
VoiceOver and native interaction remain unverified. Nicolas explicitly chose
simulator and browser coverage for now. The new widget destination
and shared-draft protections have source and model checks, not system-host
interaction evidence. Existing screenshots remain valid where product UI did
not change.
