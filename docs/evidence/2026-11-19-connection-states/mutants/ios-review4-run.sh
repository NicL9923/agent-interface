#!/bin/bash
# The fourth review round's iOS mutants. Run it from the repository root inside
# ~/.agents/tools/mac-heavy-lock.sh with IOS_MUTANT_SIMULATOR set; each list's output lands beside it.
set -uo pipefail
D=docs/evidence/2026-11-19-connection-states/mutants
T="bash $D/ios-tests.sh"
run() { python3 ~/.agents/tools/mutate.py "$1" "$T" "$D/$2.py" > "$D/$2.out" 2>&1; echo "$2: $(tail -1 "$D/$2.out")"; }
run ios/AgentInterface/Models.swift ios-review4-models
run ios/AgentInterface/AppStore+Polling.swift ios-review4-polling
run ios/AgentInterface/AppStore+Conversation.swift ios-review4-conversation
run ios/AgentInterface/AppStore+ChatCache.swift ios-review4-cache
run ios/AgentInterface/AppStore+Session.swift ios-review4-session
run ios/AgentInterface/OfflineLibrary.swift ios-review4-library
run ios/AgentInterface/AppStore.swift ios-review4-appstore
run ios/AgentInterface/DraftAdditions.swift ios-review4-additions
run ios/AgentInterface/BackgroundRefresh.swift ios-review4-background
