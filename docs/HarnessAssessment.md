# Should this app own its agent runtime?

Assessment requested September 30, 2026. This is a recommendation, not a decision
to replace Hermes. The implementation continues to use the pinned Hermes owner.

## Recommendation

A focused household runtime is worth an isolated experiment if its behavior is
central to the product. Keep Hermes until that experiment proves execution and
recovery through the same application contract. Removing unused menus or bundled
skills alone would not justify a rewrite.

The strongest reason to own the runtime is already visible in this repository.
The [Hermes extension](../src/hermes/extension.py) wraps private turn-completion,
task-marker and continuation functions because the app needs precise task
completion and interruption behavior. Pinning Hermes and testing those hooks
contains the risk, but does not make those private functions stable interfaces.

Owning the runtime would let us change those rules directly. It would also make
us responsible for tool execution, context limits, provider changes and recovery.
It cannot promise that nothing breaks.

## What this app actually uses

This audit covers the repository and pinned upstream source. It does not inspect
production accounts or measure how often Nicolas uses each feature.

| Responsibility | Current owner | Replacement implications |
| --- | --- | --- |
| Identity, household allowlist, personal preferences, drafts and read positions | App server | Already independent of Hermes |
| Notifications, recipient attribution and submission journal | App server | Preserve across a runtime change |
| Profiles, shared instructions and model selection | Hermes | Reimplement persisted configuration and provider validation |
| Canonical history, streaming, tool loop and context management | Hermes | Core execution work, including partial failures and compaction |
| Steering, approvals, clarification, interruption and durable receipts | Hermes plus the extension | Must preserve the existing recovery contract |
| Upload binding, generated files and authenticated delivery | Hermes plus app routes | Preserve provenance and access boundaries |
| Memory, skills and their review processes | Hermes | Files are portable; learning policy and evaluation still need design |
| Routines and scheduler execution | Hermes | Durable scheduling, missed runs, time zones, overlapping runs and delivery |
| Discord and provider authentication | External Hermes configuration | Not exercised against live accounts by this audit |

The [Runtime interface](../src/shared/types.ts) and injected server dependency
provide a useful place for a replacement experiment. The existing app does not
need a framework for arbitrary runtimes or changes to either client's API.

## The named features

Hermes's built-in memory uses bounded editable `MEMORY.md` and `USER.md` files,
plus searchable session history. Reproducing that storage is straightforward.
Deciding what to retain, correcting stale beliefs, protecting against unwanted
memory writes and measuring useful recall are separate work. Hermes freezes the
core memory snapshot at session start; continuous gateway sessions need deliberate
boundaries to benefit from refreshed memory. See the
[memory documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory).

Our extension currently opens one canonical Bot Chat per profile. A continuous
conversation in the UI does not have to mean one indefinitely growing model
session. A future runtime could start fresh internal sessions between completed
tasks while retaining the visible transcript, attribution and searchable history.
That is a design recommendation, not a reproduced memory failure or an implemented
change. It must never rotate an active task or lose pending approvals.

Skills are portable instruction files and supporting resources. Automatic skill
improvement adds a review process that selects changes and controls when they
become active. Hermes also supports excluding bundled skills, so catalog clutter
can be reduced without replacement. See the
[skills documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills).

One Discord connector and a small provider list limit the breadth of a custom
implementation. They do not eliminate identity mapping, duplicate event handling,
rate limits, attachments or provider error handling. The present application
probes use a deterministic local provider, so they do not establish live Discord,
OpenRouter or subscription authentication behavior.

## Subscription authentication changes the calculation

