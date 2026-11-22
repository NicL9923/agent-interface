# ios/AgentInterface/AppStore+Conversation.swift, the fourth review round's fixes
MUTANTS = [
    # Finding 4: the conversation read is checked after the draft wait.
    (
        "await refreshConversation(after: draftLoad, automatic: session)",
        "await refreshConversation(after: draftLoad)",
    ),
]
