# ios/AgentInterface/AgentInterfaceApp.swift, the third review round's fixes
MUTANTS = [
    # Finding 2: a removal clears every account's delivered notifications for the assistant.
    ('    userInfo["account"] as? String == account && chatBotId', "    chatBotId"),
]
