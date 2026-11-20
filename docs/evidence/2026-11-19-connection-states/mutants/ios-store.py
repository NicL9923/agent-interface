# ios/AgentInterface/AppStore+Outage.swift
MUTANTS = [
    # An offline device is no loss.
    (
        "bootstrap != nil && !sessionExpired && (deviceOffline || !householdConnected)",
        "bootstrap != nil && !sessionExpired && !householdConnected",
    ),
    # A launch from the saved copy shows its loss before any household read answers.
    ("    (bootstrapAnswered && !everConnected)\n", "    (!everConnected)\n"),
    # A loss that needs a person waits like any other.
    (
        "      || (!deviceOffline && !appUnavailable && ConnectionCopy.needsSetup(bootstrap?.connection))",
        "      || false",
    ),
    # A chat off screen is timed anyway.
    (
        '    chat.update(down: onScreen != nil && readFailedFor == onScreen, scope: onScreen ?? "", at: now)',
        '    chat.update(down: readFailedFor != nil, scope: onScreen ?? "", at: now)',
    ),
    # A chat's saved copy gets the notice too.
    (
        "bootstrap != nil && connectionShown && !(offlineSavedAt != nil && householdConnected && !deviceOffline)",
        "bootstrap != nil && connectionShown",
    ),
    # Send says it is waiting before anything shows.
    (
        "    if !connectionShown { return Self.checkingConnection }",
        "    if false { return Self.checkingConnection }",
    ),
    # Spaces count as a draft.
    (
        "(!draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty",
        "(!draft.text.isEmpty",
    ),
    # The announcement's news includes the draft, so typing repeats it.
    (
        '    let news = spoken ? connectionCopy(hasDraft: false).spoken : ""',
        '    let news = spoken ? connectionCopy(hasDraft: hasDraft).spoken : ""',
    ),
    # Something back while another loss is said is announced.
    (
        "    if recovered && !spoken { announce(Self.connectedAgain) }",
        "    if recovered { announce(Self.connectedAgain) }",
    ),
    # Nothing is announced when it comes back.
    ("    if recovered && !spoken { announce(Self.connectedAgain) }", ""),
    # Every failure in a row asks bootstrap.
    ("    let first = readFailedFor != id\n", "    let first = true\n"),
    # Failures in a row never start over.
    (
        "    readFailures = first ? 1 : readFailures + 1",
        "    readFailures = readFailures + 1",
    ),
    # Retries while the app is away.
    (
        "      guard selection == self.selectionGeneration, !self.suspended, !self.deviceOffline,",
        "      guard selection == self.selectionGeneration, !self.deviceOffline,",
    ),
    # Retries while offline.
    (
        "      guard selection == self.selectionGeneration, !self.suspended, !self.deviceOffline,",
        "      guard selection == self.selectionGeneration, !self.suspended,",
    ),
    # Retries a chat off screen.
    (
        "        self.api?.token != nil, !self.sessionExpired, self.followedBotId == id",
        "        self.api?.token != nil, !self.sessionExpired",
    ),
    # No retry at all.
    (
        "      self.requestConversationRefresh()\n    }\n    if first",
        "    }\n    if first",
    ),
    # A success leaves the failure standing.
    ("    if readFailedFor != nil { readFailedFor = nil }", ""),
]
