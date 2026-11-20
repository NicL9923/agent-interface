MUTANTS = [
    # Every pinned assistant says the connection is lost.
    (
        '                botState !== "idle" && botState !== "done" && botState !== "disconnected";',
        '                botState !== "idle" && botState !== "done";',
    ),
]
