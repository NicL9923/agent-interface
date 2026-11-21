MUTANTS = [
    # Bootstrap never says the roster is cached.
    ("        rosterCached: isCachedRoster(bots),\n", "        rosterCached: false,\n"),
    # A cached roster is held like a fresh one.
    (
        "      value.connection.connected && !value.rosterCached ? { value, at: startedAt }",
        "      value.connection.connected ? { value, at: startedAt }",
    ),
]
