# November 15 avatar frame step never negative

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

The same test failed a third time on November 15 on its own assertion: the first view after the tool held
"Post two" (8 characters) where it allows "Post " (5), because the client draws deltas that arrive within one frame
together and the machine was loaded. A first version of this change allowed three words. GPT-6.1 Sol's review showed
that a resume from the chat's next read can surface exactly "Post two is " at about 2.3 s, so a looser bound cannot tell
the two paths apart. The bound stays as it was; separating them needs fixture timing that other e2e tests share, which
is left for its own change.

## Red runs

| Break                                              | Test                                                                        | Failure  |
| -------------------------------------------------- | --------------------------------------------------------------------------- | -------- |
| `approach` computes `k` from a negative step again | `leaves the face where it is for a frame step of no time or a negative one` | 1 failed |

The file was restored and `tests/avatar-motion.test.ts` passed 39 of 39.

## Checks

`check-all --keep-going --py never` passed typecheck, lint, ruff and build, failed only the three `127.0.0.2` Vitest
tests, and failed this e2e test once on the 8-character first view. `check-all --only build,e2e` then passed 55 of 55.
