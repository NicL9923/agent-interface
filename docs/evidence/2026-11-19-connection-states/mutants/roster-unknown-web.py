MUTANTS = [
    # use-session.ts: the client ignores the server's word.
    (
        "use-session.ts",
        "const knowsRoster = (next: Bootstrap) => next.connection.connected && next.rosterUnknown !== true;",
        "const knowsRoster = (next: Bootstrap) => next.connection.connected;",
    ),
    # use-session.ts: an unknown roster replaces the rows.
    (
        "use-session.ts",
        "  if (next.rosterUnknown === true || (!next.connection.connected && !next.bots.length))",
        "  if (!next.connection.connected && !next.bots.length)",
    ),
    # use-session.ts: a first unknown bootstrap ignores the saved home.
    (
        "use-session.ts",
        "    return next.rosterUnknown === true && saved ? saved : next.bots;",
        "    return next.bots;",
    ),
    # use-session.ts: the hint's chats are rewritten from an unknown roster.
    (
        "use-session.ts",
        "        if (knowsRoster(next))\n",
        "        if (next.connection.connected)\n",
    ),
    # use-session.ts: the open chat is reported gone on an unknown roster.
    (
        "use-session.ts",
        "        if (knowsRoster(next) && open && !next.bots.some((bot) => bot.id === open))",
        "        if (next.connection.connected && open && !next.bots.some((bot) => bot.id === open))",
    ),
    # use-session.ts: the selection moves on an unknown roster.
    (
        "use-session.ts",
        "          if (!knowsRoster(next)) return previous;",
        "          if (!next.connection.connected) return previous;",
    ),
    # App.tsx: no saved roster is offered.
    (
        "App.tsx",
        "      savedRoster: (user) => (saved?.user === user ? savedHome(saved).bots : undefined),",
        "      savedRoster: () => undefined,",
    ),
]
