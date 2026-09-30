# Agent Interface plan

Implementation brief from the September 29, 2026 planning interview. Nicolas
requested that implementation begin in a fresh session using the
[kickoff prompt](ImplementationPrompt.md).

On September 30, Nicolas added a native iOS app with full feature parity and
confirmed the setup split below. These additions extend the settled scope;
the planning interview remains complete. He subsequently authorized production
hosting on the existing Hermes VPS at `agentui.wildflowersranch.com`, with DNS
managed through Cloudflare. This includes the app service, domain and HTTPS.
Preserve the existing Hermes dashboard, shared authentication repair, profiles,
reverse proxy routes and VPN. Unrelated infrastructure changes remain outside scope.

The September 30 follow-up also requires Hermes update qualification, a simple
administrator update flow in both clients, a prominent animated conversation
avatar, and actual reasoning/tool details in Advanced view. Check an exact
official source revision in isolation before offering installation. Preserve the
OAuth repair and existing connections, stop new native work during cutover, and
verify recovery before reopening admission. An update request does not authorize
an unattended production Hermes upgrade.

## Purpose

Build an installable PWA and a native SwiftUI iOS app for two household members
using one shared Hermes installation. Everyday questions are the primary use case. Image generation is
a secondary use case. The interface should feel like returning to a persistent
assistant rather than starting a disposable chat.

This is a full Hermes client with substantial avatar customization. The first
release includes full everyday bot configuration, not only a chat wrapper.

## Decisions confirmed by Nicolas

- Each person's bots have their own persistent conversations. Shared bots have
  one shared persistent conversation visible to both people. Personalization is
  not a privacy or authorization boundary.
- Sending a message during active work defaults to steering that work. Preserve
  the message and sender attribution. Apply guidance at the boundary supported by
  Hermes; do not imply that an already completed action can be undone.
- Either person may approve a shared bot's requested action. Record who approved
  it and leave approval enforcement with Hermes.
- A shared bot has one shared model choice. Make changes visible to both people.
- If Hermes or the VPS restarts during a task, mark the task interrupted and
  require review before retrying. Do not automatically replay unfinished work.
- First-release uploads include images, PDFs, and plain-text files. Broad Office
  format support and reliable scanned-document reading are outside this scope.
- Shared-bot completion and approval notifications go to task participants by
  default. Provide an option to follow all activity from a bot.
- Include bot creation and editing, instructions, models, avatars, enabled tools,
  skills, and routine management in the first release.
- New provider and service sign-ins remain in the official Hermes interface
  initially. The custom app configures connections already established there.
- The self-hoster configures the permanent Hermes connection during server setup.
  Web users only sign in. Native iOS users enter the app server's address and sign
  in to that household. Neither client collects the Hermes gateway token.
- The native iOS app shares the server API and canonical conversations. It must
  include bot, tool, skill, routine and avatar configuration, attachments,
  approvals, steering, personal organization, recovery and notifications.
  Native controls and navigation may differ from the web layout.

## Avatar acceptance requirements

Offer three avatar modes in the first release:

1. Grok Bot-style geometric avatars. Closely match the reference's shapes,
   colors, eye customization, expressions, animations, and transitions. Motion
   fidelity is a release requirement, not optional polish.
2. Muse-inspired avatars from a customizable animated mascot family. Generating
   an arbitrary character and automatically animating it is outside this scope.
3. Generic generated image portraits. Preserve the existing planned uploaded
   image option. These images do not require character animation.

Animated avatars must communicate idle, thinking, working, waiting, blocked, and
done states. Also make disconnection, failure, and interruption clear. Backend
state drives activity; an animation must not claim the bot is still working when
its state is unknown. Generated portraits need a separate visible state treatment.
Respect reduced-motion preferences while preserving an understandable state.

Before implementation, record a reference inventory of the actual Grok controls
and motion behavior. Review a standalone animation specimen against that
inventory before integrating it across the app. Check whether existing
implementations and assets can be reused under their actual licenses. Do not
assume that published examples grant asset reuse rights.

## Architecture retained from the supplied plan

- One repository and one app/server process, with durable background notification
  handling. Hermes remains a separate supervised process.
- Proposed stack: React, TypeScript, and Vite for the PWA; Fastify and SQLite for
  the server and app-owned state. Verify and pin supported versions during the
  integration spike.
- The browser communicates only with the app's authenticated same-origin
  endpoints. Hermes and provider credentials remain server-side.
