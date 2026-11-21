# ios/AgentInterface/Models.swift, the fourth review round's fixes
MUTANTS = [
    # Finding 2: a roster the server never had is not a fresh one.
    (
        "    rosterUnknown == true || !connection.connected || bots.contains { $0.activity == .disconnected }",
        "    !connection.connected || bots.contains { $0.activity == .disconnected }",
    ),
    # An older server's marked rows still say the roster is cached.
    (
        "    rosterUnknown == true || !connection.connected || bots.contains { $0.activity == .disconnected }",
        "    rosterUnknown == true || !connection.connected",
    ),
]
