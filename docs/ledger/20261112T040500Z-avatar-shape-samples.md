# November 12 avatars sample each shape once

Branch `t3/36e26aad` over `origin/main` at `1e3cb31`, on NicolasLaptop (Fedora 44, Linux x64), Node 24.22.2.
Nothing was deployed.

## Defect

Profiled in Chromium against production (release `f30d06d`) with a temporary session, since removed. `getPointAtLength`
was the largest main-thread cost of loading the app: 458 ms on a desktop home load (38 path samplings, 2,736 calls),
3,174 ms on home and 1,925 ms opening a chat with 4x CPU throttling, and about 2.0 s of self time in a phone CPU
profile of opening `patch` or `wft-marketing`, more than JSON parsing, Markdown and React together.

`useShapeTransition` in `src/components/Avatar.tsx` sampled its shape 72 times on mount, again in its effect, and then
ran a 280 ms transition from the shape to itself.

## Change

Samples are kept per path in a module map of at most 256 shapes; the avatar editor makes a new shape per change. A
mounting avatar's effect finds its own samples already drawn and runs no transition.

## Tests and red run

`tests/avatar-component.test.ts` "samples a shape once however many avatars draw it": twenty avatars of one shape
call `getPointAtLength` at most 72 times. With the map lookup removed: `expected 2880 to be less than or equal to 72`.
The avatar component, motion, art parity and editor suites pass (132 tests).

Not exercised: a production phone measurement after the change.
