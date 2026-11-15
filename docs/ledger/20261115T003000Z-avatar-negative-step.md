# November 15 tool-call smoke test under load

Branch `t3/svg-negative-height` from `origin/main` at `2144c0b`, on the Mac mini with Node 24.22.2. Nothing was
deployed by this entry.

## Change

Two separate full e2e runs on November 14 failed `smoke.spec.ts` "a reply keeps growing across a tool call" once on the
console error `<rect> attribute height: A negative value`, then passed on a rerun. The only computed SVG rect height in
the client is the pill eye in `src/components/Avatar.tsx`, `25 - 14 * face.dot`, which goes negative when `dot`
passes 1.79. `dot` targets are 0 or 1, so it gets there only when `approach` extrapolates. That happens with a negative
frame step: an avatar's clock starts at `performance.now()`, and the shared frame loop hands it the timestamp of a
frame that can have begun earlier, by more under load. The step is now clamped at zero where it is computed, and
`approach` treats a step of no time or a negative one as no change.

The link from the failure to this rect is inferred from the code; the failure was not reproduced on demand.

The same test failed a third time on November 15, on its own assertion instead: the first view after the tool held
"Post two" (8 characters) where it allowed "Post " (5). The scripted runtime streams a word every 200 ms, and the client
draws the deltas that arrive within one frame together, so a stalled machine shows two or three words at once. That is
correct behavior. The assertion guards against the text resuming with the chat's next read, which comes after the
stream's one-a-second change-notice throttle and so would show about five words. The bound is now the first three
words, "Post two is ", which still catches that.

## Red runs

| Break | Test | Failure |
| --- | --- | --- |
| `approach` computes `k` from a negative step again | `leaves the face where it is for a frame step of no time or a negative one` | 1 failed |

The file was restored and `tests/avatar-motion.test.ts` passed 39 of 39. The loosened e2e bound had no red run: making
the client resume from a read instead of a turn read is not a one-line break.

## Checks

`check-all --keep-going --py never` passed typecheck, lint, ruff and build, failed only the three `127.0.0.2` Vitest
tests, and failed this e2e test once on the 8-character first view before the bound changed. `check-all --only
build,e2e` then passed 55 of 55.
