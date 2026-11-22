#!/bin/bash
# Runs every iOS mutant list against its file. Run it from the repository root inside
# ~/.agents/tools/mac-heavy-lock.sh with IOS_MUTANT_SIMULATOR set; each list's output lands beside it.
set -uo pipefail
D=docs/evidence/2026-11-19-connection-states/mutants
T="bash $D/ios-tests.sh"
run() { python3 ~/.agents/tools/mutate.py "$1" "$T" "$D/$2.py" > "$D/$2.out" 2>&1; echo "$2: $(tail -1 "$D/$2.out")"; }
run ios/AgentInterface/ConnectionOutage.swift ios-outage
run ios/AgentInterface/AppStore+Outage.swift ios-store
run ios/AgentInterface/AppStore.swift ios-appstore
run ios/AgentInterface/AppStore+Polling.swift ios-polling
run ios/AgentInterface/AppStore+Conversation.swift ios-conversation
run ios/AgentInterface/ConversationView.swift ios-copy
run ios/AgentInterface/AvatarView.swift ios-avatar
run ios/AgentInterface/Models.swift ios-models
run ios/AgentInterface/APIClient.swift ios-apiclient
