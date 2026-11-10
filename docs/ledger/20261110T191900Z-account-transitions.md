# November 10 an account change in one tab takes effect in every tab

Branch `t3/account-transitions`, from `origin/main` at `c2ee202`. Checks ran on NicolasLaptop
(Fedora, Linux x64, Node 24.22.2, Chromium from Playwright 1.64.1) on the branch's code as
committed with this entry. No server, Python, iOS or Hermes code changed.

## What `main` does

The reviewer found, in Chromium against the real Fastify app, that a tab showing member A keeps
A's rows after another tab signs member B in, until its next bootstrap. Tabs share the cookie and
learn of a change only from their own next answer. A sign-out also left the member's drafts,
uncertain sends, group drafts and form answers in localStorage.

## Change

- `src/app/account-epoch.ts`: one record, `agent-interface:auth-epoch`, that every tab compares
  with the one it acts under. It changes before a sign-in or sign-out request is sent (marked
  `changing`), when that request settles, at a refused session, when a bootstrap names another
  account, and when the sign-in hint's lapse time passes. A tab checks it on the storage event,
  `pageshow`, focus and becoming visible, and before and after every `api()` request, stream event
  and upload. The raw text is compared, so even an unreadable record counts when it changes. A
  failed sign-in puts the old record back. A `changing` mark older than 65 seconds (a write's 60 s
  timeout plus margin) no longer holds tabs back.
- The sign-in hint moved here from `linked-chat.ts`, so one module writes every account
  transition; `linked-chat.ts` keeps the early chat read and drops it through the same end of
  generation.
- `src/App.tsx`: `App` now draws one account generation at a time, keyed by the tab's generation.
  A change unmounts the generation in a commit of its own, while the tab still acts under the old
  record, so every request its cleanups make is refused; only then does the tab take the new
  record and mount the next generation. Meanwhile it shows the connecting screen, or sign-in after
  a sign-out. An address that named the last account's chat is reset.
- `src/client-api.ts`: requests, stream events and uploads are refused or discarded once the
  record changed (`AccountChanged`, an abort). The CSRF token and the response cache clear at
  every end of generation.
- Module memory keyed by chat alone clears at every end of generation: settled-request receipts,
  a declined approval's prompt, earlier-files lists. Presence and device-activity reports made for
  an ended generation never go.
- `src/app/account-change.ts`: sign-in and sign-out through the record. Sign-out removes the
  member's content records (`forgetAccountContent` in `src/app/storage.ts`) and closes shown
  notifications. A sign-in that names another account than the last ends the browser's push
  subscription, which the server keeps as the old account's and refuses to the new one.

## What outlives a change, and why it cannot leak

| Held | Handling |
| --- | --- |
| React state: boot, conversation, drafts in memory, uploads, panels, toast | Unmounted with the generation |
| Conversation cache, prefetched and linked chats | `clearResponseCache` at end of generation; `conversation-page` follows its scope |
| Reads in flight, a bootstrap that answers late | Discarded as `AccountChanged` |
| Live streams | Closed with the generation; an event after the change drops the stream |
| CSRF token | Cleared at end of generation; the server also checks it against the session |
| Settled receipts, declined prompts, earlier files | Cleared at end of generation |
| Presence and device-activity reports queued or sent at unmount | Fenced by generation |
| Draft saves, sends | Their live checks read the shared generation |
| Service worker messages | Carry only an address, opened under the account signed in now |
| Notifications on screen | Closed at sign-out, refusal and another account |
| `<html data-theme>` | Reset to the system theme with the generation |

## Accepted limit

A transition the browser cannot observe, a session revoked from another device while this one is
offline or has not reached the server, shows what it shows until the first answer from the
server, which refuses the session and is then the refused-session transition.

## Application tests

- `npm ci`, `npm run typecheck`, `npm run lint` and `ruff check .` (ruff 0.17.3) passed.
- `tests/account-transitions-ui.test.ts`, new: two tabs, each the whole `App` with its own module
  copies, sharing one fake localStorage whose events the test delivers late, reversed or never,
  and one cookie the fake server reads per request. 11 tests: B signs in while A shows in another
  tab (the reviewer's case), A signs out elsewhere, a late bootstrap for A, `pageshow` with
  `persisted`, the hint's lapse, a stream event and a typed draft after an unheard sign-out, a
  refused sign-in, a stale mark, an unreadable record. Each asserts nothing of A is in the
  document afterwards and no request after the change used A's session or content.
- Changed: `tests/linked-chat-ui.test.ts` signals other tabs through the record, not the hint.
  Two tests that pinned a mocked `clearResponseCache` call now assert what the person sees.
- `npm test`: 193 files, 3,212 tests passed.
- `npm run build`, then `npm run test:e2e`: 21 Chromium tests passed, including the new two-tab
  case, which signs out and signs in member two in one page and checks the other without a reload.

## Red runs

- The new unit file against `origin/main`'s code: all 11 failed, the account cases at
  `not.toContain('Ranch Hand')`, member one still on screen.
- The new e2e case against `origin/main`'s build: failed at the first tab's sign-in screen, which
  never appeared.
- The first version of this change adopted the new record during render; the e2e case failed on
  a 401 from `/api/devices/activity`, the old generation's unmount report going out under the
  next account. That is why the unmount now has a commit of its own.

| Mutation, `tests/account-transitions-ui.test.ts` | Result |
| --- | --- |
| Answer check after a request removed | failed: B signs in while A shows |
| Check before a request removed | failed: a typed draft after an unheard sign-out |
| `pageshow` listener removed | failed: the back-forward cache case |
| Storage listener removed | failed: 4 cases |
| Hint lapse timer does nothing | failed: the lapse case |
| Content removal at sign-out removed | failed: A signs out elsewhere |
| No wait during another tab's change | failed: 2 cases |
| A stale mark still waited for | failed: the stale mark case |
| A failed sign-in keeps the mark | failed: the refused sign-in case |
| Stream events not checked | failed: the stream event case |
| Presence fence removed | failed: the typed draft case, a "left" report sent as nobody |
| Device-activity fence removed | survived, here and in the e2e case: jsdom never has focus, and in Chromium the separate unmount commit already refuses the report. Kept for a report queued behind a slow one. |

## Not exercised

- Safari, Firefox, a real back-forward-cache restore, an installed home-screen app and a real
  phone: not run. Only Chromium runs here; `pageshow` is exercised in jsdom.
- A tab of the release before this one writes no record; a bootstrap that names another account
  still catches its sign-in, at that tab's next answer.
- With storage that refuses writes, tabs cannot tell each other; each still drops on its own
  transitions and on a bootstrap that names another account.
