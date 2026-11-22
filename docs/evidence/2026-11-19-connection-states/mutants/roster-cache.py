MUTANTS = [
    # Only a read nothing invalidated fills the cache, as before.
    (
        "          if (read > cachedRead) {",
        "          if (rosterRequest === request && read > cachedRead) {",
    ),
    # An older read that answers last overwrites a newer one.
    ("          if (read > cachedRead) {", "          if (true) {"),
]
