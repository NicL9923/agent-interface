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
