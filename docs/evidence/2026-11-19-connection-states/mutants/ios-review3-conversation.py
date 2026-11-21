# ios/AgentInterface/AppStore+Conversation.swift, the third review round's fixes
MUTANTS = [
    # Finding 6: an automatic read is not checked as its first request sets out.
    (
        "    if let session, !automaticReadAllowed(in: session) { return }\n    let selectedGeneration",
        "    let selectedGeneration",
    ),
    # Finding 6: its second request is not checked.
    (
        "        if let session, !automaticReadAllowed(in: session) { return }\n        response =",
        "        response =",
    ),
    # Finding 7: a history page counts as a newer refresh, so a cancelled refresh sets no retry.
    (
        "      if readFailedFor == id, refresh == conversationRefreshes {",
        "      if readFailedFor == id, read == conversationReads {",
    ),
]
