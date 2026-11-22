# ios/AgentInterface/DraftAdditions.swift, the fourth review round's fixes
MUTANTS = [
    # Text waiting for a departure waits on.
    (
        "      let bots = knownBots",
        "      let bots = bootstrap?.bots ?? []",
    ),
]
