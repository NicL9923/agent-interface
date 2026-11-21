MUTANTS = [
    # A roster cached because the socket is down is not marked.
    (
        '        return cachedRoster(botCache.map((row) => ({ ...row, activity: "disconnected" as const })));',
        '        return botCache.map((row) => ({ ...row, activity: "disconnected" as const }));',
    ),
    # A roster cached because profiles.list failed is not marked.
    (
        '          return cachedRoster(\n            botCache.map((row) => ({ ...row, activity: "disconnected" as const })),\n          );',
        '          return botCache.map((row) => ({ ...row, activity: "disconnected" as const }));',
    ),
]
