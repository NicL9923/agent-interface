# Dependencies and local runtime

Verified September 29, 2026. Direct dependencies use exact versions in
`package.json`; `package-lock.json` pins the transitive tree.

| Component | Pin | Primary evidence |
| --- | --- | --- |
| React and React DOM | 19.3.0 | [React versions](https://react.dev/versions), [registry](https://registry.npmjs.org/react/19.3.0) |
| TypeScript, retained comparison and rollback compiler | 7.0.2 | [Microsoft release announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), [registry](https://registry.npmjs.org/typescript/7.0.2) |
| Oxc tsrs, command-line type checking | 0.18.0-ts7.1.0-dev.20260929 | [Primary documentation](https://github.com/oxc-project/tsrs), [registry](https://registry.npmjs.org/tsrs/0.18.0-ts7.1.0-dev.20260929) |
| Vite | 8.3.1 | [Vite 8 requirements](https://v8.vite.dev/guide/), [registry](https://registry.npmjs.org/vite/8.3.1) |
| React Vite plugin | 6.1.1 | [Registry](https://registry.npmjs.org/@vitejs/plugin-react/6.1.1) |
| Fastify | 5.12.5 | [Fastify v5 requirements](https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/), [registry](https://registry.npmjs.org/fastify/5.12.5) |
| Google auth library | 11.1.0 | [Registry and Node requirement](https://registry.npmjs.org/google-auth-library/11.1.0) |
| Web Push | 3.6.7 | [Registry](https://registry.npmjs.org/web-push/3.6.7) |
| Vitest | 5.0.2 | [Registry and Node requirements](https://registry.npmjs.org/vitest/5.0.2) |
| React Markdown | 10.1.0 | [Official documentation](https://github.com/remarkjs/react-markdown), [registry](https://registry.npmjs.org/react-markdown/10.1.0) |
| remark-gfm | 4.0.1 | [Official documentation](https://github.com/remarkjs/remark-gfm), [registry](https://registry.npmjs.org/remark-gfm/4.0.1) |
| jsdom, development DOM tests | 30.1.1 | [Official documentation](https://github.com/jsdom/jsdom), [registry](https://registry.npmjs.org/jsdom/30.1.1) |
| Base UI, web context menus and popovers | 1.9.0 | [Official documentation](https://base-ui.com/react/overview/about), [registry](https://registry.npmjs.org/@base-ui/react/1.9.0) |
| Tailwind CSS and Vite plugin | 4.3.3 | [Theme variables](https://tailwindcss.com/docs/theme), [registry](https://registry.npmjs.org/tailwindcss/4.3.3) |
| clsx and tailwind-merge, shared control classes | 2.1.1 / 3.7.0 | [clsx](https://github.com/lukeed/clsx), [tailwind-merge](https://github.com/dcastil/tailwind-merge) |
| SQLite | 3.53.4 in both tested Node binaries | [Node SQLite API](https://nodejs.org/api/sqlite.html) and `SELECT sqlite_version()` |

`.node-version` selects Node 24.21.0. The engine range also permits Node 26.10
and later releases within major 26. Both tested versions satisfy the published
requirements of Vite, Fastify, Google auth, and Vitest. Odd Node majors are excluded.
No third-party SQLite driver or native build is required. Node ships the database
binding and engine. The SQLite engine version therefore follows the Node binary.

The UI additions above were verified October 16, 2026. `components.json` configures
shadcn's Base UI registry conventions; the customized components live in this
repository. The shadcn CLI is development tooling rather than a runtime dependency.

The app contract tests passed under Node 24.21.0 and Node 26.10.0. Integration and
browser evidence records its actual runtime in `ValidationLedger.md`. This does
not claim that every accepted future patch release has been tested.

## Command-line type checking

Verified October 20, 2026 against npm's current release and the
[tsrs CLI documentation](https://github.com/oxc-project/tsrs/blob/main/docs/USAGE.md).
`npm run typecheck` and the first step of `npm run build` use the exactly pinned
Oxc tsrs with `--noEmit` and the existing `tsconfig.json`. Its strictness, included
files and other compiler options are unchanged. Vite, the service-worker build
and the server's tsx runtime keep producing and running JavaScript as before.

This is a prerelease targeting TypeScript 7.1 development semantics. Retain
TypeScript 7.0.2 for comparisons and rollback with `npx --no-install tsc --noEmit`.
The repository uses the compiler CLI and does not depend on a compiler API.
The [compatibility record](https://github.com/oxc-project/tsrs/blob/main/docs/COMPATIBILITY.md)
lists known gaps and supported platforms. The lockfile retains every published
optional native package: macOS arm64 and Linux x64/arm64 with GNU and musl libc.
Do not omit optional dependencies when installing the checker.

# App state and authentication

Hermes owns conversations and execution. The app SQLite database stores identities,
browser and native sessions, preferences, drafts, read positions, bot presentation, submission intents,
actor attribution, task participants, explicit routine recipients, subscriptions,
notification discovery records, delivery attempts, and the discovery cursor.
It has no canonical message or conversation-history table. An uncertain submission
stays durable and first reconciles through the Hermes receipt query. The app
never resends it automatically. An explicit reviewed retry must use the same
request ID and payload, and requires the verified durable idempotency add-on.
An absent receipt does not prove rejection, since an original HTTP request may
still arrive.

Notification discoveries remain available for 30 days so an event arriving before
its admission receipt can later acquire the correct recipients. Outbox uniqueness
prevents duplicate enqueueing for the same event and person. Delivery to each device
has its own success record. Push has at-least-once transport semantics; a crash after
a push provider accepts delivery can repeat that delivery. The notification tag
lets the service worker replace the same event's notification.

Google ID tokens must have a verified email matching `HOUSEHOLD_EMAILS`. Every
session request checks the current allowlist. Cookies are HTTP-only, same-site
strict, and secure in production. Browser API writes require the configured origin and the
session's CSRF token. Production startup fails without HTTPS, Google configuration,
and an explicit household allowlist. A public listener or public origin enforces
the same rules even if `NODE_ENV=development`; forgetting that environment flag
cannot expose a development sign-in route. HTTPS origins always set secure cookies.

The native iOS app uses the same allowlist through a PKCE-bound browser handoff.
Opaque bearer sessions are hashed in SQLite and expire after seven days. Native
requests omit Origin and cookies; any bearer request with Origin is rejected.
Session revocation also removes its APNs device registrations. The native
[authentication contract](native-api.md) records the endpoints and expiry rules.
APNs uses Node's built-in cryptography and HTTP/2; no additional npm dependency
is required.

For local browser validation, `LOCAL_DEV_AUTH=true` permits two local identities
only in development, with both the listener and configured origin on loopback.
The route also checks the client's direct IP. It cannot be enabled in production.

For Vite development, run the server with
`APP_ORIGIN=http://127.0.0.1:5173 LOCAL_DEV_AUTH=true npm run dev`, then run
`npm run dev:client` in another terminal. Vite proxies `/api` to the local server,
so browser requests stay on one origin. For the built application, use the default
origin `http://127.0.0.1:3000` with `LOCAL_DEV_AUTH=true npm start`.
