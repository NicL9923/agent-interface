# ios/AgentInterface/AppStore.swift, the review's fixes
MUTANTS = [
    # Finding 1: the chat's writes ignore the network.
    (
        '    householdReachable && !cachedChats.contains(selectedBotId ?? "") && !chatReadFailed',
        '    householdConnected && !cachedChats.contains(selectedBotId ?? "") && !chatReadFailed',
    ),
    # Finding 2: coming back online reads while the app is away.
    (
        "      if !deviceOffline, !suspended, chatReadWaits { requestConversationRefresh() }",
        "      if !deviceOffline, chatReadWaits { requestConversationRefresh() }",
    ),
    # Finding 4: the outages see the bootstrap and the availability flag apart, so an app loss that
    # turns into a Hermes loss starts its grace period over.
    ("    guard !activityHeld else { return }\n", ""),
    # Finding 8: the activity row comes back while the notice lingers.
    (
        "  var activityRowShown: Bool { !connectionShown && ![.idle, .done, .disconnected].contains(activity) }",
        "  var activityRowShown: Bool { ![.idle, .done, .disconnected].contains(activity) }",
    ),
]
