# ios/AgentInterface/GroupSettingsView.swift, the second review round's fixes
MUTANTS = [
    # Finding 5: one failed chat disables Save in a room's settings.
    (
        ".disabled(busy || !store.householdReachable || over > 0)",
        ".disabled(busy || !store.connected || over > 0)",
    ),
    # Finding 5: and says Hermes must be reconnected.
    (
        "      if !store.householdReachable { Section",
        "      if !store.connected { Section",
    ),
]
