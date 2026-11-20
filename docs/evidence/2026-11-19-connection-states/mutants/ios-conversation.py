# ios/AgentInterface/AppStore+Conversation.swift
MUTANTS = [
    # A read leaves the pending retry set.
    (
        "    readRetry?.cancel()\n    readRetry = nil\n    // A draft still",
        "    // A draft still",
    ),
    # A successful read leaves the failure standing.
    (
        "      pollSucceeded(.chat)\n      conversationReadsRecovered()",
        "      pollSucceeded(.chat)",
    ),
    # One chat's failure is the app's, as before.
    ("        conversationReadFailed(id)\n", "        appUnavailable = true\n"),
]
