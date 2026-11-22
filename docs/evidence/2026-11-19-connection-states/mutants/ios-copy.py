# ios/AgentInterface/ConversationView.swift, ConnectionCopy
MUTANTS = [
    # The draft is always kept.
    (
        '    let kept = hasDraft ? "Your draft is kept. " : ""',
        '    let kept = "Your draft is kept. "',
    ),
    # Offline always mentions the draft.
    (
        'hasDraft ? "Your draft is kept on this device. " : ""',
        '"Your draft is kept on this device. "',
    ),
    # The app being unreachable still trusts what bootstrap said of Hermes.
    ("    let hermes = !appUnavailable && !chatOnly", "    let hermes = !chatOnly"),
    # One chat's failure asks for setup.
    (
        "    if hermes, needsSetup(connection), let code",
        "    if needsSetup(connection), let code",
    ),
    # The app being unreachable says Hermes is connecting.
    (
        '    let connecting = hermes && connection?.code == "connecting"',
        '    let connecting = connection?.code == "connecting"',
    ),
    # No one-line form.
    (
        '    if !lasting { return ConnectionCopy(title: connecting ? "Connecting…" : "Reconnecting…") }',
        "",
    ),
    # One chat's failure wins over the app's.
    (
        '    if appUnavailable { return ConnectionCopy(title: "Can\'t reach the app"',
        '    if appUnavailable && !chatOnly { return ConnectionCopy(title: "Can\'t reach the app"',
    ),
    # Connected Hermes with a setup code needs setup.
    (
        "    guard let connection, !connection.connected, let code = connection.code else { return false }",
        "    guard let connection, let code = connection.code else { return false }",
    ),
    # Every title gets a period.
    (
        '    let first = title.hasSuffix(".") || title.hasSuffix("…") ? title : title + "."',
        '    let first = title + "."',
    ),
]
