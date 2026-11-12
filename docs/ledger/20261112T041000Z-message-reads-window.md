# November 12 one message and earlier files are read from a window

Branch `t3/36e26aad` over `origin/main` at `1e3cb31`, on NicolasLaptop (Fedora 44, Linux x64), Node 24.22.2.
Nothing was deployed.

## Defect

Measured on the production host (release `f30d06d`): `GET /bots/patch/files` took 11.2, 11.4 and 13.5 s, each a read of
the whole 27 MB history (about 5 to 6.5 s in the add-on and 5 to 5.7 s in transit). While one ran, other assistants'
reads took 1.7 to 6.5 s instead of 0.1 to 0.2 s, because Hermes's interpreter lock and the one shared socket were busy.
Read-aloud (`src/server/voice.ts`) and reply-card state (`src/server/experience.ts`) read the whole history the same
way to find one message. Talk already read a window anchored at its request.

## Change

- `readMessage` in `src/server/conversation-view.ts` reads a window that starts at the message and reads the whole
  history only when the window does not hold it, as for a progress line, which has no row to start at. Read-aloud and
  reply-card state use it.
- `GET /bots/:id/files` reads a window that starts at `before`, whose context holds every earlier message with files,
  or the latest page without `before`, whose context and messages hold all of them.

## Tests and red runs

- `tests/app.test.ts` "answers a window Hermes already cut exactly as it answers its own cut" now also compares
  `/files` for `?before=p10`, `?before=a12`, `?before=gone` and no `before`: bodies identical whether the runtime cuts as
  the add-on does or answers whole, and eight reads cut. With the files route reading the whole history:
  `expected 4 to be 8`.
- `tests/read-message.test.ts`: a message in its window costs one windowed read; a progress line falls back to the
  whole history; a missing message answers nothing. Removing the fallback fails one case, removing the window read
  fails two.

Not exercised: production timings after the change. The Today recap's fallback full read
(`src/server/experience.ts`, when the latest page holds no reply) is unchanged.
