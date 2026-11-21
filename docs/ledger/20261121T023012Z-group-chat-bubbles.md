# November 21 group chat bubbles

Code state: the working tree on top of `acf60a48` on `t3/sync-solid-fills-group-bubbles`. Node
v24.22.2. Hermes did not take part. The browser checks use the e2e server with the group scripted
at the network edge (`e2e/group-fixture.ts`), and the visual checks use the preview app with a
synthetic group log.

Group chats now follow `chatStyle`. In Bubbles every message is laid out by `MessageMarkdown`'s
bubble runs, the person's own bubbles sit at the trailing edge in the `--user` fill, and each message
keeps its Classic speaker line. A solid bubble in a group takes the app's green, `GROUP_SOLID_FILL`
in `src/app/bot-tint.ts`, which `solid-bubble.json` now holds as a vector. Classic keeps the log
layout.

## Classic before and after

A Playwright script served the build of `af8d1c38` and this build through `preview-app.mjs` with the
same synthetic eight-event group log. It read the group panel's markup and every computed property of
its 262 elements in Classic, at 1440, 390 and 320 px, light and dark, with the tinted and the solid
bubble preference. All 12 comparisons found no difference. React's generated ids (`_r_…_`) are
normalized before comparing, because they count every `useId` call on the page; one run before
normalizing differed only in those ids on five avatar clip paths.

The script and its output are in `.private/group-bubbles/`, which Git ignores: `capture.mjs`,
`report.txt`, the screenshots, and `checks/` with 320 px, 200% text, forced colors and increased
contrast captures. None of them overflowed horizontally.

## Checks

| Check                                                                                                                              | Result                          |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `tests/group-bubbles-ui.test.ts`, `group-room-settings-ui`, `collaboration-ui`, `solid-bubble`, `motion-logic`, `message-markdown` | Unit-passed: 6 files, 203 tests |
| `e2e/accessibility.spec.ts -g group`, `e2e/cascade-layers.spec.ts -g group`, Chromium                                              | Runtime-exercised: 14 passed    |
| The same, WebKit in the Playwright 1.65.0 container, each test three times                                                         | Runtime-exercised: 42 passed    |
| `e2e/accessibility.spec.ts` and `e2e/cascade-layers.spec.ts` in full, WebKit, before the fixture fix below                         | 69 passed, 3 failed             |

The three WebKit failures came from the first version of the fixture. It opened the group with
`page.goto`, which cancelled the open chat's reads, and WebKit reported that as an uncaught error. And
with the group in the catalog from the start, home named its list "Your chats" while sign-in waited
for "Your assistants". The fixture now keeps the catalog empty until `openGroup`, which reads it again
and opens the group from its home row.

## Red runs

Each change was restored from a saved copy, and the app rebuilt, before the green runs above.

| Break                                              | Result                                                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| U1. `GroupChats` never passes `bubbles`            | Failed as intended: the Bubbles test                                                                |
| U2. `GroupChats` ignores Classic                   | Failed as intended: the Classic test                                                                |
| G1. The solid bubble's inline code rule is removed | Failed as intended in light: inline code at 1.06:1. Dark passed, since the page color there is dark |
| G2. The solid bubble's quote rule is removed       | Failed as intended: the quote at 1.07:1 in light and 2.78:1 in dark                                 |
| G3. The group's solid fill rule is removed         | Failed as intended: the fill was `#E7EEE4` in light and `#2A3A2E` in dark                           |

The cascade-layer guard's two new group screens were not broken by hand. The guard's own test,
"the guard sees generated content that only one cascade draws", shows that it detects a layer
dependency.

## Not done

- The iOS group layout in `ios/AgentInterface/CollaborationViews.swift`. `docs/native-api.md`
  describes it under "Chat style".
- Settings shows no hint under "Your messages", so no hint wording changed.
