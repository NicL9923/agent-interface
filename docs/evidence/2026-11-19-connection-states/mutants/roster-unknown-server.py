MUTANTS = [
    # unknown-roster.ts: nothing is ever marked.
    ("unknown-roster.ts", "  unknown.add(bots);\n", ""),
    # hermes.ts: every cached roster is unknown.
    (
        "hermes.ts",
        "        return cacheCurrent ? rows : unknownRoster(rows);",
        "        return unknownRoster(rows);",
    ),
    # hermes.ts: no cached roster is unknown.
    (
        "hermes.ts",
        "        return cacheCurrent ? rows : unknownRoster(rows);",
        "        return rows;",
    ),
    # hermes.ts: a new connection keeps trusting the last one's roster.
    ("hermes.ts", "      cacheCurrent = false;\n", ""),
    # hermes.ts: a successful read never makes the cache current.
    ("hermes.ts", "            cacheCurrent = true;\n", ""),
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
    ("event-routes.ts", '(unknown ? "unknown:" : "") +', '("") +'),
    # event-routes.ts: a stream opened while the roster is unknown starts from a known one.
    ("event-routes.ts", "      initial.rosterUnknown,\n", "      false,\n"),
    # hermes.ts: a read from a replaced connection makes the cache current.
    (
        "hermes.ts",
        "          if (read > cachedRead && on === connection) {",
        "          if (read > cachedRead) {",
    ),
    # hermes.ts: a new connection is not counted.
    ("hermes.ts", "      connection++;\n", ""),
    # hermes.ts: the roster becoming known tells no one.
    ("hermes.ts", "              tellRosterWatchers();\n", ""),
]
