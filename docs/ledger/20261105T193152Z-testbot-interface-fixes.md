# November 5 interface fixes from a live TestBot walkthrough

Source fingerprint `sha256:95ba54c122599c35affb4b36417d294fd7f98379db06d3ac5071ce5a3f0b3814`, at `531f31d`, based on main `3c8fd16`. Node 24.22.2 and Python 3.14.10. Hermes was not run; the add-on change is limited to `event_body` in `src/hermes/extension.py`.

An agent used the production site end to end with a throwaway personal assistant, TestBot. Its findings drove [PR #237](https://github.com/NicL9923/agent-interface/pull/237):

- Search marks Hermes's matches.
- The page no longer scrolls past the window.
- Links to filesystem paths show as text.
- Today reads a recent window instead of whole histories.
- The command palette no longer leaves a stale group.
- Creating an assistant opens its chat.
- Previews, Today, notifications, search snippets and saved titles are read as plain words by a Markdown parser. The server does the flattening; the web client loads the parser only to title a saved reply.

Application checks: all 129 Vitest files, 1,785 tests, passed. Type checking and the production web build passed, and the main bundle stayed at 121.8 kB gzipped. All 35 Python test files passed. Adversarial 50,000-character inputs run through `markdownPlain`, `snippetPlain` and `replyTitle` in about 50 ms at worst. The worst case is a list nested hundreds deep inside the 1,000-character read window.

Visual checks, in the loopback preview app with synthetic fixtures at 1440×900 and 390×844:

- The page height equals the window.
- The header chevron sits after the name.
- Creating "Fence checker" opened its chat.
- Search focuses on open.
- The palette shows one ranked list for "find".

Five GPT-6.1 Sol reviews ran at high reasoning effort. Every P1 and P2 finding was fixed:

- Catastrophic regex backtracking.
- Text flattened before privacy redaction.
- Event bodies collapsed to one line.
- Fence, cut and marker edge cases.
- A slow block-scan pass, later removed.

The final review had no P0, P1 or P2 findings, and its one P3 is fixed in `531f31d`.

Not exercised:

- The windowed Today read against real Hermes.
- `event_body` against a running gateway. It needs a fresh qualification receipt before release.
- iOS, which still strips syntax from the now-plain fields: [#241](https://github.com/NicL9923/agent-interface/issues/241).
- Hermes's first-contact profile offer: [#242](https://github.com/NicL9923/agent-interface/issues/242).
