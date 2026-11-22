# ios/AgentInterface/RootView.swift, the second review round's fix
MUTANTS = [
    # Finding 5: one failed chat disables New group chat.
    (
        "GroupRows.creationHint(store.groupCatalog, connected: store.householdReachable)",
        "GroupRows.creationHint(store.groupCatalog, connected: store.connected)",
    ),
]
