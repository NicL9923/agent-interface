#!/usr/bin/env python3
"""Applies each hand mutation, runs the new test file, records the result, and restores the source."""
import json, pathlib, re, subprocess, sys

root = pathlib.Path(sys.argv[1])
mutations = [
    ("A failure gates any chat, not its own", "src/app/use-conversation.ts",
     'const readFailed = !!botId && readFailedFor === botId;', 'const readFailed = !!readFailedFor;'),
    ("A shown disconnection outlives its chat (`!!disconnectedFor`)", "src/app/use-conversation.ts",
     'const disconnected = !!botId && disconnectedFor === botId;', 'const disconnected = !!disconnectedFor;'),
    ("The empty state ignores the immediate fact", "src/app/Conversation.tsx",
     'disabled={!boot.capabilities.botConfiguration.supported || connectionLost}', 'disabled={!boot.capabilities.botConfiguration.supported}'),
    ("Stop gives no connection reason", "src/app/Composer.tsx",
     'title={boot.capabilities.stop.reason || connectionReason || "Stop response"}', 'title={boot.capabilities.stop.reason || "Stop response"}'),
    ("Send gives no connection reason", "src/app/Composer.tsx",
     '            title={connectionReason}\n', ''),
    ("Grace and outage reasons swapped", "src/app/Composer.tsx",
     'connectionShown ? WAITING_FOR_CONNECTION : CHECKING_CONNECTION', 'connectionShown ? CHECKING_CONNECTION : WAITING_FOR_CONNECTION'),
    ("A keyboard send refused for the connection says nothing", "src/app/Composer.tsx",
     '              else if (draft.text.trim() || draft.attachments.length) refusedForConnection();\n', ''),
    ("The status line also speaks during a shown outage", "src/app/Composer.tsx",
     'if (connectionLost && !connectionShown) setStatus(NOT_SENT_CHECKING);', 'if (connectionLost) setStatus(NOT_SENT_CHECKING);'),
    ("The status line stays once the connection notice shows", "src/app/Composer.tsx",
     '  useEffect(() => { if (connectionShown) setStatus(current => current === NOT_SENT_CHECKING ? "" : current); }, [connectionShown]);\n', ''),
    ("Every reply in a card's turn gets unavailable", "src/app/Conversation.tsx",
     'unavailable={unavailable && holdsCards(message)}', 'unavailable={unavailable}'),
    ("Every turn gets unavailable", "src/app/Conversation.tsx",
     'unavailable={unavailable && block.messages.some(holdsCards)}', 'unavailable={unavailable}'),
    ("Every turn gets disconnected", "src/app/Conversation.tsx",
     'disconnected={disconnected && [...block.tools.values()].some(message => message.toolCall?.status === "running")}', 'disconnected={disconnected}'),
    ("\"Last seen running\" follows the immediate fact", "src/app/Conversation.tsx",
     'unavailable={connectionLost} disconnected={connectionShown}', 'unavailable={connectionLost} disconnected={connectionLost}'),
    ("No failure proves the connection down", "src/app/use-conversation.ts",
     'export const provesDisconnected = (error: unknown) => navigator.onLine === false\n  || error instanceof ApiError && error.code !== undefined && hermesDown.has(error.code);', 'export const provesDisconnected = (_error: unknown) => false;'),
    ("navigator.onLine not checked", "src/app/use-conversation.ts",
     'export const provesDisconnected = (error: unknown) => navigator.onLine === false\n  ||', 'export const provesDisconnected = (error: unknown) =>'),
    ("Any API error code proves it down", "src/app/use-conversation.ts",
     'error.code !== undefined && hermesDown.has(error.code)', 'error.code !== undefined'),
    ("A second failure not enough", "src/app/use-conversation.ts",
     'if (failures > 1 || provesDisconnected(error))', 'if (failures > 2 || provesDisconnected(error))'),
    ("Grace one millisecond short", "src/app/use-conversation.ts",
     '}, DISCONNECT_GRACE_MS);', '}, DISCONNECT_GRACE_MS - 1);'),
    ("A success leaves the grace timer running", "src/app/use-conversation.ts",
     '      failures = 0;\n      stopWaiting();\n', '      failures = 0;\n'),
    ("Send and Stop gated on the shown fact", "src/App.tsx",
     'const connectionLost = session.disconnected || conversationReadFailed || offline;', 'const connectionLost = session.disconnected || conversationDisconnected || offline;'),
]
only = set(sys.argv[2:])
results = []
for name, rel, old, new in mutations:
    if only and name not in only:
        continue
    path = root / rel
    source = path.read_text()
    assert source.count(old) == 1, (name, source.count(old))
    path.write_text(source.replace(old, new))
    try:
        run = subprocess.run(["npx", "vitest", "run", "tests/connection-grace-ui.test.ts"], cwd=root, capture_output=True, text=True)
        out = run.stdout + run.stderr
        failed = [re.sub(r"\s+\d+ms$", "", line.strip()[2:]) for line in out.splitlines() if line.strip().startswith("×")]
        summary = next((line.strip() for line in out.splitlines() if line.strip().startswith("Tests ")), "?")
        results.append({"mutation": name, "summary": summary, "failed": failed})
        print(json.dumps(results[-1]), flush=True)
    finally:
        path.write_text(source)
