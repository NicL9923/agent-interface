# 19 settings native confirmation rubber duck (Opus 5.5 High, read-only)

No score and no gate claim. This covers source plus the existing captures only. Nothing here was built or run.

## Verdict on the current `.alert` change

Drop it. It cannot reach the bar, and no supported fix exists inside `.alert`.

- The label color comes from the root `.tint(Palette.accent)` (AgentInterfaceApp.swift:12). The prominent preferred-button fill is system blue. The result is green on blue at 1.59:1, on both iPhone (after/ios/settings-model-confirmation.png) and the fresh iPad run (after/ipad/settings-delete-confirmation.png, 17:28).
- The message text (#7B7A79 on #EDECEB, 3.63:1) is UIKit's alert secondary label. SwiftUI exposes no way to style it.
- Removing `.keyboardShortcut(.defaultAction)` might stop the blue fill. The message contrast still fails, so it isn't worth a capture cycle.
- The discard prompt (BotSettingsView.swift:205, still a `confirmationDialog`) has the same class of failure. It renders mid-sheet, far from Close, with no visible cancel. Its system red on the gray glass button is about 2.6:1 (after/ios/settings-discard-confirmation.png). Fold it into the same fix. Otherwise the settings screen fails the gate on the fourth prompt.

## Options weighed

| Option | Verdict | Why |
| --- | --- | --- |
| Nested `.sheet(item:)` with a local confirmation view | **Recommend** | Explicit Palette surface, text and buttons. Modal for VoiceOver by construction. Swipe-down is a free, safe cancel. Uses one presentation slot the editor already uses for alerts. |
| `.popover` + `.presentationCompactAdaptation(.popover)` | Reject | The anchor has to live on the Save or Delete row inside a lazy `Form`. The server-triggered model prompt arrives after a network round trip, when that row may be scrolled away. Popovers get cramped at AX sizes on iPhone. |
| Custom `.overlay` scrim | Reject as primary | You hand-roll modality (`.isModal` does not hide the UIKit nav bar's Close button), escape, Esc key, scrim hit-testing, animation, and blocking the parent sheet's swipe. That is more code and more ways to fail than the problem needs. Keep it as a fallback only if fitted sizing misbehaves on iPad. |

## Concrete implementation

Keep it all in BotSettingsView.swift as a `private struct`. The pbxproj lists files explicitly, so a new file means a project edit. Promote it to a shared file when a second screen adopts it.

### State: one enum, one presentation

```swift
private enum SettingsConfirmation: Identifiable, Equatable {
  case model(warning: String), personal, delete, discard
  var id: String { /* "model" | "personal" | "delete" | "discard" */ }
  // title, message, confirmLabel, keepLabel ("Keep editing" / "Keep assistant"), destructive: Bool
}
@State private var confirmation: SettingsConfirmation?
@State private var accepted: SettingsConfirmation?
```

This replaces `confirmModel`, `confirmPersonal`, `deleteConfirm` and `discardConfirm`. One `.sheet(item:)` means two prompts can never compete for the slot.

### Run the action after dismissal, never during it

```swift
.sheet(item: $confirmation, onDismiss: {
  guard let choice = accepted else { return }   // swipe-down, Esc, VO escape, Keep → nothing
  accepted = nil
  switch choice {
  case .model: saveBot(confirmed: true)
  case .personal: saveBot(personal: true)
  case .delete: deleteBot()
  case .discard: closeSheet()
  }
}) { item in
  ConfirmationSheet(item: item,
    accept: { accepted = item; confirmation = nil },
    keep: { confirmation = nil })
}
```

Why this matters in the current source:
- **Personal, then model chain.** `saveBot(personal: true)` can come back as a 409 `confirmRequired`. `action()` then presents the model prompt (BotSettingsView.swift:675). If the PATCH runs while the personal prompt is still animating out, the new presentation can be dropped. The DebugFixtures URL protocol answers almost instantly, so the capture is the most likely place to hit this. `onDismiss` runs after the animation finishes, which removes the race.
- **Delete then `closeSheet()`.** Dismissing the parent while the child is still mid-dismiss is avoided the same way.
- **Discard.** The same path closes the editor only after the prompt is gone.

Attach the sheet to `editor`, where the alerts are today. Do not put it inside `Form` rows. Lazy rows lose presentation modifiers when they scroll away.

### Model warning travels with the prompt

In `action()`'s catch, use `confirmation = .model(warning: error.localizedDescription); self.error = nil` for `confirmRequired`. The private case already clears `error` this way. This does two things:
- The banner no longer duplicates the sheet text.
- `selectTab()` clears `error` (BotSettingsView.swift:180-184), and the tab bar is not disabled while busy. Today the alert reads `Text(error ?? …)`, so switching tabs mid-save shows the generic fallback instead of the cost warning.

Drop the `confirmModel = false` in the model row closure (:304). The modal sheet blocks navigation, so it is dead code.

### ConfirmationSheet view

- **Surface.** `.presentationBackground(Palette.raised(scheme))`. This one is required. iOS 26 renders sheets at partial detents as translucent glass, so text contrast would depend on what sits behind the sheet.
- **Title.** `.title3.weight(.semibold)` in `Color.primary` with `.isHeader`.
- **Message.** `.body` in `Palette.messageMetadata`: 5.69:1 light, 6.67:1 dark on raised.
- **Buttons.** Full width, `minHeight: 44`, stacked vertically at every size, so Dynamic Type never truncates labels.
  - Confirm on top. Plain button style with explicit colors: `Palette.danger` text on `Palette.raised`, plus a `Palette.line` capsule stroke. That is 6.35:1 light and 8.04:1 dark. The model prompt uses `Palette.accent` text: 5.91 light, 8.22 dark. Do not use `.bordered` with a tint. The iOS 26 glass fill makes contrast unpredictable, which is the bug we are fixing.
  - Keep on the bottom, in the thumb zone. Use `.accentProminent`: onAccent on accent, 5.91 light and 9.32 dark. Keep is the safe default, matching the web's safe-action focus.
- **Keyboard.** Keep gets `.keyboardShortcut(.cancelAction)`, so Esc and Cmd-period cancel on iPad. No `.defaultAction` anywhere. Return must never confirm a delete.
- **VoiceOver.** The sheet is modal automatically. Focus lands on the first element, the title. Add `.accessibilityAction(.escape) { keep() }` on the root. The sheet should handle the two-finger scrub anyway, but this is cheap insurance. Identifiers: `settingsConfirmation`, `confirmationAccept`, `confirmationKeep`.
- **Swipe-down.** Leave interactive dismissal enabled. A swipe is a safe cancel because `accepted` stays nil. The parent's `.interactiveDismissDisabled(dirty || busy)` does not leak into the child.
- **Sizing.** Wrap the content in a `ScrollView` with `.scrollBounceBehavior(.basedOnSize)`. Measure the VStack with `onGeometryChange`, which is back-deployed to iOS 16.
  - **iPhone.** Use `.presentationDetents([.height(measured)])` with a sensible starting value such as 300, and add `.presentationDragIndicator(.visible)`. At AX sizes the detent clamps to full height and the content scrolls. BotProfileView.swift:130-160 measures detents the same way.
  - **iPad.** Wrap `.presentationSizing(.form.fitted(horizontal: false, vertical: true))` in `if #available(iOS 18, *)`. Regular width ignores detents. Without this you get a mostly empty full form sheet. **Unverified risk:** how `.fitted` treats a ScrollView's ideal height. If the iPad capture shows a collapsed or oversized sheet, use `ViewThatFits(in: .vertical)` with a bare VStack first and the ScrollView as the fallback. iOS 17 falls back to a standard form sheet. The project targets iOS 17.0, and the simulators most likely run iOS 26, so that path will go uncaptured. Say so in the ledger.

### Low-risk flag in code you're touching

`personalConfirmed` never resets. After someone confirms once, re-sharing and then unsharing again skips the prompt. A PATCH with `shared: true` still sends `confirmPrivate: true` (:691-702). This is the native twin of the stale-confirmation bug discussion 18 found on the web. Reset it after a successful save, or derive `personal` only from the accepted prompt.

## Smallest meaningful test and capture plan

Everything goes into the existing `testSettingsDesignReview` launches. No new launch is needed.

1. **settings-model** (iPhone and iPad). Before Save, switch Shared off. That gives Make it personal, then the 409 model prompt, then Confirm. Capture `settings-personal-confirmation` and `settings-model-confirmation` here. Assert the warning text sits inside `settingsConfirmation`. After Confirm, assert the notice reads "Assistant saved." instead of the household message. This one flow exercises the dismissal-to-presentation race.
2. **settings-loaded.** Delete, capture, swipe the sheet down. Assert `settingsConfirmation` is gone, `assistantSettingsForm` still exists, and `bot.ranch` is still listed after Close. That proves swipe-down is a cancel and nothing was written.
3. **settings-dark** and **settings-large-text** (AX-XL). Delete, capture, tap `confirmationKeep`. These cover contrast on the dark surface, and wrapping plus scrolling at AX sizes.
4. **settings-error.** Keep the discard capture. Assert the Keep button exists and is hittable.
5. **Assertions.** Look up buttons by identifier, not label, so the "Keep editing" / "Cancel" / coordinate-tap fallback in the current test can go away.

**Manual, once, on iPad with a hardware keyboard if the harness allows:** Esc cancels the delete prompt and Return does not confirm it. Otherwise record it as unverified.

## Blockers and tradeoffs

- **Blocker for any score.** The iPad run is still executing, and nothing above has been captured. All four prompts currently fail contrast on both devices.
- **Tradeoff.** A sheet reads less like an alert than the system dialog does. In return we get controlled contrast, a visible safe cancel and Dynamic Type support. On iPad, the fitted form sheet is the only part I can't predict from source.
- **Out of scope, will hit the same gate later.** The routine delete `confirmationDialog`s in this same sheet (:259, :895), and about 15 other `confirmationDialog`s app-wide (Preferences, Integrations, Vault and others) all inherit the green root tint on system chrome. Once this view passes, it is the template for those.
