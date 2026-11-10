# Applies the failed-read probe to a checkout: counts turn renders, Markdown parses and reply action
# rows, and wraps the transcript in a Profiler. Run from the repository root.
def edit(p, old, new):
    s = open(p).read()
    assert s.count(old) == 1, (p, old)
    open(p, "w").write(s.replace(old, new))
edit("src/app/Conversation.tsx", 'import "./transcript.css";\n', 'import "./transcript.css";\nimport { count } from "../probe";\n')
s = open("src/app/Conversation.tsx").read()
i = s.index("const TurnView = memo(function TurnView(")
j = s.index("{\n", i) + 2
open("src/app/Conversation.tsx", "w").write(s[:j] + '  count("TurnView.body");\n' + s[j:])
edit("src/components/MessageMarkdown.tsx", "  const context = useMemo(() => ({ text, inlineUi, actionableIds:", '  count("MarkdownBlocks.body");\n  const context = useMemo(() => ({ text, inlineUi, actionableIds:')
s = open("src/components/MessageMarkdown.tsx").read()
open("src/components/MessageMarkdown.tsx", "w").write('import { count } from "../probe";\n' + s)
s = open("src/app/ReplyActions.tsx").read()
open("src/app/ReplyActions.tsx", "w").write('import { count } from "../probe";\n' + s)
edit("src/App.tsx", 'import { useCallback, useEffect, useMemo, useRef, useState } from "react";', 'import { Profiler, useCallback, useEffect, useMemo, useRef, useState } from "react";\nimport { rendered } from "./probe";')
edit("src/App.tsx", "          <Conversation boot={boot}", '          <Profiler id="conversation" onRender={rendered}><Conversation boot={boot}')
edit("src/App.tsx", "            onDraft={addToDraft} onCreate={newBot} />\n", "            onDraft={addToDraft} onCreate={newBot} /></Profiler>\n")
edit("vite.config.ts", 'resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },', 'resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)), ...process.env.PROBE ? { "react-dom/client": "react-dom/profiling" } : {} } },')
edit("src/app/ReplyActions.tsx", "function MessageActions({ message }: { message: Message }) {\n", 'function MessageActions({ message }: { message: Message }) {\n  count("MessageActions.body");\n')
