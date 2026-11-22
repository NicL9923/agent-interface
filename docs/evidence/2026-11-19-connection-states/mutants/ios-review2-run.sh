#!/bin/bash
# The second review round's iOS mutants. Run it from the repository root inside
# ~/.agents/tools/mac-heavy-lock.sh with IOS_MUTANT_SIMULATOR set; each list's output lands beside it.
set -uo pipefail
D=docs/evidence/2026-11-19-connection-states/mutants
T="bash $D/ios-tests.sh"
run() { python3 ~/.agents/tools/mutate.py "$1" "$T" "$D/$2.py" > "$D/$2.out" 2>&1; echo "$2: $(tail -1 "$D/$2.out")"; }
run ios/AgentInterface/AppStore+Polling.swift ios-review2-polling
run ios/AgentInterface/AppStore+Conversation.swift ios-review2-conversation
run ios/AgentInterface/AppStore+Outage.swift ios-review2-outage
run ios/AgentInterface/AppStore.swift ios-review2-appstore
run ios/AgentInterface/StoreRequests.swift ios-review2-requests
run ios/AgentInterface/WidgetSync.swift ios-review2-widgets
# The view lines, through the UI test that covers them.
U="bash $D/ios-review2-ui.sh"
runui() { python3 ~/.agents/tools/mutate.py "$1" "$U" "$D/$2.py" > "$D/$2.out" 2>&1; echo "$2: $(tail -1 "$D/$2.out")"; }
runui ios/AgentInterface/RootView.swift ios-review2-home
runui ios/AgentInterface/GroupSettingsView.swift ios-review2-group-settings
