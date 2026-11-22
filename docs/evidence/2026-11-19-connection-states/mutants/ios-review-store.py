# ios/AgentInterface/AppStore+Outage.swift, the review's fixes
MUTANTS = [
    # Finding 7: the notice reads the sent copy the composer hides.
    ("    let shown = composerDraft\n", "    let shown = draft\n"),
    # Finding 3: every error is the banner's, and VoiceOver hears a failed poll in the grace period.
    (
        "    error != nil && (connectionError == nil || !(connectionCardShown || connectionPending))",
        "    error != nil",
    ),
    # Finding 2: nothing waits for the retry.
    (
        "  var chatReadWaits: Bool { readFailedFor != nil && readFailedFor == followedBotId }",
        "  var chatReadWaits: Bool { false }",
    ),
]
