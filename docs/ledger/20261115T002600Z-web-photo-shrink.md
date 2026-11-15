# November 14 web photo shrink and HEIC attach

Branch `t3/web-image-upload-optimization` from `origin/main` at `c4cdcdb2`, on the Mac mini with Node 24.22.2. Nothing was
deployed by this entry.

## Change

The composer decodes a JPEG or WebP of 1 MB or more with `createImageBitmap` (EXIF rotation applied), caps the long edge
at 2048 px, and re-encodes at quality 0.85 as WebP, or JPEG where the browser cannot encode WebP. HEIC and HEIF are
accepted and always converted, or refused with a reason when the browser cannot decode them. GIFs, PNGs, and JPEG or
WebP under 1 MB go as they are, and so does a JPEG or WebP the browser cannot decode. The shrunk size is recorded with
`rememberImageSize` when the upload finishes. `src/shared/uploads.ts` and the server route are unchanged apart from one
exported size-error helper.

## Red runs

Each break was applied by hand, the tests were run, and the file was restored byte for byte.

| Break | Test | Failure |
| --- | --- | --- |
| `needsPreparation` uses `>` instead of `>=` at 1 MB | `which images are shrunk` JPEG and WebP from 1 MB | 2 failed |
| PNG added to the formats that are shrunk | `which images are shrunk` large PNG; `never decodes a PNG screenshot`; e2e left-alone test | 2 unit, 1 e2e |
| GIF added to the formats that are shrunk | `which images are shrunk` large GIF; `never decodes a GIF` | 2 failed |
| `imageOrientation` set to `"none"` | `decodes with the EXIF rotation applied` | 1 failed |
| `imageOrientation` set to `"flipY"` | e2e `a phone photo uploads at 2048 px, upright` (red corner not top-right) | 1 failed |
| `fitWithin` may scale up | `the shrunk size` 1000 by 500 | 1 failed |
| `MAX_IMAGE_EDGE` 4096 | e2e phone photo | 1 failed |
| `IMAGE_QUALITY` 1 | e2e phone photo (size under a third of the original) | 1 failed |
| HEIC no longer always converted | `converts a HEIC photo even when the result is larger` | 2 failed |
| A larger result is sent | `sends the original ... when shrinking would not make it smaller` | 1 failed |
| A JPEG that cannot decode is refused | four `optimizeImage` fallback tests | 4 failed |
| WebP probe always true | `falls back to JPEG, on white` | 1 failed |
| White fill under JPEG removed | `falls back to JPEG, on white` | 1 failed |
| Oversized HEIC size check removed | `refuses an oversized HEIC` | 1 failed |
| `.heif` extension not recognized | `imageKind` table, `lets HEIC through` | 2 failed |
| Extension overrides a real, non-empty type | `imageKind` IMG_1.heic as application/pdf | 1 failed |
| Shrunk size not recorded | `uploads the shrunk file, and reserves its size` | 1 failed |
| A retry shrinks the file again | `retries a failed upload with the shrunk file` | 1 failed |
| `preparing` status not set | `keeps Send unavailable while the photo is being prepared` | 1 failed |
| Refused HEIC's chip stays | `explains a HEIC photo the browser cannot open` | 1 failed |
| Refusal not reported | `explains a HEIC photo the browser cannot open` | 1 failed |
| Picker `accept` drops HEIC | `offers HEIC files in the file picker` | 1 failed |

The first run of the `.heic` extension and the retry breaks survived. The first needed a row with a non-empty type that is
not an image, and the second needed a shrunk file of 1 MB or more so the size rule was not the one stopping it. Both
tests were tightened and went red. In Chromium, `imageOrientation: "none"` still honors EXIF, which is why the e2e needs
the `"flipY"` break instead.

## Not exercised in the committed suite

Chromium cannot decode HEIC, so the committed e2e covers only the refusal. A one-off run in Playwright WebKit, outside the
repository's config, attached a real 608 byte HEIC made with `sips`; it uploaded as `IMG_9.jpg` (1,297 bytes, JPEG because
Safari cannot encode WebP). The phone-photo e2e also ran in WebKit and passed except for its expectation of WebP, which
Safari answers with JPEG as designed. Not run on a physical iPhone or Android.

## Checks

`E2E_PORT=4773 .agents/tools/check-all --keep-going` on the rebased branch: typecheck, lint, ruff and build passed;
e2e passed 58 of 58; Python passed 52 files; Vitest ran 4000 tests and failed 3, all on the missing `127.0.0.2` loopback
alias (`tests/direct-routes.test.ts`, `tests/native-contract.test.ts`), which this Mac mini does not have set.
