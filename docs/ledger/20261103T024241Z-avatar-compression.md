# November 2 avatar compression

Source fingerprint `sha256:01c9228b6afbf7271c73714038f3aece8b9e516c250a619f1a1166114a13c8cf`, based on main `387aeb9994c02315a27bc3b53c969a34cb2a1f24`.

Web and iOS portrait pickers accept PNG, JPEG, and WebP up to 15 MiB. Both resize to a maximum dimension of 512 pixels and encode PNG to preserve transparency, with an explicit 2,000,000-byte output check matching Hermes. Chat attachments retain their existing 20 MiB limit and detail-preserving behavior.

Application checks: all 121 Vitest files, 1,681 tests passed on Node 24.22.2. After strengthening the settings integration assertions, all 57 settings tests passed again. Type checking passed on Node 24.22.2. The production build passed. The earlier targeted run covered 231 tests including upload rules and the Hermes adapter.

Native checks: Xcode 27.2 built the app, extensions, and tests for the simulator. The selected `ShareInboxTests/testPortraitResizesAndPreservesTransparency` test passed on iPhone 18 Pro, iOS 27.0. It exercises real PNG resizing, transparency, malformed data, input above 15 MiB, and input exactly at the limit. Native builds and execution used the machine-wide heavy lock.

Local diff review found no blocking correctness issues. Independent Claude Opus 5.5 review could not run because the provider returned "Claude API rate limit reached. Try again later." Independent review remains incomplete.

No manual UI, browser, physical-device, production, or live Hermes upload acceptance was performed. The visible UI change is the portrait size hint and validation text.
