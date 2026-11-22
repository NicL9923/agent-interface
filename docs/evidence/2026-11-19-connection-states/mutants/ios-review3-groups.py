# ios/AgentInterface/CollaborationViews.swift, the third review round's fixes
MUTANTS = [
    # Finding 9: a group room's Send does not check the household.
    (
        '    await run(busy: busy, error: error, household: true, failure: { $0.localizedDescription + " The message may have arrived.',
        '    await run(busy: busy, error: error, failure: { $0.localizedDescription + " The message may have arrived.',
    ),
]
