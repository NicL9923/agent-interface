MUTANTS = [
    # A lost connection puts a badge on a portrait.
    (
        '    state !== "disconnected" &&\n    (avatar.mode === "portrait"',
        '    (avatar.mode === "portrait"',
    ),
]
