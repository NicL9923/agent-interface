# Fresh-session kickoff prompt

Implement Agent Interface in this repository. Read `README.md` and `docs/Plan.md`
first. The planning interview is complete; treat its product decisions as settled
and do not restart it. This prompt authorizes local implementation and validation.

Start with an isolated Hermes integration spike. Verify current official
documentation and the exact Hermes source/runtime version you test. Prove
canonical bot conversations, streaming, steering, approvals, reconnect, restart
behavior, duplicate-submission prevention, document uploads, generated-file
delivery, and bot/tool/skill/routine configuration. Save the capability matrix and
reproducible evidence in `docs/`. Make missing capabilities explicit; do not
substitute mocked behavior for integration proof.

Use the spike to select the smallest working Hermes integration. Keep it in one
module. Small documented Hermes extensions are acceptable when needed; prefer
upstream contributions over a core execution fork. Then continue into application
implementation rather than stopping at the spike or scaffolding. Use the proposed
React/TypeScript/Vite, Fastify, and SQLite stack unless verified constraints give a
concrete reason to change it. Check and pin supported versions.

Implement the full scope in `docs/Plan.md`. In particular, do not silently trim
full bot/tool/skill/routine setup or the three avatar modes. Grok-style shapes,
eye customization, expressions, and animations are acceptance requirements.
Muse-style avatars use a customizable animated mascot family. Generic generated
portraits are the third option. Inventory actual visual references and review a
standalone animation specimen before integrating it throughout the app. Inspect
reuse licenses rather than assuming assets are reusable.

Preserve the settled shared-chat, shared-model, steering, approval, upload, and
notification rules. Keep execution and canonical history in Hermes. Preserve
drafts and reconcile interrupted connections without duplicate actions. The
October 1 follow-up adds integrated account setup and health in both clients,
backed by Hermes's native credentials and execution. It also requires retry,
safe cancellation and service restart for failed update operations. Follow
`docs/Integrations.md` and `docs/HermesUpgradeLinux.md` for these extensions.

Carry work through meaningful tests and browser validation at phone and desktop
sizes, including both themes and reduced motion. Keep one validation ledger tied
to the tested code and Hermes revision. Distinguish simulated push checks from
actual installed-phone delivery. Report any physical-device acceptance that still
requires a human step.

Private source documents are available on the planning machine under
`~/.local/share/agent-interface/planning/`: `Hermes family UI architecture.md` and
`Hermes VPS operating notes.md`. Use them as context, not as material to publish.
Use the `hermes-agent` and `machine-fleet` skills if live runtime or host access
facts are needed. Do not commit credentials, private accounts, transcripts, or
operating details. Production deployment and infrastructure changes need separate
authorization.

Make routine engineering decisions autonomously, record material decisions, and
ask only for consequential unresolved choices. Give concise progress updates.
