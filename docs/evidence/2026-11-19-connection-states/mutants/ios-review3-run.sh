#!/bin/bash
# The third review round's iOS mutants. Run it from the repository root inside
# ~/.agents/tools/mac-heavy-lock.sh with IOS_MUTANT_SIMULATOR set; each list's output lands beside it.
set -uo pipefail
D=docs/evidence/2026-11-19-connection-states/mutants
T="bash $D/ios-tests.sh"
run() { python3 ~/.agents/tools/mutate.py "$1" "$T" "$D/$2.py" > "$D/$2.out" 2>&1; echo "$2: $(tail -1 "$D/$2.out")"; }
run ios/AgentInterface/AppStore+Polling.swift ios-review3-polling
run ios/AgentInterface/AppStore+Conversation.swift ios-review3-conversation
run ios/AgentInterface/AppStore.swift ios-review3-appstore
run ios/AgentInterface/WidgetSync.swift ios-review3-surfaces
run ios/AgentInterface/BackgroundRefresh.swift ios-review3-background
run ios/AgentInterface/AgentInterfaceApp.swift ios-review3-notifications
run ios/AgentInterface/CollaborationViews.swift ios-review3-groups
run ios/AgentInterface/GroupSettingsView.swift ios-review3-group-settings
# The banner's lines run through the unit test that hosts the chat view.
run ios/AgentInterface/ConversationView.swift ios-review3-banner
# The settings lines, through the UI test that covers them.
U="bash $D/ios-review3-ui.sh"
python3 ~/.agents/tools/mutate.py ios/AgentInterface/BotSettingsView.swift "$U" "$D/ios-review3-settings.py" > "$D/ios-review3-settings.out" 2>&1
echo "ios-review3-settings: $(tail -1 "$D/ios-review3-settings.out")"
