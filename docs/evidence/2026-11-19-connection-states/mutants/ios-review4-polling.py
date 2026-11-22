# ios/AgentInterface/AppStore+Polling.swift, the fourth review round's fixes
MUTANTS = [
    # Finding 2: an unknown roster keeps the rows as they were, with rows or without.
    (
        "let knowsNoRoster = value.rosterUnknown ?? (!value.connection.connected && value.bots.isEmpty)",
        "let knowsNoRoster = !value.connection.connected && value.bots.isEmpty",
    ),
    # A server that says its roster is known, down and empty, is not unknown.
    (
        "let knowsNoRoster = value.rosterUnknown ?? (!value.connection.connected && value.bots.isEmpty)",
        "let knowsNoRoster = value.rosterUnknown == true || !value.connection.connected && value.bots.isEmpty",
    ),
    # An older server's empty down roster still keeps the rows.
    (
        "let knowsNoRoster = value.rosterUnknown ?? (!value.connection.connected && value.bots.isEmpty)",
        "let knowsNoRoster = value.rosterUnknown == true",
    ),
    # Finding 4: bootstrap's chat nobody tapped opens as an automatic read.
    (
        "await select(next, navigate: false, automatic: generation)",
        "await select(next, navigate: false)",
    ),
]
