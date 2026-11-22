# ios/AgentInterface/AppStore+ChatCache.swift, the fourth review round's fixes
MUTANTS = [
    # Finding 1: the saved library keeps a chat a cached roster left out.
    (
        "let allowed = Set(knownBots.map(\\.id))",
        "let allowed = Set(bootstrap.bots.map(\\.id))",
    ),
    # Finding 1: and the row it opens on after a relaunch.
    (
        "departed: unconfirmedDepartures.isEmpty ? nil : unconfirmedDepartures)",
        "departed: nil)",
    ),
    # Finding 2: nothing is saved from a roster the server never had.
    (
        "bootstrap.rosterUnknown != true, ",
        "",
    ),
    # Finding 3: the recording keeps its place for an unconfirmed departure.
    (
        "guard !sessionExpired, knownBot(botId) != nil else { return nil }",
        "guard !sessionExpired, bootstrap?.bots.contains(where: { $0.id == botId }) == true else { return nil }",
    ),
]
