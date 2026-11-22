MUTANTS = [
    # A failed read promises a draft is kept.
    (
        """        : get
          ? "Can't reach the app. We'll reconnect automatically."
          : "Can't reach the app. Your draft is kept. We'll reconnect automatically.",""",
        """        : "Can't reach the app. Your draft is kept. We'll reconnect automatically.",""",
    ),
]
