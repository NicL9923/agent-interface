MUTANTS = [
    # Stopped live updates outlive the streams that stopped.
    (
        "  const liveOutage = useOutage(liveDown, true, liveScope);",
        "  const liveOutage = useOutage(liveDown, true);",
    ),
    # The live region keeps a partial return across a replaced stream.
    ("        liveScope={liveScope}\n", '        liveScope={liveStreams.join(" ")}\n'),
]
