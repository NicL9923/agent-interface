# ios/AgentInterface/WidgetSync.swift, the third review round's fixes
MUTANTS = [
    # Findings 1 and 3: a connected roster from the cache rewrites the widgets, Spotlight and the pictures.
    (
        "      if !bootstrap.connection.connected || rosterFromCache {",
        "      if !bootstrap.connection.connected {",
    ),
]