OpenAI now documents Sign in with ChatGPT for eligible open-source and personal
integrations. OAuth tokens can call the public Responses API; self-hosted VM
registration and credential transfer have a documented path. This makes a custom
runtime more practical than relying on an unofficial ChatGPT web endpoint.
See the [launch guide](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt),
[inference contract](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
and [self-hosted flow](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms).

The preview requires streaming with `store: false`; the client owns conversation
history. Several hosted tools, including hosted image generation, are unavailable.
Access uses the person's existing plan limits. It does not import their ChatGPT
memory or conversations. See the
[preview limits](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
and [user guide](https://learn.chatgpt.com/docs/sign-in-with-chatgpt).

Claude requires a distinction between a personally authenticated CLI and a
product offering subscription login. Anthropic's June 16 notice says the proposed
SDK billing change was paused, so SDK and `claude -p` usage still draws from
subscription limits. Its SDK documentation separately restricts third-party
products offering claude.ai login without prior approval. See the
[current plan notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
and [SDK documentation](https://code.claude.com/docs/en/agent-sdk/overview).

Delegating a whole task to the official Claude SDK lets it own its tool loop and
context. Using the CLI only as a model provider inside our own loop is a different
integration. Despite its name, Hermes's experimental
`claude-subscription-directsdk` plugin drives the official CLI directly through
`stream-json`. It uses version-sensitive history replay and acknowledgement
behavior and explicitly disclaims full parity.
That path needs qualification, not merely a subprocess wrapper. See its
[plugin documentation](https://hermes-agent.nousresearch.com/docs/plugins/claude-subscription-directsdk).

## Wrapping existing executors

Nicolas's follow-up proposed a T3-style server that wraps Codex and Claude Code if
Hermes limits bot functionality. This is the preferred alternative to rebuilding
every provider's execution loop. Hermes remains the current executor; no new
executor is implemented by this assessment.

The server would own bot identity, the visible transcript, memory policy, skills,
schedules, task admission and notification recipients. Each task would persist
its executor, executor session ID and execution state. Exactly one executor would
own tools and approvals for that active task. Process loss requires reconciliation
or explicit interruption review, never an automatic run on a different executor.

Codex's app-server protocol exposes resumable threads, streamed events, steering,
interruption and approval requests. The installed `codex-cli 0.159.2` generated
those methods locally during this audit; no model run or account change was
performed. Use that structured interface instead of terminal output parsing.
See the [app-server documentation](https://learn.chatgpt.com/docs/app-server).

For Claude, prefer the official Agent SDK's structured sessions, events and
approval callbacks. A raw model adapter and a Claude executor must be different
concepts: the executor also owns its own tool loop and context. See
[programmatic Claude Code](https://code.claude.com/docs/en/headless).

Changing executors should begin a new internal session with an explicit context
handoff. Persisted user-visible messages and portable memory can move; hidden
reasoning, active tool calls and session internals are not interchangeable.
Capability checks must expose actual steering, approval, file and recovery support
instead of claiming every executor behaves identically. Shared memory and skill
tools can use narrow MCP interfaces where supported, with the server owning
writes and review policy.

Hermes already has an optional Codex delegation mode. Its documentation says the
normal `memory` and `session_search` tools are unavailable there, although
background memory and skill review remains. That integration must be qualified
against this product before enabling it. See the
[documented delegation limits](https://hermes-agent.nousresearch.com/docs/user-guide/features/codex-app-server-runtime).

## A reversible experiment

1. Keep the web and native clients on the existing app API. Use one isolated bot
   and workspace for a replacement runtime, with one initial provider.
2. Implement durable task admission, streamed execution, one real tool, approval,
   interruption and explicit recovery. Reuse the current failure probes, including
   executor death after admission and lost responses without duplicate actions.
3. Add bounded memory, searchable history and reviewed skill updates. Compare
   recall on concrete household tasks before calling it equivalent learning.
4. Add a scheduled task and the required Discord path. Test unattended execution,
   duplicate events, missed runs and recipient delivery.
5. Export memory and skills as files and history through supported read/export
   interfaces. Preserve identifiers and app journals. Move one bot only after
   acceptance, with exactly one execution owner and a rollback copy.

A full Hermes fork would retain most of its dependency and upgrade burden while
adding responsibility for divergent internals. For this product, a small runtime
behind the existing contract is the more useful replacement experiment.

Live subscription entitlement, memory quality, unattended timers and compressed
history still require acceptance. The existing
[capability matrix](HermesCapabilityMatrix.md) states what has actually been proved.
