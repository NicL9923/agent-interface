# ios/AgentInterface/AppStore+Polling.swift, the review's fixes
MUTANTS = [
    # Finding 2: the poll reads a failed chat on every pass.
    (
        "    if followedBotId != nil, conversationDue, !chatReadWaits { await refreshConversation() }",
        "    if followedBotId != nil, conversationDue { await refreshConversation() }",
    ),
    # Finding 6: a Hermes-down roster keeps the previous one whole.
    (
        "          value.bots = !value.connection.connected && value.bots.isEmpty ? previous.bots : carried",
        "          value.bots = !value.connection.connected ? previous.bots : carried",
    ),
    # Finding 6: a Hermes-down roster that lists nobody empties home.
    (
        "          value.bots = !value.connection.connected && value.bots.isEmpty ? previous.bots : carried",
        "          value.bots = carried",
    ),
    # Finding 6: a Hermes-down roster carries no activity.
    (
        "          let carried = carryActivity(value.bots, from: previous.bots)",
        "          let carried = value.connection.connected ? carryActivity(value.bots, from: previous.bots) : value.bots",
    ),
    # Finding 6: an assistant that left while Hermes is down keeps its saved chat.
    (
        "        if let previous = bootstrap, previous.user.id == value.user.id,\n          Set(",
        "        if let previous = bootstrap, previous.user.id == value.user.id, value.connection.connected,\n          Set(",
    ),
    # Finding 6: while Hermes is down, an open chat off the roster is replaced by another.
    (
        "      } else if !stayHome, selectedBotId == nil {",
        "      } else if !stayHome, selectedBotId == nil || !value.bots.contains(where: { $0.id == selectedBotId }) {",
    ),
    # Finding 4: the availability flag clears after the bootstrap is applied.
    (
        "        activityHeld = true\n        if appUnavailable { appUnavailable = false }\n",
        "        activityHeld = true\n",
    ),
]
