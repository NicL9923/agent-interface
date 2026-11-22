# ios/AgentInterface/AppStore+Session.swift, the review's fixes
MUTANTS = [
    # Finding 2: returning to the app waits out the retry.
    (
        "    if chatReadWaits, !deviceOffline, !sessionExpired { requestConversationRefresh() }\n",
        "",
    ),
]
