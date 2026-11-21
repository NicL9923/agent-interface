# ios/AgentInterface/BackgroundRefresh.swift, the fourth review round's fixes
MUTANTS = [
    # Finding 2: the background read skips a roster the server never had.
    (
        "guard !Task.isCancelled, !bootstrap.servedFromCache else",
        "guard !Task.isCancelled, bootstrap.connection.connected, !bootstrap.bots.contains(where: { $0.activity == .disconnected }) else",
    ),
]
