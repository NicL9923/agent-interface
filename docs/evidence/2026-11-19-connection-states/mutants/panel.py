MUTANTS = [
    # The draft is always said to be kept.
    (
        'const kept = hasDraft ? "Your draft is kept. " : "";',
        'const kept = "Your draft is kept. ";',
    ),
    # Offline always says the draft is kept.
    (
        'detail: `${hasDraft ? "Your draft is kept on this device. " : ""}We\'ll reconnect when you\'re back online.`,',
        "detail: `Your draft is kept on this device. We'll reconnect when you're back online.`,",
    ),
    # The reason shows from the first moment.
    (
        'if (!lasting) return { title: connecting ? "Connecting…" : "Reconnecting…" };',
        "",
    ),
    # A starting server reads as a reconnect.
    (
        'if (!lasting) return { title: connecting ? "Connecting…" : "Reconnecting…" };',
        'if (!lasting) return { title: "Reconnecting…" };',
    ),
    # Stopped live updates outrank offline.
    (
        '  if (offline)\n    return {\n      title: "You\'re offline",',
        '  if (offline && !liveOnly)\n    return {\n      title: "You\'re offline",',
    ),
    # A stale setup code speaks while the app is unreachable.
    ("const hermes = !appUnavailable && !chatOnly;", "const hermes = true;"),
    # Setup is asked for by any code an object has.
    (
        '!connection.connected && Object.hasOwn(setups, connection.code ?? "");',
        '!connection.connected && (connection.code ?? "") in setups;',
    ),
    # Setup is asked for while connected.
    (
        '!connection.connected && Object.hasOwn(setups, connection.code ?? "");',
        'Object.hasOwn(setups, connection.code ?? "");',
    ),
    # The announcement doubles the title's own ending.
    (
        '[/[.…]$/.test(title) ? title : `${title}.`, detail].filter(Boolean).join(" ");',
        '[`${title}.`, detail].filter(Boolean).join(" ");',
    ),
    # The one-line notice offers a retry.
    ("          {explained && action}", "          {action}"),
    # Nobody hears that the connection is back.
    (
        '      recoveries > was.recoveries\n        ? "Connected again."',
        '      false\n        ? "Connected again."',
    ),
    # Nobody hears that live updates are back.
    (
        '        : liveRecoveries > was.liveRecoveries && liveUp\n          ? "Live updates are back."\n          : "";',
        '        : "";',
    ),
    # Live updates are said to be back whenever their notice goes.
    (
        "        : liveRecoveries > was.liveRecoveries && liveUp",
        "        : liveRecoveries > was.liveRecoveries",
    ),
    # Something that came back behind another warning is kept and said when that warning goes.
    ('    setRestored(shown ? "" : back);', "    setRestored(back);"),
    # The line that says it is back never clears.
    (
        '    if (!shown) clear.current = setTimeout(() => setRestored(""), RESTORED_MS);',
        "",
    ),
    # A chat-only failure reads as Hermes down.
    (
        '  if (chatOnly)\n    return {\n      title: "Can\'t refresh this chat",',
        '  if (false)\n    return {\n      title: "Can\'t refresh this chat",',
    ),
    # The announcement follows every draft edit.
    (
        'const news = shown ? spoken(connectionCopy({ ...state, hasDraft: false })) : "";',
        'const news = shown ? spoken(connectionCopy(state)) : "";',
    ),
    # The announcement never says the draft is kept.
    (
        'said.current = { news, text: shown ? spoken(connectionCopy(state)) : "" };',
        "said.current = { news, text: news };",
    ),
]
