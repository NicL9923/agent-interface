# ios/AgentInterface/ConversationView.swift, the third review round's fixes, through the hosted view
MUTANTS = [
    # Finding 8: a banner already showing as the chat appears is not heard.
    ("      announceBanner(store.chatErrorBanner)\n", ""),
    # Finding 8: the same banner is heard again.
    (
        "    guard visible, shown != announcedBanner else { return }",
        "    guard visible else { return }",
    ),
]
