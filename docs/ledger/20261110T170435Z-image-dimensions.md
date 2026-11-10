# November 10 transcript images that hold their space while they load

Branch `t3/image-dimensions` over `origin/main` at `c2ee202`, on NicolasLaptop (Fedora 44, Linux x64, 32 cores),
Node 24.22.2. Web client, one measuring tool and `e2e/ports.ts`; no app server, Hermes or iOS code changed.

## Every image the transcript renders, on main

| Where | Element | Size known before load? | Shift on main |
| --- | --- | --- | --- |
| A person's attachments on a sent message, and its echo | `FileLink` `<img>`, `src/app/Conversation.tsx:609` | Only from a page-lifetime cache filled by an earlier load of the same file | Yes: 0 tall until loaded, then up to 400 px |
| Files and generated images in a reply | Same `FileLink` | Same | Same |
| Inline Markdown images | `img` renderer, `src/components/MessageMarkdown.tsx:128` | Not rendered as an image: an "Open image" link | None |
| Activity, header and card avatars | `Avatar`, `src/components/Avatar.tsx:634` | Yes, the design's fixed size on the wrapper and `width`/`height` on the portrait | None |
| Reply file chips | `src/app/ReplyFiles.tsx` | No images | None |
| Composer attachment thumbnails | `src/app/AttachmentTray.tsx:72` | Fixed thumb box in `attachments.css`; outside the transcript | None in the transcript |
| Computer peek | `src/components/ComputerPeek.tsx`, a canvas in a floating dock | Fixed | None in the flow |

Hermes reports no image sizes: `FileRef` is `id`, `name`, `mime`, `size`, `url` (`src/shared/types.ts:224`), Hermes's
artifact and attachment rows carry none, and the upload route does not read image headers. Sending sizes would take
the server reading each image's header at upload and download (`src/server/hermes-files.ts`), storing width and
height with the file, and adding them to `FileRef`. Left out, as the brief asks.

## Change

- `src/app/image-sizes.ts` keeps each image's natural size by file ID for the page's life. A size of zero, as from a
  broken file, is not kept.
- The composer's attachment thumbnail records its file's size when its local preview loads, so the sent message and
  Hermes's copy, which carries the same file IDs (`src/hermes/extension.py:1469`), reserve the image's own shape
  from the first frame.
- `FileLink` reads the size once per mount. Known: `width`, `height` and the image's ratio. Unknown: the bounded
  placeholder, a 4:3 frame (`aspect-ratio: 4 / 3` in `src/styles.css`) at the link's width, at most 450 by 337 px,
  under the existing 400 px cap, with `object-fit: contain`. A size learned on load is kept for the next mount,
  never applied to the mounted image, so its frame does not change under the reader. A row rebuilt later, such as
  when a steer moves a live reply into a new turn, takes the learned shape then.

## Layout shift, before and after

`npm run build && node .agents/tools/measure-image-shift.mjs --runs 3`, Chromium 1280 x 800, `e2e/server.ts` on
port 4187, network emulated at 400 ms latency and 400 kbit/s, six images (4:3, 16:9, 9:19.5, 1:1, 3:4, 21:9) served
1.2 to 2.45 s late, then a text reply. Each run is a fresh page, so no size is known in advance. Same three
numbers in every run:

| Scenario | `main` at `c2ee202` | This branch |
| --- | --- | --- |
| Open the chat from its link: CLS, shifts | 0.464, 6 | 0, 0 |
| Open: last message's distance from the view's bottom | 0 px | 0 px |
| Reader scrolled up 500 px with the wheel before images arrive: drift of the first message below the top | 0 px (the wheel reached `seed-1`, the images having no height yet) | 0 px (`photo-5`) |
| Send a 16:9 image with text, image served 2 s late: sent message's move | 122 px up | 0 px |
| Send: CLS, shifts | 0.0097, 2 | 0.0097, 2 |

The two small shifts in the send scenario are the same on both builds and come from the composer, not an image.
The first batch of runs on this branch gave two send runs with the sent message 10,692 and 11,571 px above the
view; six later runs, three of them printing the scroll state, gave 0 px each, and the cause was not found.
Removing the CSS frame by hand brought the open scenario's CLS back to 0.464 in one run.

## Checks

- `npm ci` once. `npm run typecheck`, `npm run lint` passed. `ruff check .` (ruff 0.17.3): all checks passed.
- `npx vitest run tests/image-dimensions-ui.test.ts`: 4 tests passed.
- `npm test`: 193 files, 3,206 tests passed.
- `npm run build` passed. `npm run test:e2e`: 20 passed in Chromium.
- Safari, Firefox and a real phone: not run.

