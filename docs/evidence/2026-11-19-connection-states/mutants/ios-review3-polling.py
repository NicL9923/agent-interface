# ios/AgentInterface/AppStore+Polling.swift, the third review round's fixes
MUTANTS = [
    # Finding 1: a cached roster's omission removes the assistant, as a connected roster's does.
    ("          if cached {\n", "          if false {\n"),
    # Finding 1: a connected roster whose rows are stale counts as fresh.
    (
        "response.value.map { !$0.connection.connected || $0.bots.contains { $0.activity == .disconnected } }",
        "response.value.map { !$0.connection.connected }",
    ),
    # Finding 1: an assistant a cached roster left out is never removed when a connected one confirms it.
    (".union(unconfirmedDepartures.keys)", ""),
    # Finding 1: a confirmed departure is removed again on every connected roster.
    (
        "            removed = Set(previous.bots.map(\\.id)).union(unconfirmedDepartures.keys).subtracting(listed)\n            unconfirmedDepartures = [:]\n",
        "            removed = Set(previous.bots.map(\\.id)).union(unconfirmedDepartures.keys).subtracting(listed)\n",
    ),
    # Finding 1: another account inherits this one's unconfirmed departures.
    (
        "          staleRosterSince = nil\n          unconfirmedDepartures = [:]\n",
        "          staleRosterSince = nil\n",
    ),
    # Finding 1: the open chat leaves for a cached roster's omission.
    (
        "      if let open = selectedBotId, !cached, !value.bots",
        "      if let open = selectedBotId, !value.bots",
    ),
    # Finding 1: the recording of an assistant a cached roster left out survives its confirmed removal.
    (
        "if let clip = voiceClipURL(botId: id)",
        "if let clip = voiceRecordingURL(botId: id)",
    ),
    # Findings 1 and 3: the widgets are not told the roster came from the cache.
    ("        rosterFromCache = cached\n", ""),
    # Finding 5: the refresh one more was asked for is checked against the running refresh's session.
    (
        "        await refreshConversation(automatic: next)",
        "        await refreshConversation(automatic: session)",
    ),
    # Finding 6: a bootstrap that answers offline opens a chat and reads it.
    (
        "      } else if !stayHome, selectedBotId == nil, automaticReadAllowed(in: generation) {",
        "      } else if !stayHome, selectedBotId == nil {",
    ),
    # Finding 6: the poll's read is not automatic.
    (
        "{ await refreshConversation(automatic: currentGeneration) }",
        "{ await refreshConversation() }",
    ),
]
