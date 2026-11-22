# ios/AgentInterface/AppStore.swift, the second review round's fixes
MUTANTS = [
    # Finding 6: a chat write posts without checking the connection again.
    ("    guard connected else { throw connectionRefused() }\n", ""),
]
