# November 8 chat cards follow-up rounds

Code state `b26e69b7` on `t3/t3code-mcp-chat-integrations`. This covers the rounds after
`6107014`, each started by a cross-provider review from Patch or the T3 Code agent, both
GPT-6.1 Sol at high effort. Web checks ran on NicolasLaptop (Node 24.22.2). iOS checks ran
on the Mac mini (Xcode 27.2, iPhone 17 simulator, iOS 27.0) over NicolasLaptop's own key.
No live Hermes, T3 Code connection or physical device was exercised.

- `aa56279`: iOS options compare by exact code units, and the form-key secret is created when
  the store opens. The lock test fails with "database is locked" against the parent. Swapping
  Swift's canonical `contains` back in failed the selection test.
- `846ec70`: a stale copy can no longer undo another copy's progress (`mayReplace`). The web
  test that types after a late refusal fails against `aa56279`. Restoring the attempt-only
  rule failed 5 iOS table cases.
- `9310503`: `GET /submissions/:id` returns the recorded text, to the sender only. The card
  shows its own answers as sent only when the text matches. Four mutations, covering text
  comparison, known-answer precedence, sender-only text and live-receipt text, each failed a
  test.
- `4a8d12e`: interrupted ranks above sent, and known answers are kept. The reload test fails
  against `9310503`.
- `b26e69b`: `nextRecord` merges admitted answers into an elsewhere record in either order.
  The reload and Edit-and-send-again test fails against `4a8d12e`.

At `b26e69b`: `npm test` 149 files and 2,074 tests passed, and typecheck and lint passed. On
iOS, ReplyActionCardsTests (11), ContractFixtureTests and ChatCardsFlowTests passed. The final
review found nothing reachable with a single copy, no leak and no duplicate admission. Its one
multi-copy display finding is #266, tracked as a follow-up and not blocking the release.
