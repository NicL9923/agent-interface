# ios/AgentInterface/AppStore+Outage.swift, the second review round's fixes
MUTANTS = [
    # Finding 7: the banner's message is the error, shown or not.
    (
        "  var chatErrorBanner: String? { chatErrorShown ? error : nil }",
        "  var chatErrorBanner: String? { error }",
    ),
    # Finding 6: a refused write gives no reason of its own.
    (
        "    ConnectionRefused(errorDescription: connectionReason ?? Self.waitingForConnection)",
        "    ConnectionRefused(errorDescription: Self.waitingForConnection)",
    ),
    # Finding 2, the refactor: a failed read sets no retry.
    ("    readFailedFor = id\n    scheduleReadRetry(id)\n", "    readFailedFor = id\n"),
]
