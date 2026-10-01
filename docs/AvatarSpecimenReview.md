# Standalone avatar review

Reviewed before main application integration on September 29, 2026. Specimen entry: `avatar-specimen/index.html`; run `npm run dev:client` and open `/avatar-specimen/`.

The orchestrator reviewed the rendered standalone specimen at 1280 px/light and 390 px/dark alongside the actual x.ai lifecycle demo. The geometric gallery, colors, working motion and state controls were readable and usable. Both reviewers found no horizontal overflow. Reduced motion froze the SVG DOM over a 400 ms observation while preserving the correct state label and expression.

The review requested refinements before full integration:

- Preserve an outgoing blocked/thinking symbol during the transition back to a character. Implemented by retaining the rendered symbol until its opacity falls away.
- Interpolate silhouette changes rather than snapping. Implemented by sampling original paths and interpolating 72 points over 280 ms. Color fill transitions also use 280 ms; eye preset changes fade in over that duration.
- Add dimension and spacing customization based on observed eye parameters. Optional width/height/spacing parameters are supported by the avatar rig and app controls.
- Make completion visibly spin in multiple dimensions. The brief celebration now combines horizontal face rotation, body pitch and roll with orbital colored trails, then settles.
- Let waiting settle active trails. Trails fade for 600 ms on the working/done to waiting transition.
- Avoid continuous work for avatars that are offscreen or have unknown activity. IntersectionObserver stops frame loops offscreen. Portraits, disconnection, interruption, failure and reduced motion stop activity loops.

Initial standalone browser checks passed: working state selection, stable reduced-motion SVG, phone/desktop overflow, dark theme, blocked and disconnected accessible labels. Screenshots were inspected at `/tmp/avatar-specimen-desktop.png` and `/tmp/avatar-specimen-phone-dark.png`; these are local evidence, not shipped reference assets. The main app needs visual and interaction checks against its final code state.

Approximation remains in independent geometry and motion trajectories; there is no claim of pixel identity. Muse's full state motion remains unverified and the mascot family is original artwork. Physical phone and installed PWA acceptance are separate from browser viewport checks.

## October 1 rework

The rig was reworked against the same inventory after a review of the shipped
avatars at sidebar size. The baseline showed four problems. Thinking and blocked
symbols were faint enough that an assistant looked missing from the list.
Working spun continuously and slid flat eyes across the face. Eyes ignored each
silhouette's visual center. Mascots were flat.

Changes:

- Working now scans and spins only occasionally, which is closer to the
  reference. Each eye is projected separately for real parallax, and trails pass
  behind and in front of the body.
- The dots and exclamation are larger and stronger. The body shrinks and fades
  while the symbol grows from its center. Thinking dots brighten in sequence.
- Expressions ease between states. Done ends in happy eyes. Failed looks worried
  rather than squinting. Waiting eyes widen as they close.
- Mascots have ears, muzzles, glossy eyes, cheeks and expressive mouths.
- Portraits get a state ring. Badges are drawn SVG icons instead of text glyphs.
- The specimen adds a state matrix of eight configurations in all nine states.

Checked in Chromium at 1200 px with motion and with reduced motion, and from
frame strips sampled every 160 to 330 ms. Reduced motion and the frozen states
(disconnected, interrupted) return the resting pose; `tests/avatar-motion.test.ts`
covers this and the working, done and blink timing.
