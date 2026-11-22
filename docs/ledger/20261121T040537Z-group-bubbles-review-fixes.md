# November 21 group bubbles review fixes

Code state: the working tree on top of `5cc32abb` on `t3/followups-459-462`. Node v24.22.2. Hermes
did not take part. The browser checks use the e2e server with the group scripted at the network edge
(`e2e/group-fixture.ts`).

An independent review of `af8d1c38..5cc32abb` by GPT-6.2 Sol at high effort found three things to
fix in the group bubbles and one nit worth taking. This entry records the fixes and their red runs.

## What changed

- **The person's own bubble at 320 px and 200% text.** Their message is Markdown, and a quote holding
  nested lists indents by ems. Under the 86% cap the innermost list item was 2 px wide and its white
  text ran 13 px past the green fill onto the pale page. The cap is now
  `min(100%, max(86%, 16em), 560px)` in `src/components/collaboration.css`, so the bubble may use the
  whole row once the row is narrower than about 19 ems. A probe in Chromium read the innermost item
  at 2 px before and 39 px after, the same room an assistant's bubble has there.
- **The solid bubble's contrast test composited fills in the wrong order.** It painted the text
  element's own fill first and its ancestors over it. It now uses `contrastOnFill`, the reader the
  attention color test uses, which lays the fills from the outermost in.
- **No test said which edge a bubble reaches.** The contrast test now reads each bubble's gap to its
  row: the person's own within 16 px of the trailing edge and further from the leading one, everyone
  else's within 16 px of the leading edge.
- **The quote stripe in a solid bubble** was half white, 2.75:1 against the fill. It is 75% white
  now, and the test asks for 3:1.
- `README.md` no longer says group chats keep their own layout.

## Red runs

Each ran `npx playwright test --project=chromium e2e/accessibility.spec.ts -g "group"` against a
build with the named lines changed back.

| Change to the build                                              | Result                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| The cap back to `min(86%, 560px)`                                | The narrow test failed: the text ran 13 px past the bubble, expected 0 or less                         |
| The own row's `align-items` set to `flex-start`                  | All four contrast tests failed at the trailing gap: 554 px, expected under 16                          |
| The stripe back to 50% white                                     | Both solid tests failed on "quote stripe": 2.75, expected 3 or more                                    |
| A white fill on links in the own bubble, the reviewer's own case | Both solid tests failed on "link": 1, expected 4.5 or more. The old reader reported 6.01 for this case |

The first two ran in one build and the last two in another, so 5 of 7 group tests failed in the
first and 2 of 7 in the second.

## Green runs

| Check                                                                               | Result    |
| ----------------------------------------------------------------------------------- | --------- |
| `e2e/accessibility.spec.ts`, Chromium on the host                                   | 22 passed |
| `e2e/accessibility.spec.ts`, WebKit in `mcr.microsoft.com/playwright:v1.65.0-noble` | 22 passed |
| `npm run typecheck`                                                                 | compiled  |

## Not done

The review's note that `docs/native-api.md` and `docs/OpenBotDesignNotes.md` describe the iOS group
layout and the iOS vector test before iOS has them stays open until the iOS change lands on this
branch.
