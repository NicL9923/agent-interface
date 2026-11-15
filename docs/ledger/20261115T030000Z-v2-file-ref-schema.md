# November 15 drafts and sends accept the app's own file identifiers

Branch `t3/v2-file-ref-schema` from `origin/main` at `680e23a`, on the Mac mini with Node 24.22.2. Nothing was
deployed by this entry, and nothing has been deployed since #399 merged.

## Change

#399 signs file identifiers as `v2.<key id>.<body>.<signature>`, but the `fileRef` schema in
`src/server/schemas.ts`, which the send and draft routes validate attachments with, still allowed only the earlier
two-part `<body>.<signature>`. Every draft save or send carrying a new upload therefore answered 400 at
`attachments[0].id`, and once deployed the startup pass would re-sign stored drafts to `v2`, so saving any of those
would fail too. The #405 implementer found it when the e2e upload fake was made to sign real identifiers. The schema
now accepts both shapes.

## Red runs

| Break | Test | Failure |
| --- | --- | --- |
| `src/server/schemas.ts` as on `origin/main` | `saves a draft whose attachment the app signed with its own key, and refuses an identifier of no known shape by field` | 1 failed: the v2 identifier answered 400 |

The schema was restored and the test passed.
