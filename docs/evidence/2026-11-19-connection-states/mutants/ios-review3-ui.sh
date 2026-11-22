#!/bin/bash
# The UI test that guards the third review round's settings lines, for ~/.agents/tools/mutate.py. Run it from
# the repository root inside ~/.agents/tools/mac-heavy-lock.sh with IOS_MUTANT_SIMULATOR set.
set -euo pipefail
xcodebuild -project ios/AgentInterface.xcodeproj -scheme AgentInterface \
  -destination "id=${IOS_MUTANT_SIMULATOR:?}" -derivedDataPath .private/ios-mutants \
  CODE_SIGNING_ALLOWED=NO -quiet test \
  -only-testing:AgentInterfaceUITests/ConnectionStateFlowTests/testOneChatsFailedReadsLeaveItsAssistantsSettingsSavable \
  > /dev/null 2>&1
