MUTANTS = [
    # A return that waited on another stream is never said.
    (
        '(liveRecoveries > was.liveRecoveries || partly.current !== undefined) && live === "up"',
        'liveRecoveries > was.liveRecoveries && live === "up"',
    ),
    # Kept although a stream closed.
    (
        'if (shown || live === "closed" || partly.current !== liveScope)',
        "if (shown || partly.current !== liveScope)",
    ),
    # Kept although the streams changed.
    (
        'if (shown || live === "closed" || partly.current !== liveScope)',
        'if (shown || live === "closed")',
    ),
    # Kept through another warning.
    (
        'if (shown || live === "closed" || partly.current !== liveScope)',
        'if (live === "closed" || partly.current !== liveScope)',
    ),
    # A partial return is never held.
    (
        'if (liveRecoveries > was.liveRecoveries && live === "waiting") partly.current = liveScope;',
        "",
    ),
]
