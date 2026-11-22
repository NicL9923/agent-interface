MUTANTS = [
    # Send always says the draft is kept.
    (
        "    connectionShown && connectionLost && (draft.text.trim() || draft.attachments.length)\n      ? WAITING_WITH_DRAFT\n      : connectionReason;",
        "    connectionShown && connectionLost ? WAITING_WITH_DRAFT : connectionReason;",
    ),
    # Send never says the draft is kept.
    ("            title={sendReason}", "            title={connectionReason}"),
]
