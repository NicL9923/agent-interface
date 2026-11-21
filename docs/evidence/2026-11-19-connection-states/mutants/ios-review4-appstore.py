# ios/AgentInterface/AppStore.swift, the fourth review round's fixes
MUTANTS = [
    # A departure is an assistant this person may still have.
    (
        "func knownBot(_ id: String) -> Bot? { bootstrap?.bots.first { $0.id == id } ?? unconfirmedDepartures[id] }",
        "func knownBot(_ id: String) -> Bot? { bootstrap?.bots.first { $0.id == id } }",
    ),
    # The known roster adds the departures.
    (
        "    return listed + unconfirmedDepartures.values.filter { !ids.contains($0.id) }.sorted { $0.id < $1.id }",
        "    return listed",
    ),
    # Read marks are kept for a departure.
    (
        "    next.keep(knownBots, user: bootstrap?.user.id)",
        "    next.keep(bootstrap?.bots ?? [], user: bootstrap?.user.id)",
    ),
]
