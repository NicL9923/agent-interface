MUTANTS = [
    # unknown-roster.ts: nothing is ever marked.
    ("unknown-roster.ts", "  unknown.add(bots);\n", ""),
    # hermes.ts: every cached roster is unknown, as with rosterCached.
    (
        "hermes.ts",
        "        return cachedRead ? rows : unknownRoster(rows);",
        "        return unknownRoster(rows);",
    ),
    # hermes.ts: no cached roster is unknown.
    (
        "hermes.ts",
        "        return cachedRead ? rows : unknownRoster(rows);",
        "        return rows;",
    ),
    # runtime-router.ts: the router drops the mark.
    (
        "runtime-router.ts",
        "      return lists.some(([, bots]) => isUnknownRoster(bots)) ? unknownRoster(rows) : rows;",
        "      return rows;",
    ),
    # runtime-snapshot.ts: bootstrap never says it.
    (
        "runtime-snapshot.ts",
        "        rosterUnknown: isUnknownRoster(bots),\n",
        "        rosterUnknown: false,\n",
    ),
    # runtime-snapshot.ts: an unknown roster is held for reuse.
    ("runtime-snapshot.ts", "      !value.rosterUnknown &&\n", ""),
    # event-routes.ts: the roster stream's read says an unknown roster is known.
    (
        "event-routes.ts",
        "rosterUnknown: isUnknownRoster(bots) }",
        "rosterUnknown: false }",
    ),
    # event-routes.ts: learning the roster sends no notice.
    ("event-routes.ts", '(isUnknownRoster(bots) ? "unknown:" : "") +', '("") +'),
]
