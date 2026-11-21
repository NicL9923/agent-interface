# ios/AgentInterface/AppStore+Polling.swift, the second review round's fixes
MUTANTS = [
    # Finding 1: the poll reads the chat after its bootstrap whatever happened meanwhile.
    (
        ", !chatReadWaits, automaticReadAllowed(in: currentGeneration) {",
        ", !chatReadWaits {",
    ),
    # Finding 1: a queued refresh reads whatever happened since it was asked for.
    ("        guard automaticReadAllowed(in: session) else { break }\n", ""),
    # Finding 1: each condition of an automatic read.
    ("    !Task.isCancelled && !suspended", "    !suspended"),
    ("!suspended && !deviceOffline", "!suspended"),
    (
        "!suspended && !deviceOffline && generation == session",
        "!suspended && !deviceOffline",
    ),
    ("&& generation == session && api?.token != nil", "&& generation == session"),
    ("api?.token != nil && !sessionExpired", "api?.token != nil"),
    # Finding 3: only a connected roster's removal closes the open chat.
    (
        "value.connection.connected || removed.contains(open),",
        "value.connection.connected,",
    ),
    # Finding 4: delivered notifications stay with an assistant that left.
    ("            removeDeliveredChats(removed)\n", ""),
]
