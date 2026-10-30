# Failed and interrupted turns acceptance evidence

Opus 5.5 High accepted web desktop/phone and iPhone at 9.2, iPad at 9.1.
The scoped recheck found no remaining blockers. This file records executed checks.

The app source baseline is `098c9b1`. The final browser fixture reports are
`recovery-final-before.json` and `recovery-v5-after.json`, under
`/Volumes/DevSSD/scratch/wildbots-design-review`. Each has 19 distinct screenshots
and no document overflow. They cover desktop, tablet, 390 px and 320 px phones,
light/dark, 200% text, keyboard focus, accepted/refused/unconfirmed retries,
unsupported resend, and the interruption review gate.

All 105 focused transcript and app interaction tests pass, and the production
web build passes. Browser interaction checks confirm the saved draft survives
retry, refusal appends the original message only on request, and an unconfirmed
retry reuses its request ID. The private accepted snapshot requires a reload;
this does not establish live event delivery.

Native final capture flows passed on iPhone and iPad, with nine variants and
16 screenshots each. Results are `.private/ios-test-20261026T155048Z-15908.xcresult`
and `.private/ios-test-20261026T155320Z-17266.xcresult`. The exact native fingerprint
is `565807ca2d5ccb5a5f942f1bc35fa5a8bc53bb6ede2aff7ea6abe3bfa341af53`.
The 27 transcript feature tests also passed before the later label and button
style changes. Their retry/store inputs are unchanged.

The initial visual pass exposed a truncated native AX3 acknowledgment and
4.38:1 native bordered-button contrast in light mode. The acknowledgment is
shorter and wraps fully. Recovery now uses the existing primary action style,
measuring 5.91:1 in light and 9.32:1 in dark on both devices.
`recovery-final-button-samples.txt` records coordinates and pixels.

Twelve `annotated/recovery-*.png` comparisons pair the before and after images
with numbered pointers and explanations. The full raw captures remain in
`before/` and `after/`, with `ios/` and `ipad/` subdirectories.

No physical-device, VoiceOver, hardware-keyboard or real Hermes run is claimed.

Review 14 scored web 8.5 and native 8.8. Its three blockers are addressed for
recheck. The web live region retains the same DOM node from working to failed,
including the reason. Recovery actions use the primary style, measuring 5.66:1
light and 9.32:1 dark. The native label now owns a 44 pt minimum and rectangular
hit area. Both devices pass taps in the vertical padding and far trailing blank
space, at normal, dark and AX3 sizes. Native logs include each row/text frame
and absolute tap point. The old control reported an 18 pt frame on iPhone, but
accepted the two baseline tap probes. No reproduced dead tap is claimed.

Review 15 independently reconstructed the six-file recheck patch and recomputed
both source fingerprints. Its rerun of all 105 web tests on the final source
passed in `reviews/15-opus-vitest.log`. The refused-retry annotation marker was
then moved off the text. This only changes the evidence image.
