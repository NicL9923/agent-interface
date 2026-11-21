# ios/AgentInterface/OfflineLibrary.swift, the fourth review round's fixes
MUTANTS = [
    # Finding 1: a saved departure claims no live activity, like every saved row.
    (
        "    copy.departed = departed?.mapValues(saved)",
        "    copy.departed = departed",
    ),
    # Finding 1: the departures are written at all.
    (
        "    copy.departed = departed?.mapValues(saved)",
        "    copy.departed = nil",
    ),
]
