# Assistant details and artifacts validation

Claude Opus 5.5 High closed the gate in review 17. Web details score 9.1 on
desktop and phone; artifacts and preview score 9.2 on desktop and 9.0 on phone.
iPhone profile/artifacts/preview score 9.1/9.1/9.0; iPad scores 9.0 for each.
The web conversation code-font change preserves its accepted 9. All five review
16 blockers are resolved, with no remaining blocker. The independent reviewer
recomputed the fingerprints and all 42 native image hashes.

The shared fixture is `.agents/fixtures/details-design.json`. Its SHA-256 is
`548b984cc72ce0fea638243ed667580cc825e2e8023b43b15fccda32151b16f5`.
All artifacts are synthetic. No provider, external file source or household
service was contacted.

Web: all 34 focused artifact, details, Markdown and font tests pass in
`details-tests-v6.log`; the production build passes in `details-build-v7.log`.
`details-before.json` has 25 baseline images. `details-v6-after.json` has 27
fresh after images with no document overflow, including blocked and failed
status. The six web comparisons were regenerated from these captures.

Selected metadata measures 4.62:1 in light mode and 4.91:1 in dark mode. At 200%
text the file icon is 40 by 52 px and its badge starts 4 px beyond its right
edge. The phone file list shows the next row. Text previews start near their
heading. The status palette now matches Home and native.

Chromium's platform-font inspection showed that the prior chat monospace stack
fell back to Courier on this Mac. Chat code and artifact previews now share an
explicit Menlo fallback. The capture reports confirm actual Menlo glyphs in
both. `conversation-details-font-after.json` adds 18 fresh conversation captures
with no page overflow and preserved clipboard, focus and composer checks.
Only this font delta needs a new conversation review.

Web source fingerprint is
`89e1421c65eae66af87e944db9b8cf87e54a3efc7df2e584d26e03cf962b0e38`.

Native baseline: iPhone `.private/ios-test-20261026T185544Z-18619.xcresult` and
iPad `.private/ios-test-20261026T185825Z-20547.xcresult` passed the capture tour,
while explicitly recording that the preview did not open. This is baseline
evidence of the product failure, not working-preview acceptance.

Final native runs each pass all seven tests, six artifact unit tests and one
five-variant capture flow:

- iPhone: `.private/ios-test-20261026T201139Z-62759.xcresult`,
  `ios-details-final-v7.log`.
- iPad: `.private/ios-test-20261026T201438Z-63728.xcresult`,
  `ipad-details-final-v2.log`.

Each device produced 21 fresh screenshots within its test-run start and finish
times. `details-native-evidence.json` records their timestamps and SHA-256 hashes.
Coverage includes normal, dark, AX3, empty and earlier-file-error layouts;
pin/follow; no results and clearing filters; the scoped 404 alert; scoped and
chat previews with actual document content, Done and native sharing controls.

The final native source fingerprint is
`25093311a89e33294f89677163d57beb87d27582b257660c89925264b5be0dc9`,
including the shared admission helper and validation scripts. Search dismissal,
20 pt file glyphs in the 24 pt column, and equal scaled profile icon frames are
built and rendered on both devices.

All fourteen comparisons in `details-annotation-manifest.json` are rendered
from these final captures. Large-text annotations now distinguish the full role
from the equal scaled icon frames. The earlier after image without Quick Look
navigation remains outside the final gallery in the reviews directory.

Both task simulators were confirmed Shutdown, with no task-owned xcodebuild
process remaining. A nonblocking probe confirmed the shared lock was free at
2026-10-26T20:17:31Z. The release was sent to the SteadLog coordinator before
annotation work. `details-heavy-release.json` records the evidence. SteadLog's
four queued Android rows have the next coordinated window.

No physical device, screen reader, external-source opening, PDF rendering, audio
or video playback acceptance is claimed.
