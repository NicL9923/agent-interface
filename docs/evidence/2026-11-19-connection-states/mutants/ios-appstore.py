# ios/AgentInterface/AppStore.swift
MUTANTS = [
    # A chat's failed read gates nothing.
    (
        '&& !cachedChats.contains(selectedBotId ?? "") && !chatReadFailed',
        '&& !cachedChats.contains(selectedBotId ?? "")',
    ),
    # The chat shows the loss from the first moment.
    (
        "    let next: ActivityState = !connected && (untimed || connectionShown) ? .disconnected : known",
        "    let next: ActivityState = !connected ? .disconnected : known",
    ),
    # Home lists the chat's own loss.
    (
        "    if known != listedActivity { listedActivity = known }",
        "    if activity != listedActivity { listedActivity = activity }",
    ),
    # Coming back online waits out the retry.
    (
        "      if !deviceOffline, readFailedFor != nil, readFailedFor == followedBotId { requestConversationRefresh() }\n",
        "",
    ),
]
