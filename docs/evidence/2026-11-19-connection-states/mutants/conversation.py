MUTANTS = [
    # A failed read asks for no read of its own.
    (
        '          if (!live || document.visibilityState === "hidden" || navigator.onLine === false) return;\n          void load();',
        '          if (!live || document.visibilityState === "hidden" || navigator.onLine === false) return;',
    ),
    # Every retry waits the first wait.
    (
        "READ_RETRY_MS[Math.min(failures, READ_RETRY_MS.length) - 1],",
        "READ_RETRY_MS[0],",
    ),
    # A success does not start the waits over.
    ("    const readOk = () => {\n      failures = 0;", "    const readOk = () => {"),
    # Retries while offline.
    (
        'if (!live || document.visibilityState === "hidden" || navigator.onLine === false) return;',
        'if (!live || document.visibilityState === "hidden") return;',
    ),
    # Retries while hidden.
    (
        'if (!live || document.visibilityState === "hidden" || navigator.onLine === false) return;',
        "if (!live || navigator.onLine === false) return;",
    ),
    # A failure is not reported for its chat.
    ("      failures++;\n      setReadFailedFor(botId);", "      failures++;"),
    # A read that starts leaves the retry pending behind it.
    (
        "      loading = true;\n      // This read is the retry a failed one was waiting for: its own outcome sets the next, if any.\n      stopRetrying();",
        "      loading = true;",
    ),
]
