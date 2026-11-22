MUTANTS = [
    # A bootstrap that failed sets no retry.
    (
        "          setAppUnavailable(true);\n          retryLater.current();\n        }\n        return null;",
        "          setAppUnavailable(true);\n        }\n        return null;",
    ),
    # A bootstrap that found Hermes down sets no retry.
    ("        } else retryLater.current();", "        }"),
    # A success does not start the waits over.
    ("        if (well) {\n          misses.current = 0;", "        if (well) {"),
    # A success leaves the pending retry set.
    (
        "          misses.current = 0;\n          clearTimeout(retryTimer.current);",
        "          misses.current = 0;",
    ),
    # Every retry waits the first wait.
    (
        "const wait = BOOTSTRAP_RETRY_MS[misses.current++];",
        "const wait = BOOTSTRAP_RETRY_MS[0];",
    ),
    # Retries while offline.
    (
        '      if (authRef.current || document.visibilityState === "hidden" || navigator.onLine === false)\n        return;',
        '      if (authRef.current || document.visibilityState === "hidden") return;',
    ),
    # Retries while hidden.
    (
        '      if (authRef.current || document.visibilityState === "hidden" || navigator.onLine === false)\n        return;',
        "      if (authRef.current || navigator.onLine === false) return;",
    ),
    # Retries at the sign-in page.
    (
        '      if (authRef.current || document.visibilityState === "hidden" || navigator.onLine === false)\n        return;',
        '      if (document.visibilityState === "hidden" || navigator.onLine === false) return;',
    ),
    # Hermes is never recorded as reached.
    ("        if (next.connection.connected) setEverConnected(true);\n", ""),
    # A read answered after the page is gone sets a retry.
    ("    if (!mounted.current) return;\n", ""),
    # The server's disconnected rows dim the roster.
    (
        '    bot.activity === "disconnected" && before.has(bot.id)\n      ? { ...bot, activity: before.get(bot.id)! }\n      : bot,',
        "    bot,",
    ),
    # The roster is kept whole during an outage, so an assistant made private stays listed.
    (
        "  if (!next.connection.connected && !next.bots.length) return previous.bots;",
        "  if (!next.connection.connected) return previous.bots;",
    ),
    # A bootstrap that lists no roster during an outage empties it.
    (
        "  if (!next.connection.connected && !next.bots.length) return previous.bots;\n",
        "",
    ),
    # What an assistant was doing is carried however long the roster has been stale.
    ("  if (!carry) return next.bots;\n", ""),
    # A stale roster renews its own carry.
    (
        "staleSince.current = staleRoster(next) ? (staleSince.current ?? answered) : undefined;",
        "staleSince.current = staleRoster(next) ? answered : undefined;",
    ),
    # The carry counts from a stale roster long past, so the next one after a fresh roster dims at once.
    (
        "staleSince.current = staleRoster(next) ? (staleSince.current ?? answered) : undefined;",
        "staleSince.current = staleRoster(next) ? (staleSince.current ?? answered) : staleSince.current;",
    ),
    # The same stale answer is never read differently once its carry ends.
    (
        "const unchanged = lastBootstrap.current === next && carried.current === carry;",
        "const unchanged = lastBootstrap.current === next;",
    ),
    # A stale roster counts as a good bootstrap and is not read again soon.
    (
        "const well = next.connection.connected && !staleRoster(next);",
        "const well = next.connection.connected;",
    ),
]
