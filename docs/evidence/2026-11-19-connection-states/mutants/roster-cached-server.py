MUTANTS = [
    # A cached roster says nothing.
    ("  cached.add(bots);\n", ""),
    # Only marked rows count, as before.
    (
        '  cached.has(bots) || bots.some((bot) => bot.activity === "disconnected");',
        '  bots.some((bot) => bot.activity === "disconnected");',
    ),
    # Marked lists count, but rows marked by an older runtime do not.
    (
        '  cached.has(bots) || bots.some((bot) => bot.activity === "disconnected");',
        "  cached.has(bots);",
    ),
]
