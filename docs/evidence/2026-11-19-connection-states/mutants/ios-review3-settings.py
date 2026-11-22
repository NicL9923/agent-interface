# ios/AgentInterface/BotSettingsView.swift, the third review round's fixes, through the UI test
MUTANTS = [
    # Finding 4: the tools step waits for the open chat.
    ('method: "PUT", gate: .household)', 'method: "PUT", gate: .openChat)'),
    # Finding 4: Save waits for the open chat.
    (
        "    store.householdReachable && !busy && configDirty",
        "    store.connected && !busy && configDirty",
    ),
]
