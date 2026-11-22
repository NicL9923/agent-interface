# ios/AgentInterface/AppStore.swift, the third review round's fixes
MUTANTS = [
    # Finding 4: an assistant's settings wait for the open chat.
    (
        "    guard gate == .household ? householdReachable : connected else",
        "    guard connected else",
    ),
    # Finding 4: a write in the open chat waits only for the household.
    (
        "    guard gate == .household ? householdReachable : connected else",
        "    guard householdReachable else",
    ),
    # Finding 1: the open chat a cached roster left out has no row, and its view is blank.
    (
        "    bootstrap?.bots.first { $0.id == selectedBotId } ?? selectedBotId.flatMap { unconfirmedDepartures[$0] }",
        "    bootstrap?.bots.first { $0.id == selectedBotId }",
    ),
]
