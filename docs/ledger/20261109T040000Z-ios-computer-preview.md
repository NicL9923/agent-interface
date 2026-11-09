# November 9 iOS watch-only computer preview

Branch `parity/ios-computer-peek` on the Mac mini, iPhone 18 Pro Max simulator, iOS 27. Source
fingerprint of the tested state: sha256:a26a6613c05eb9a8911daba61f9bf3f700fee34953bd1a0ac01c21257a1f1ef1 (1644 source files) 

`ComputerPeekView` docks the web's watch-only desktop view in the chat's bottom trailing corner
through the existing `/native/computer` page with `control=0` and its own ticket.

- `VaultTests` (18 tests) and `VaultFlowTests` (14 tests): all passed, including the new
  decision-table unit test and the two new fixture flows (preview opens the computer; close hides
  it for the turn).
- Mutants applied together, each test confirmed red, then restored with `git checkout`:
  the dismissed-turn check removed (unit test and the close flow failed), and the preview's open
  action made a no-op (the tap flow failed).
- Not exercised: a real desktop connection and iPad sizing. The fixture page stands in for the
  viewer.
