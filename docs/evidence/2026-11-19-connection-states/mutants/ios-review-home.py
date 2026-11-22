# ios/AgentInterface/HomeStates.swift, the review's fixes
MUTANTS = [
    # Findings 1 and 5: the household's writes ignore the network.
    (
        "  var householdReachable: Bool { householdConnected && !deviceOffline }",
        "  var householdReachable: Bool { householdConnected }",
    ),
]
