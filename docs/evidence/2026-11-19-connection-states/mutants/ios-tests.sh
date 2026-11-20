#!/bin/bash
# The iOS connection-state tests, for ~/.agents/tools/mutate.py. Run it from the repository root
# inside ~/.agents/tools/mac-heavy-lock.sh with IOS_MUTANT_SIMULATOR set to a simulator UUID.
# A mutant that fails to compile fails here too, so each list holds only mutants that compile.
set -euo pipefail
xcodebuild -project ios/AgentInterface.xcodeproj -scheme AgentInterface \
  -destination "id=${IOS_MUTANT_SIMULATOR:?}" -derivedDataPath .private/ios-mutants \
  CODE_SIGNING_ALLOWED=NO -quiet test \
  -only-testing:AgentInterfaceTests/OutageTests -only-testing:AgentInterfaceTests/ReadRetryTests \
  -only-testing:AgentInterfaceTests/ConnectionCopyTests -only-testing:AgentInterfaceTests/ConnectionStateStoreTests \
  -only-testing:AgentInterfaceTests/ConnectionQuietingTests \
  -only-testing:AgentInterfaceTests/NativeContractTests/testAFailedReadIsTheChatsAloneAsksBootstrapOnceAndRetriesWithBackoff \
  -only-testing:AgentInterfaceTests/NativeContractTests/testARetryWaitsWhileTheAppIsAwayTheDeviceIsOfflineOrTheChatIsOffScreen \
  -only-testing:AgentInterfaceTests/NativeContractTests/testEveryReadDropsThePendingRetryAsItSetsOut \
  -only-testing:AgentInterfaceTests/NativeContractTests/testAnotherChatsFailuresGateNothingHereAndItsOwnStartTheWaitsOver \
  -only-testing:AgentInterfaceTests/NativeContractTests/testARetryThatWakesWhileAReadIsOnItsWayAsksForNoSecondRead \
  -only-testing:AgentInterfaceTests/NativeContractTests/testAHermesLossAfterItWasReachedWaitsItsGracePeriodAndOneBeforeShowsAtOnce \
  -only-testing:AgentInterfaceTests/NativeContractTests/testAStaleRosterKeepsEachAssistantsActivityForThirtySecondsFromTheFirstStaleOne \
  -only-testing:AgentInterfaceTests/NativeContractTests/testConversationOutagePreservesDraftAndTranscriptWhileDisablingSendUntilRecovery \
  -only-testing:AgentInterfaceTests/NativeContractTests/testRuntimeDisconnectKeepsKnownRosterAndCurrentDraft \
  -only-testing:AgentInterfaceTests/NativeContractTests/testPollingKeepsRefreshingBootstrapWhileTheServerIsDisconnectedOrFailing \
  -only-testing:AgentInterfaceTests/NativeContractTests/testAHermesDownRosterTakesTheServersMembershipAndCarriesOnlyTheRowsItKeeps \
  -only-testing:AgentInterfaceTests/NativeContractTests/testAHermesDownRosterWithoutTheOpenChatLeavesItAndOpensNoOther \
  -only-testing:AgentInterfaceTests/NativeContractTests/testWhileAChatsReadFailsOnlyItsRetryAndAWakeupReadIt \
  -only-testing:AgentInterfaceTests/NativeContractTests/testABootstrapThatAnswersPastTheGracePeriodBeforeTheTimerRunsShowsAndSaysNothing \
  -only-testing:AgentInterfaceTests/NativeContractTests/testAnAppLossThatTurnsIntoAHermesLossIsOneLoss \
  -only-testing:AgentInterfaceTests/NativeContractTests/testAStopIsNotSentAfterTheChatOrTheNetworkIsLost \
  -only-testing:AgentInterfaceTests/NativeContractTests/testAnUncertainSendIsNotRetriedWhileTheChatOrTheNetworkIsDown \
  -only-testing:AgentInterfaceTests/NativeContractTests/testAutomaticReadsWaitForTheNetworkTheForegroundAndTheSameSession \
  -only-testing:AgentInterfaceTests/NativeContractTests/testACancelledReadThatDisplacedTheRetrySetsItAgain \
  -only-testing:AgentInterfaceTests/NativeContractTests/testAnOpenAssistantRemovedWhileHermesIsDownLeavesAndAReadOnItsWayCannotBringItBack \
  -only-testing:AgentInterfaceTests/NativeContractTests/testAnAssistantThatLeavesTakesItsDeliveredNotificationsWithIt \
  -only-testing:AgentInterfaceTests/NativeContractTests/testAChatWriteIsNotSentWhileTheChatOrTheNetworkIsDown \
  -only-testing:AgentInterfaceTests/SystemSurfaceTests/testARosterThatDropsAnAssistantWhileHermesIsDownPrunesItFromTheSystemSurfaces \
  -only-testing:AgentInterfaceTests/StoreRequestsTests/testAHouseholdWriteChecksTheConnectionAsItStartsAndOneChatsFailureIsNotIt \
  > /dev/null 2>&1
