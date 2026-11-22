MUTANTS = [
    # Grace one millisecond short.
    (
        "        ? held.since + OUTAGE_GRACE_MS\n",
        "        ? held.since + OUTAGE_GRACE_MS - 1\n",
    ),
    # A definite loss waits out the grace period like any other.
    ("  const certain = down && definite;", "  const certain = false;"),
    # Becoming definite changes nothing about where the outage stands.
    (
        '        if (held.phase === "due" || (definite && !held.lasting))',
        '        if (held.phase === "due")',
    ),
    # A loss that falls due is never shown.
    (
        '        if (held.phase === "due" || (definite && !held.lasting))',
        "        if (definite && !held.lasting)",
    ),
    # Lasting one millisecond early.
    (
        "          ? held.since + OUTAGE_LASTING_MS\n",
        "          ? held.since + OUTAGE_LASTING_MS - 1\n",
    ),
    # Never lasting.
    (
        'return { ...was, timed: held.phase === "shown" ? { ...held, lasting: true } : null };',
        'return { ...was, timed: held.phase === "shown" ? held : null };',
    ),
    # Nothing lingers.
    (
        'timed: now - held.shownAt < OUTAGE_MIN_SHOWN_MS ? { ...held, phase: "lingering" } : null,',
        "timed: null,",
    ),
    # Every notice lingers, however long it was shown.
    (
        'timed: now - held.shownAt < OUTAGE_MIN_SHOWN_MS ? { ...held, phase: "lingering" } : null,',
        'timed: { ...held, phase: "lingering" },',
    ),
    # A notice lingers a second from when the loss began, not from when it was drawn.
    (
        '              shownAt: held.phase === "shown" ? held.shownAt : now,',
        "              shownAt: held.since,",
    ),
    # A notice that becomes definite restarts its minimum time.
    (
        '              shownAt: held.phase === "shown" ? held.shownAt : now,',
        "              shownAt: now,",
    ),
    # The lingering notice never clears.
    ("          : held.shownAt + OUTAGE_MIN_SHOWN_MS;", "          : Infinity;"),
    # A loss that returns while its notice lingers starts over.
    (
        '        if (held.phase === "lingering")\n          return { ...was, timed: { ...held, phase: "shown", lasting: held.lasting || definite } };',
        '        if (held.phase === "lingering")\n          return { ...was, timed: { scope, phase: "grace", lasting: false, since: now, shownAt: now } };',
    ),
    # A lingering notice loses the form it had.
    (
        "    lasting: certain || (drawn && !!held?.lasting),",
        '    lasting: certain || (held?.phase === "shown" && held.lasting),',
    ),
    # A loss that has fallen due shows although it is no longer one.
    (
        'held?.phase === "shown" || held?.phase === "lingering" || (held?.phase === "due" && down);',
        'held?.phase === "shown" || held?.phase === "lingering" || held?.phase === "due";',
    ),
    # A loss that has fallen due waits another commit to show.
    (
        'held?.phase === "shown" || held?.phase === "lingering" || (held?.phase === "due" && down);',
        'held?.phase === "shown" || held?.phase === "lingering";',
    ),
    # A loss that ends as it falls due is drawn and counted as a recovery.
    (
        '      if (!held || held.phase === "grace" || held.phase === "due")',
        '      if (!held || held.phase === "grace")',
    ),
    # Another scope inherits the outage being timed.
    (
        "  const held = state.timed?.scope === scope ? state.timed : null;",
        "  const held = state.timed;",
    ),
    # Another scope's loss carries on from the last scope's.
    (
        "      const held = was.timed?.scope === scope ? was.timed : null;",
        "      const held = was.timed;",
    ),
    # A deadline that passed before its timer was set is dropped.
    (
        "      Math.max(0, due - Date.now()),",
        "      due > Date.now() ? due - Date.now() : 2 ** 31 - 1,",
    ),
    # A loss that never showed counts as a recovery.
    (
        '      if (!held || held.phase === "grace" || held.phase === "due")',
        '      if (!held || held.phase === "due")',
    ),
    # A loss on screen that came back is not counted.
    ("        recoveries: was.recoveries + 1,", "        recoveries: was.recoveries,"),
    # A notice running out its time counts as a second recovery.
    ('      if (held.phase === "lingering") return was;\n', ""),
    # Not said to be lingering.
    (
        '    lingering: !certain && held?.phase === "lingering",',
        "    lingering: false,",
    ),
    # The step from due to shown waits for something else to change.
    ("  }, [down, definite, scope, held?.phase]);", "  }, [down, definite, scope]);"),
]
