MUTANTS = [
    # The stop question's answer stays enabled when stopping is refused.
    ("          disabled={!!unavailable}\n", ""),
    # It says no reason in the question.
    ("          {unavailable}\n", ""),
    # The reason is not part of what the dialog is described by.
    (
        "      aria-describedby={unavailable ? `${detailId} ${reasonId}` : detailId}",
        "      aria-describedby={detailId}",
    ),
]
