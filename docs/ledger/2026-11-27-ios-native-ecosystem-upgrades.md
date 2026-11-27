# 2026-11-27 — iOS 26/27 Native UI and Apple Ecosystem Upgrades

## Scope

Implemented all 7 native iOS 26/27 and Apple ecosystem upgrade areas in `ios/` (pure SwiftUI, Swift 6 strict concurrency, zero third-party dependencies), regenerated `ios/AgentInterface.xcodeproj` via `node ios/tools/generate-project.mjs`, and updated `ios/README.md` and `ios/Parity.md`:

1. **Liquid Glass & Zoom Transitions**: `ios/AgentInterface/LiquidGlass.swift`, `ComposerView.swift`, `StatusDock.swift`, `ComputerView.swift`, `VoiceViews.swift`, `RootView.swift`, `ConversationView.swift`, `MediaViews.swift`.
2. **iPadOS Multi-Window & Drag-Out**: `ios/AgentInterface/SecondaryWindows.swift`, `AgentInterfaceApp.swift`, `KeyboardCommands.swift`, `RootView.swift`, `ComputerView.swift`, `PreferencesView.swift`, `ConversationView.swift`, `MediaViews.swift`.
3. **Biometric Gating (`LocalAuthentication`)**: `ios/AgentInterface/BiometricGate.swift`, `VaultViews.swift`, `ConversationTurnView.swift`, `PreferencesView.swift`, `AgentInterfaceApp.swift`, `AppStore+Session.swift`, `Info.plist`.
4. **Apple Watch Companion (`watchOS`)**: `ios/Shared/Watch/WatchPayload.swift`, `ios/AgentInterface/WatchBridge.swift`, `ios/AgentInterfaceWatch/`, `ios/AgentInterfaceWatchWidgets/`, `ios/tools/generate-project.mjs`, `ios/Shared/Widgets/AssistantActivity.swift`.
5. **VisionKit Document Scanner**: `ios/AgentInterface/DocumentScanner.swift`, `ComposerView.swift`, `Info.plist`.
6. **Interactive Widgets, Control Center, App Intents, Spotlight & Quick Actions**: `ios/Shared/Widgets/WidgetViews.swift`, `WidgetSnapshot.swift`, `ActivityActions.swift`, `TalkIntent.swift`, `ios/AgentInterfaceWidgets/AgentInterfaceWidgets.swift`, `ios/AgentInterface/AssistantIntents.swift`, `AssistantSpotlight.swift`, `QuickActions.swift`, `WidgetSync.swift`, `BotSettingsView.swift`, `DiscoveryViews.swift`.
7. **On-Device `FoundationModels` & Opt-In `AlarmKit` (iOS 26+)**: `ios/Shared/OnDeviceIntelligence.swift`, `ios/AgentInterface/CriticalAlarms.swift`, `VoiceViews.swift`, `ReplyActions.swift`, `DiscoveryViews.swift`, `CollaborationViews.swift`, `BotProfileView.swift`, `ExperienceViews.swift`, `PreferencesView.swift`, `ios/AgentInterfaceShare/ShareViewController.swift`.

## Red-Run Proof

| Target                                      | Mutation                                                                                     | Test Command                                                                                                                                                                                                                | Result                                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `ios/AgentInterface/AssistantIntents.swift` | Bypass `ShortcutSendPolicy.isEnabled` (`defaults.bool(forKey: key(scope: scope))` -> `true`) | `IOS_VALIDATION_FRESH=1 bash .agents/tools/validate-ios.sh 39F5329D-FA70-4259-9B8A-6AECECDE2227 test -only-testing:AgentInterfaceTests/EcosystemUpgradeTests/testSendAssistantMessageIntentEnforcesOptInLengthAndRateLimit` | Caught (exit 65): `failed - Expected sendDisabled by default` and `XCTAssertNil failed` |

## Validation Runs

- **Node / CI Checks**: `pnpm run verify:ci` (lint, `format:check`, `typecheck`, `build`, Vitest: 265 test files, 4,328 tests passed, 0 failed).
- **watchOS Companion Build** (Mac mini, Xcode 27.2 `27B52`, Apple Watch Series 12 46mm simulator `B4C61407-0D51-4F4A-ABDA-CF6EB1A1B1AD`): `xcodebuild -project ios/AgentInterface.xcodeproj -scheme AgentInterfaceWatch ... build` -> `** BUILD SUCCEEDED **` (includes embedded `AgentInterfaceWatchWidgets.appex`).
- **Targeted iOS Unit Suites** (Mac mini, iPhone 18 Pro simulator `39F5329D-FA70-4259-9B8A-6AECECDE2227`, iOS 27.0): `EcosystemUpgradeTests` (11/11), `AssistantSurfaceTests` (18/18), `SystemSurfaceTests` (12/12), `NativeFeatureTests` (10/10), `FixedWaitRuleTests`, `NativeContractTests/testTheObservedListNamesEveryTrackedProperty` -> 54/54 passed.
- **Full iOS Suite** (Mac mini, `--allow-full-suite`): 1,118 passed, 29 skipped, 4 failed on first run -> fixed all 4 (`resetAccountContent` for `searchRequest`/`savedRequest`/`openGroupRoomId`, `DockCard` raised fill behind `.glassEffect` for 4.5:1 attention contrast, and `VaultView.identity` format for `AddVaultLoginView`), then re-ran all 4 fixed tests + `EcosystemUpgradeTests` -> all passed (exit 0).