## Red proof

Each line was broken by hand, the named tests went red, and the line was restored:

1. `FileLink` reading the cache on every render instead of once per mount: "gives an image of unknown size the fixed
   frame, and keeps that frame when it loads".
2. The zero-size guard removed: "keeps only a real natural size" and "does not reserve a size the preview never had".
   Checking only the width: "keeps only a real natural size".
3. The tray not recording its preview's size: "reserves a sent image's own size from the moment it is sent…".
4. `width` and `height` removed from the image: the same test.
5. `FileLink` not recording a loaded image: "gives an image of unknown size the fixed frame…".
6. The CSS frame removed: the browser measurement above, CLS 0.464.

## Review fix round: Grok 4.7's findings

Grok 4.7 reviewed `cbad862`, ran every check and reproduced the send measurement at 0 px in 20 of 20 runs. It found:

5. A failed image dropped its reserved frame: in Chromium a 404 image went from 448 x 336 with `aspect-ratio: 4 / 3`
   to 100.1 x 16 with `aspect-ratio: auto`. Chromium drops a failed `img`'s used aspect ratio, and `width` and
   `height` did not hold it either.
6. An image of unknown size that is not near 4:3 stayed letterboxed for as long as its row was mounted.
7. Unchecked: animated and very large images, and whether one file ID can name different bytes.

### Change

- The shape is on a `.file-frame` span around the image, not on the `img`. The image fills the frame absolutely,
  with `object-fit: contain`; the file's name stays below the frame (`.file-name`). The frame keeps the existing caps:
  the link's width up to 450 px, at most 400 px tall. A failed image is replaced in the frame by "Couldn't load this
  image"; the frame keeps its size, and the link still opens the file.
- On load, `reshapes` (`src/app/image-sizes.ts`) compares the natural shape with the frame's: the remembered size, or
  4:3. Beyond a factor of 1.1 either way, the image takes its own shape, within the same caps. The tolerance: within
  10%, the bars beside or above the image are at most about 5% of the frame on each side (17 px in all on a 337 px
  frame), not worth moving every row after it; 3:2 photos (12% off) reshape, 4:3 and 5:4 near-squares within 10% do
  not. The image's own `width` and `height` attributes are gone; the frame carries the ratio.
- The reshape must not move what a person is reading. First measured with the reshape applied at load: the reader's
  message moved 64 px and 144 px with images in or at the top of the view, because "keep the reader's place" holds
  the row at the view's top edge (`holdPlace`, `firstMessageBelow`), so a reshape in that row, or in any row in view,
  moves the rows after it. The 144 px case was an image whose frame was above the view while its file name, the end of
  its row, was still at the top edge. So the reshape waits while the reader can see the image's row: `readerSees`
  checks the row (`[data-message-id]`) against its scroller, and an IntersectionObserver applies the shape once the
  row leaves the view. A chat pinned to its end reshapes at once, since following keeps the latest message still.
  This departs from "apply at load" only for an image whose row is in view while the reader is scrolled up; that
  image stays in its frame until it scrolls away, then reshapes out of sight.
- `file.attach` (Hermes `tui_gateway/prompt_attachments.py`, `_stage_session_file_attachment`) stages a browser
  upload with `O_CREAT | O_EXCL` and a numbered name when one is taken, so an upload never reuses a live path. An
  artifact's file ID is its path (`signFile` in `src/server/hermes-files.ts`), so an assistant writing a new
  `chart.png` over the old one keeps the ID with different bytes. The stale size then gives the frame the old shape
  until load; because the reshape compares with the frame's shape, not only with 4:3, the new image takes its own shape
  once (the same in-view rule applies), and the learned size replaces the old one. The size map is bounded at 500
  entries, least recently learned first out; a learned size moves to the end.

### Layout shift

`npm run build && node .agents/tools/measure-image-shift.mjs --runs 3 [--shapes far]`, Chromium 1280 x 800, network
at 400 ms and 400 kbit/s, images served 1.2 to 2.45 s late. Each build's checkout ran the same tool (`main` with this
branch's `e2e/ports.ts` for `E2E_PORT`). Runs repeated the same numbers unless noted. Mixed: 4:3, 16:9, 9:19.5, 1:1,
3:4, 21:9. Far: 16:9, 9:19.5, 21:9, 1:1, 9:16, 3:1.

