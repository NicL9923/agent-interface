# ios/AgentInterface/AppStore+Polling.swift
MUTANTS = [
    # The first retry after a failed bootstrap waits the healthy pace.
    (
        "    failures == 0 ? .milliseconds(1_500) : ReadRetry.delay(after: failures)",
        "    failures <= 1 ? .milliseconds(1_500) : ReadRetry.delay(after: failures)",
    ),
    # The carry runs a moment longer.
    (
        "    guard now() - since < Self.rosterCarry else { return next }",
        "    guard now() - since <= Self.rosterCarry else { return next }",
    ),
    # Each stale roster starts its own streak.
    ("    let since = staleRosterSince ?? now()", "    let since = now()"),
    # A fresh roster never ends the streak.
    (
        "    guard next.contains(where: { $0.activity == .disconnected }) else { staleRosterSince = nil; return next }",
        "    guard next.contains(where: { $0.activity == .disconnected }) else { return next }",
    ),
    # A stale roster's rows dim at once.
    (
        "          let carried = carryActivity(value.bots, from: previous.bots)",
        "          let carried = value.bots",
    ),
    # Hermes is never counted as reached.
    ("        if value.connection.connected { everConnected = true }\n", ""),
    # A household read never counts as answered.
    (
        "        bootstrapAnswered = true\n        if value.connection.connected",
        "        if value.connection.connected",
    ),
]