- The iOS app authenticates through a system browser session and exchanges a
  short-lived, one-time code bound to its PKCE verifier for an app session.
  Tokens belong in Keychain and must be scoped to the selected server. Browser
  cookie and CSRF protections remain intact.
- Google sign-in with an explicit household allowlist. Keep private account and
  deployment details outside this public repository.
- Hermes owns profiles, tools, skills, memory, routines, execution, approval
  enforcement, and canonical session history.
- The app owns human identity, preferences, drafts, read positions, notification
  subscriptions, delivery records, and attribution. A cached projection is not a
  second authoritative transcript.
- Keep Hermes transport, capability discovery, events, and reconciliation in one
  integration module. Do not create a framework for additional agent runtimes.
- Preserve shared canonical conversations across the custom app and official
  clients. Do not directly edit Hermes databases or create competing execution
  owners for the same conversation.
- Keep Simple/Advanced presentation preferences, sections, favorites, and the
  default bot per person. Detailed activity starts collapsed and stays inspectable.
- Closing the browser must not stop work. Reconnect to existing work, preserve
  drafts and scroll position, and reconcile uncertain submissions without
  duplicating execution. Restarting only the app server should leave Hermes work
  running, subject to integration verification.
- Web Push must work with the installed phone app closed and open the correct
  saved conversation. Cache versioned static assets conservatively; do not cache
  authenticated API responses or arbitrary transcripts in the service worker.
- Native notifications use APNs with the same persisted recipient rules as Web
  Push. Signing, Apple configuration and physical-device delivery require
  separate external acceptance. A simulated notification is not delivery proof.
- Handle routine results as well as human-started tasks. Routine notification
  recipients must be explicitly persisted because those runs have no current
  human task participant.
- Record the tested Hermes version, detect capabilities, and keep a small
  compatibility suite and rollback path. Do not alter shared infrastructure
  through ordinary bot configuration.
- Human group chats and additional agent runtimes remain out of scope.

Nicolas also requested an assessment of replacing Hermes. The
[runtime assessment](HarnessAssessment.md) records that research. It does not
authorize a runtime replacement in this implementation.

## Unresolved integration risks

Current upstream documentation describes useful capabilities. It does not prove
that the deployed Hermes revision supports this application's complete path.

- Determine the smallest transport combination that supports canonical Bot Chat,
  full configuration, steering, approvals, and independently running work.
- Prove that an uncertain submission can be reconciled without duplicate
  execution. Durable run admission is distinct from execution surviving restart.
- Prove that reconnect restores activity and pending requests after every browser
  closes and after an app-server restart. Do not rely only on transient event
  buffers for notification recovery.
- Verify a native document-upload route. HTTP chat endpoints document inline
  images but reject document inputs. File upload, access by the correct bot,
  retention, download, and unreadable-document handling still need verification.
- Inventory supported configuration operations. Isolate any missing capability
  in a small documented Hermes extension and prefer contributing it upstream over
  patching core execution.
- Verify image generation and authenticated image delivery against the actual
  configured runtime. Do not assume that a server-local output path is a usable
  browser download.
- Determine which avatar metadata Hermes can persist across clients and which
  presentation metadata the app must own.

## Implementation order

Start with a local or isolated integration spike before building the full UI.
Produce a capability matrix for:

1. Canonical bots, conversations, and shared model changes.
2. Answers, reasoning where exposed, actual tool results, and image generation.
3. Steering and approvals from two authenticated people, including stale requests.
4. Disconnect, reconnect, app-server restart, executor interruption, and uncertain
   submission recovery.
5. Images, PDFs, plain text, and generated-file delivery.
6. Bot, tool, skill, routine, and avatar configuration.
7. Durable discovery of completed work and pending attention for notifications.

Report missing capabilities and the smallest proposed extension before committing
to the final transport. Then build and review the avatar specimen and the complete
phone path. The original planning brief excluded production changes. Nicolas's
September 30 follow-up authorizes the specific deployment described above.

## References

Reviewed September 29, 2026:

- [Hermes Bot Mode](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode)
- [Hermes programmatic integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)
- [Hermes API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)
- [Grok Bot design and motion](https://x.ai/news/designing-grok-bot)
- [Muse introduction](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)

The supplied architecture and operating notes are retained privately. Their
reported production checks have not been independently reproduced in this project.