| Scenario | `main` at `c2ee202` | Head `cbad862` | This change |
| --- | --- | --- | --- |
| Open, mixed: CLS | 0.464 | 0 | 0.067 |
| Open, far: CLS | 0.419 | 0 | 0.068 |
| Open: last message from the bottom | 0 px | 0 px | 0 px |
| Reader, mixed, wheel up 300 / 900 / 1,500 px: reader's message moved | 325 / 0 / 0 px | 0 / 0 / 0 px | 0 / 0 / 0 px |
| Reader, mixed: most any message in view moved | 1,344 / 955 / 955 px | 0 px | 0 px |
| Reader, far: reader's message moved, most in view moved | 241 / 0 / 0, up to 1,200 px | 0, 0 px | 0, 0 px |
| Reader, mixed: CLS | 0.115 / 0.067 / 0.067 | 0 | 0.074 / 0.029 / 0 |
| Reader, far: CLS | 0.115 / 0.055 / 0.055 | 0 | 0.124 / 0.052 / 0.029 |
| Send a 16:9 image: sent message moved, CLS | -122 px, 0.0097 | 0 px, 0.0097 | 0 px, 0.0097 |
| Send while six images above load, mixed: moved, CLS | 0 px, 0.551 | 0 px, 0.0097 to 0.0106 | 0 px, 0.061 |
| Send while six far images above load: moved, CLS | 0 px, 0.487 | 0 px, 0.0097 | 0 px, 0.061 |
| A 404 image's link height, loading then failed | 56 then 58 px | 381 then 58 px | 378 then 378 px |
| Failed scenario CLS | 0.346 | 0 | 0.045 |
| Animated GIF 480 x 270 and PNG 8000 x 4500: link height loading, then loaded | 56, 297 px | 381, 381 px (letterboxed) | 378, 294 px |
| The GIF's frame changes on screen | yes | yes | yes |

On `main` the images have no height until they load, so the same wheel distance reaches different rows; the reader
rows are comparable only within a build. Head's reader and open numbers are 0 because nothing ever reshapes; its price
is the letterbox. The reader scenarios record which images were above, in and below the view: at 300 px, photos 1 to
4 above and 5 to 6 in it; at 900 px, 1 to 2 above, 3 to 5 in, 6 below; at 1,500 px, 1 above, 2 to 3 in, 4 to 6 below.

The CLS this change adds comes from reshaped images. In follow mode (open, send-images) the latest message stays put
and rows above a reshaped image in view slide up, the one shift per image the decision accepts, smaller than `main`'s
from zero. In the reader runs, Chromium's layout-shift entries name rows the transcript's ResizeObserver puts back
(`placeLatest`, with `overflow-anchor: none`): positions sampled after the images settled show 0 px for the reader's
message and every message in view. Whether a frame is painted before that correction was not separated here.

An earlier batch run gave one send-images run on `main` and on head at -648,784 px, the outlier the first ledger
section also saw; the final batch above did not repeat it, and its cause is still unknown.

### Tests and red proof

Written first: the e2e "a transcript image that fails to load keeps the space it held while loading" went red on
`cbad862` at 381 px against 58 px. New and changed UI tests in `tests/image-dimensions-ui.test.ts` (10) and
`tests/app-ui.test.ts`. Each line broken by hand, red, restored:

| Break | Red |
| --- | --- |
| `onError` ignored | "keeps the frame and says so when an image fails to load" |
| The reshape never applied | "gives an image of unknown size its own shape once it loads far from 4:3", "takes the loaded shape when the size this page remembered…" |
| `reshapes` compares only with 4:3 | "reshapes a frame only when the loaded shape is more than 10% from it, either way" |
| No tolerance (factor 1) | the tolerance test, "…keeps that frame when it loads close to 4:3" |
| One-sided tolerance | the tolerance test, the remembered-size test |
| The zero-size guard removed | the tolerance test (640 x 0 gives an infinite ratio; it survived until that case was added) |
| No eviction; no recency on a relearned size | "forgets the oldest sizes past its bound, and keeps one just used" |
| `readerSees` always false; the at-end check dropped; the frame instead of its row checked; the frame observed instead of its row; the waiting shape never applied; applied while in view | "waits until the image's row leaves the view to reshape it…" |

### Checks

`npm ci` once; `npm run typecheck`, `npm run lint` passed; `ruff check .` with ruff 0.17.3: all checks passed;
`npx vitest run tests/image-dimensions-ui.test.ts tests/app-ui.test.ts`: 104 tests passed; `npm test`: 193 files,
3,212 tests passed; `npm run build` passed; `npm run test:e2e` (`E2E_PORT=4371`): 21 passed in Chromium. Safari,
Firefox and a real phone: not run.
