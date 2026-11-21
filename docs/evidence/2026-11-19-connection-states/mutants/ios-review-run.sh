#!/bin/bash
# The review round's iOS mutants, and the earlier lists whose files the round changed. Run it from
# the repository root inside ~/.agents/tools/mac-heavy-lock.sh with IOS_MUTANT_SIMULATOR set; each
# list's output lands beside it.
set -uo pipefail
D=docs/evidence/2026-11-19-connection-states/mutants
T="bash $D/ios-tests.sh"
run() { python3 ~/.agents/tools/mutate.py "$1" "$T" "$D/$2.py" > "$D/$2.out" 2>&1; echo "$2: $(tail -1 "$D/$2.out")"; }
run ios/AgentInterface/AppStore+Outage.swift ios-store
run ios/AgentInterface/AppStore.swift ios-appstore
run ios/AgentInterface/AppStore+Polling.swift ios-polling
run ios/AgentInterface/AppStore.swift ios-review-appstore
run ios/AgentInterface/HomeStates.swift ios-review-home
run ios/AgentInterface/AppStore+Outage.swift ios-review-store
run ios/AgentInterface/AppStore+Polling.swift ios-review-polling
run ios/AgentInterface/AppStore+Session.swift ios-review-session
run ios/AgentInterface/AppStore+Sending.swift ios-review-sending
