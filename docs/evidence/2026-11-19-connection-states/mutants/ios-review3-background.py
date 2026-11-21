# ios/AgentInterface/BackgroundRefresh.swift, the third review round's fixes
MUTANTS = [
    # Finding 3: a background read writes a roster from the server's cache.
    (", !bootstrap.bots.contains(where: { $0.activity == .disconnected })", ""),
]
