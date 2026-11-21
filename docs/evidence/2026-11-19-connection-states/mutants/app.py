MUTANTS = [
    # A lost connection keeps the transcript's activity row.
    (
        'const showActivity = state !== "idle" && state !== "done" && state !== "disconnected";',
        'const showActivity = state !== "idle" && state !== "done";',
    ),
    # One chat's failed reads show every assistant as disconnected.
    (
        "        state={listed}\n        connectionLost={appShown}",
        "        state={listed}\n        connectionLost={connectionShown}",
    ),
    # One chat's failed reads dim that assistant in the list.
    (
        "        state={listed}\n        connectionLost={appShown}",
        "        state={state}\n        connectionLost={appShown}",
    ),
    # Live updates already down do not skip the grace period.
    (
        "    liveDown ||\n      !session.everConnected ||",
        "    !session.everConnected ||",
    ),
    # A first bootstrap that finds Hermes down waits out a grace period.
    (
        "    liveDown ||\n      !session.everConnected ||\n      (!offline",
        "    liveDown ||\n      (!offline",
    ),
    # A connection that needs a person waits out a grace period.
    (
        "      (!offline && !appUnavailable && !!boot && needsSetup(boot.connection)),",
        "      false,",
    ),
    # A failed read does not ask bootstrap what is down.
    ("    if (conversationReadFailed) void refreshNow();", ""),
    # A chat failing behind Today or a phone's home list is timed, and said, as if it were on screen.
    (
        '    conversationReadFailed && chatOnScreen,\n    liveDown,\n    chatOnScreen ? botId : "",',
        '    conversationReadFailed,\n    liveDown,\n    chatOnScreen ? botId : "",',
    ),
    # Leaving a chat for Today keeps its outage, so its notice lingers there and its end is announced.
    (
        '    conversationReadFailed && chatOnScreen,\n    liveDown,\n    chatOnScreen ? botId : "",',
        "    conversationReadFailed && chatOnScreen,\n    liveDown,\n    botId,",
    ),
    # A phone's home list counts as the chat being on screen.
    (
        "const chatOnScreen = inChat && !(mobile && railOpen);",
        "const chatOnScreen = inChat;",
    ),
    # Today counts as the chat being on screen.
    (
        "const chatOnScreen = inChat && !(mobile && railOpen);",
        "const chatOnScreen = !(mobile && railOpen);",
    ),
    # The live-updates notice stays out a minimum time it was never on screen for.
    (
        "    if (connectionShown || liveDown)\n      items.push({",
        "    if (connectionShown || liveOutage.shown)\n      items.push({",
    ),
    # The live region is not told whether the streams are up.
    ("        liveUp={liveUp}\n", ""),
    # The live region is told of no return of live updates.
    ("        liveRecoveries={liveOutage.recoveries}\n", ""),
    # The live region keeps saying the loss while its notice lingers.
    (
        "const appLoss = appShown && !appOutage.lingering;\n  const lossSpoken = appLoss || (chatOutage.shown && !chatOutage.lingering);",
        "const appLoss = appShown;\n  const lossSpoken = appLoss || chatOutage.shown;",
    ),
    # The live region is told of no recovery.
    ("        recoveries={appOutage.recoveries + chatOutage.recoveries}\n", ""),
    # The notice always says the draft is kept.
    (
        "    inChat && draft.botId === botId && (!!draft.text.trim() || draft.attachments.length > 0);",
        "    true;",
    ),
    # Today's notice speaks of the chat's draft.
    (
        "    inChat && draft.botId === botId && (!!draft.text.trim() || draft.attachments.length > 0);",
        "    draft.botId === botId && (!!draft.text.trim() || draft.attachments.length > 0);",
    ),
    # Offline is said in the views before the loss shows.
    ("const offlineShown = offline && appShown;", "const offlineShown = offline;"),
    # The notice never reaches its lasting form.
    (
        "const lasting = appShown ? appOutage.lasting : chatOutage.lasting;",
        "const lasting = false;",
    ),
    # A chat-only loss reads as an app loss.
    (
        "            chatOnly={!appShown}\n            liveOnly={!connectionShown}\n            lasting={lasting}\n            hasDraft={hasDraft}\n            busy",
        "            chatOnly={false}\n            liveOnly={!connectionShown}\n            lasting={lasting}\n            hasDraft={hasDraft}\n            busy",
    ),
    # A lingering notice lifts the composer's gates.
    (
        'const reported: ActivityState = connectionShown && connectionLost ? "disconnected" : known;',
        'const reported: ActivityState = connectionShown ? "disconnected" : known;',
    ),
    # One chat's loss carries into the next chat.
    (
        '    conversationReadFailed && chatOnScreen,\n    liveDown,\n    chatOnScreen ? botId : "",',
        '    conversationReadFailed && chatOnScreen,\n    liveDown,\n    "",',
    ),
    # The stop question's answer is not refused.
    (
        """          unavailable={
            connectionLost
              ? connectionShown
                ? WAITING_FOR_CONNECTION
                : CHECKING_CONNECTION
              : undefined
          }""",
        "          unavailable={undefined}",
    ),
]
