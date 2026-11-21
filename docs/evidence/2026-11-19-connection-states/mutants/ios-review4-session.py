# ios/AgentInterface/AppStore+Session.swift, the fourth review round's fixes
MUTANTS = [
    # Finding 1: a relaunch brings back the departures it saved.
    (
        "          unconfirmedDepartures = snapshot.departed ?? [:]\n",
        "",
    ),
    # Finding 1: and their unsettled sends.
    (
        "loadPendings(knownBots)",
        "loadPendings(snapshot.bootstrap.bots)",
    ),
    # Finding 1: and reopens a saved chat on its departure's row.
    (
        "if let id = snapshot.selected, knownBot(id) != nil {",
        "if let id = snapshot.selected, bootstrap?.bots.contains(where: { $0.id == id }) == true {",
    ),
]
