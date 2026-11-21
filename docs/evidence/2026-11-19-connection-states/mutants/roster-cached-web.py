MUTANTS = [
    # The client ignores the server's word.
    (
        '  next.rosterCached === true || next.bots.some((bot) => bot.activity === "disconnected");',
        '  next.bots.some((bot) => bot.activity === "disconnected");',
    ),
    # An empty roster is kept only while Hermes is down, as before.
    (
        "  if (!next.bots.length && (staleRoster(next) || !next.connection.connected)) return previous.bots;",
        "  if (!next.bots.length && !next.connection.connected) return previous.bots;",
    ),
    # Every empty roster is kept.
    (
        "  if (!next.bots.length && (staleRoster(next) || !next.connection.connected)) return previous.bots;",
        "  if (!next.bots.length) return previous.bots;",
    ),
]
