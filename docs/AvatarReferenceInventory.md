# Avatar reference inventory

Observed September 29, 2026. This inventory was completed before application integration; app treatment notes were updated October 1. The standalone specimen is `/avatar-specimen/` under the Vite development server. Its artwork and motion engine are original implementation; upstream source and imagery are inspection references only.

## Sources and reuse

- [Grok Bot design article](https://x.ai/news/designing-grok-bot), its embedded geometric gallery, and its live lifecycle figure. Downloaded public HTML, CSS and the article's JavaScript chunk for inspection. Captured 18 timed motion frames, three per state. Inspection artifacts remain outside the repository at `/tmp/agent-interface-avatar-reference/`.
- [Muse introduction](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/) links to the primary [Muse design account](https://introducing.muse.ai/). The design account documents personally chosen avatars, names, and styles. Inspected the original Veda image: a knitted/plush human character with oversized glossy eyes, curly hair, scarf, jewelry and a waving hand. This establishes personal character direction, not a standardized mascot animation specification.
- [SpaceXAI terms](https://x.ai/legal/terms-of-service), updated September 11, 2026, identify ownership of the service. The article and delivered code contain no open reuse license. Publicly delivered code is not an asset reuse grant. Muse's [linked terms](https://muse.ai/terms) did not expose readable licensing terms in the inspected response; the design site has a Meta copyright notice and no open asset license. No upstream SVG paths, JavaScript implementation, portrait, video or mascot image is shipped in this app.

Reference assets are not candidates for direct reuse without an affirmative applicable license. The inspected material does not grant asset reuse rights.

## Actual controls

The Grok article's motion figure provides a pause/play lifecycle-tour button and six state tabs: Idle, Working, Waiting, Blocked, Thinking and Done. Selecting a tab pauses the automatic tour. Each tab has a duration/progress bar. The tour visits states in the listed order and advances automatically.

No shape picker, color picker, eye picker or accessory editor is exposed by the article. The gallery displays controlled shape and palette variations, and its delivered implementation exposes eye width, height, spacing, size and expression parameters. These are implementation parameters, not verified user-facing customization controls. Our customization UI is independently designed and should never be described as a reproduced Grok settings screen.

## Identity geometry and palette

The live desktop gallery contains eight silhouettes. Colors were confirmed in the delivered gallery configuration.

| Reference name | App name | Color |
| --- | --- | --- |
| Blob, nearly circular with an organic outline | Blob | `#1084FE` |
| Pebble, irregular rounded rectangle | Pebble | `#FF6700` |
| Squircle, softened square | Squircle | `#00BCA6` |
| Tablet, vertical capsule | Capsule | `#FF263C` |
| Wedge, rounded triangle | Triangle | `#FF309B` |
| Hex, rounded hexagon | Hex | `#9159FE` |
| Cloud, overlapping soft lobes | Cloud | `#FF9800` |
| Teardrop | Drop | `#97683D` |

A compact gallery shows a subset of four. The article hero also shows a neutral gray drop and black circle, so a neutral color and explicit circle shape are useful app choices. Eyes are contrasting cutouts without a conventional mouth. Common resting eyes are two upright rounded capsules; their sizes, spacing, lid opening, angle and location change with expression. The source varies eye width/height and spacing between active and emotive states, interpolated over 280 ms in the lifecycle example. It includes natural lids and minimum stroke treatments for tired expressions.

## Motion inventory

Tour dwell durations were verified in the article implementation. They are demo durations, not task durations; production state must come from the backend.

| State | Demo duration | Observed motion and transitions | Specimen treatment |
| --- | --- | --- | --- |
| Idle | 4200 ms | Calm body; slight turn/tilt, gaze and blink. Upright rounded eyes. | Breathing squash, glances that turn the face slightly, and occasional double blinks. No busy indication. |
| Working | 4600 ms | Body rotates in depth; eyes track across the curved face and vanish on the back. Small rhythmic effort motion; occasional spins produce colored trail strokes. | A 3.8 s cycle: the face scans side to side with small effort hops, then one full spin. Each eye is projected separately onto a sphere, so it compresses and disappears on the back. Trails appear only during the spin and pass behind and in front of the body. |
| Waiting | 4200 ms | Relaxed horizontal eyes, slower/drooped pose. Transition retains residual trails while settling. | Lidded eyes widen into horizontal shapes, slow breathing and a slight sag. Residual trails keep sweeping for 600 ms after any state change. |
| Blocked | 4200 ms | Body shrinks/morphs into an exclamation mark with separate circular dot. A small attention emphasis. | The body shrinks and narrows while the exclamation grows from its center, then wiggles briefly every 2.6 s. |
| Thinking | 4600 ms | Character morphs into three small animated dots. Their size/opacity changes in sequence. | The character stays visible with breathing, a gentle tilt, and an upward gaze that moves side to side. This intentionally differs from the reference dots. |
| Done | 4200 ms | Wild spin with multiple colored trails, expressive eyes; celebratory movement. | The specimen retains a 1.8 s celebration of two spins, two hops, a damped roll and wrapped trails, settling into happy eyes with a check badge. Conversations show the final reply and return the avatar to idle without a Done status. |

The article's thinking morph is intentionally distinct from applying a generic dot loader to all activity. The source combines springs, expression changes, shape interpolation, depth geometry and trails. Our implementation uses simpler independent SVG geometry and keeps the character visible during thinking, as requested for inline conversation activity. It does not copy the proprietary motion engine and is not claimed to be pixel-identical. Working needs review in motion, not only a screenshot, because a rear-face frame legitimately has no visible eyes.

Every state change also gets a short damped scale "boop". Expressions such as
eye openness, tilt, happy eyes and mascot mouth curve ease over about 90 ms
instead of snapping. The motion model is a pure module,
`src/components/avatar-motion.ts`, which tests cover. The native client mirrors
the original rig; the visible thinking character is a web treatment.

## Additional backend states

Disconnection, failure and interruption are app requirements not shown as lifecycle tabs in the reference. Disconnection halts motion and shows an unknown-activity marker. Failure retains a clear error badge and concerned face. Interruption halts motion, shows a pause mark and requires review before retry. Unknown connectivity must override any stale working state.

## Three modes and reduced motion

1. Geometric: controlled silhouette, color, eyes and accessories. These avatars carry state through expression/morph/motion, alongside an explicit status label. Each silhouette has its own face anchor, so a triangle or drop looks out from its wide base. Eye color switches to a dark ink on light custom colors.
2. Mascot: bounded original sprout/fox/bear family with ears or leaves, a muzzle, glossy eyes with highlights, cheeks and a mouth that follows the expression. This takes Muse's personal companion direction while retaining a single animatable rig. Ears and face features turn with the head. An arbitrary generated character is not automatically animated.
3. Portrait: generated or uploaded static image. It requires a separate persistent state label/indicator. A ring shows activity: a rotating arc while working, a rotating dashed ring while thinking, and a colored ring with a badge for the other non-idle states. Upload and generation need real application storage and Hermes capabilities; the specimen file picker only previews a local image.

Reduced motion stops animation-frame loops and removes trails, rotation and drift. The thinking character keeps stable eyes; explicit status text, the blocked exclamation and error/interruption badges preserve meaning. Backend state updates remain immediate. Conversations convey completion through the final reply, while the specimen retains its completion expression and badge. Failure and pending attention remain visible.

## Evidence confidence and gaps

High confidence: source controls, gallery palette and silhouettes, lifecycle mapping/dwell durations, working depth rotation, blocked/thinking morphs, completion trails, absence of an affirmative open license in inspected material.

Medium confidence: quantitative visual fidelity of original SVG proportions and simplified trajectory. Requires standalone motion review at sidebar and expanded sizes.

Not established: Muse's complete avatar customization controls or state motion. The Veda still is not animation evidence. Its product videos are available, but there is no published deterministic avatar state specification in inspected primary text. Muse-inspired family is an original design choice, not a verified reproduction of Muse animation.
