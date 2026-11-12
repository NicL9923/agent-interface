# Replacing Hermes with wrapped agent harnesses

Decided November 12, 2026 (UTC, as the ledger dates entries). It replaces the experiment in
[HarnessAssessment.md](HarnessAssessment.md) as the direction. Hermes stays the runtime until step 7 retires it.

## Why

Measured on production on November 11 and 12 (see `docs/ledger/20261112T*.md`):

- Opening the longest chat took 6 to 14 s. Hermes read and projected its whole 8,805-row history and re-parsed
  2,420 shell commands for labels, and the web client waited for two such reads in a row. Fixes in the same week
  brought a warm projection to about 0.15 s, and step 1 below removes the rest.
- One assistant's whole-history read held Hermes's one Python process and its one socket, so every other
  assistant's reads went from 0.1 to 0.2 s to 1.7 to 6.5 s meanwhile. Those reads are now windowed.
- The add-on that makes Hermes fit this product imports 72 Hermes modules, uses at least 47 private symbols and
  replaces about 70 native functions at runtime. Each Hermes upgrade can break any of them.

The first two are fixable on Hermes, and step 1 fixes them for good. The third is the reason to leave: the
product's core behavior lives in another project's private internals. Mature harnesses run turns well; the
parts that are the product should be ours.

## Shape

WildBots owns the system of record. Harnesses only run turns.

| Owned by WildBots | Run by a harness |
| --- | --- |
| Bots, their instructions, harness, model, speed and reasoning settings | The model call and tool loop |
| The visible transcript, paged and searchable, and its file references | Context management inside a harness session |
| Memory and skills, with learning and cleaning | Streaming, and steering or interruption where the harness supports it |
| Routines, goals, tasks and triggers, and the scheduler | Tool execution |
| Questions, secret requests, receipts, notifications, drafts, read positions, presence | |
| The MCP tools every harness gets | |

The app API stays. Clients gain a harness choice and drop Hermes-only screens: Hermes updates, the Discord status
card and ChatGPT banked resets in Usage. The server's `Runtime` interface (`src/shared/types.ts`) gets one adapter
per harness, with capability flags for what that harness supports, as `HarnessAssessment.md` already requires.

## Harnesses

Integrations follow T3 Code's approach: each harness's own CLI or SDK in a child process, driven through its
structured protocol, never terminal output. T3 Code is MIT licensed, so we may reuse its code and replay fixtures
with attribution.

| Harness | Integration | Full permissions | Steering |
| --- | --- | --- | --- |
| Claude Code | `@anthropic-ai/claude-agent-sdk`, TypeScript | `permissionMode: "bypassPermissions"` with `allowDangerouslySkipPermissions: true`; it refuses to start as root | Messages queue for the next turn |
| Codex | `codex app-server`, JSON-RPC over stdio | Sandbox `danger-full-access`, approval `never` | Native |
| Grok | Grok Build, `grok agent stdio` over ACP | Permission requests approved automatically | Messages queue for the next turn |
| OpenCode | `@opencode-ai/sdk` against `opencode serve` | Permissions set to allow | Messages queue for the next turn |

The steering column is the expected result, confirmed by each adapter's capability flags in step 3. Without native
steering, a message sent during a turn waits and starts the next turn, and the app says so.

Each bot picks a harness and a model. The model catalog comes from each harness: Codex `model/list`, the Claude
SDK's models, OpenCode's providers and Grok's CLI. Before step 7 every current bot's provider maps to a harness;
Nous Portal and Gemini have no named route yet and would go through OpenCode.

Full permissions means no approval prompts and no sandbox, as Nicolas decided. Each harness still runs as its
owner's own Unix user: one account per member for their personal bots and one household account for shared bots,
each with a 0700 home. The app database, vault, OAuth tokens, memory and other owners' subscription logins stay
under the server's user and are reached only through MCP. Without that, any bot, including a shared one a child or
a prompt-injected page drives, could read every member's tokens and private chats, and the README's promise that a
personal assistant is private would be false.

A visible chat runs forever; harness sessions do not. At a task boundary, the server starts a new harness session
when the current one passes a context budget or the bot's memory or instructions changed, and hands it the recent
turns, memory and the task's open state. It never rotates a running task or drops pending questions, secret
requests or a human takeover. Changing a bot's harness also starts a new session with a handoff; hidden reasoning
and harness-internal state do not move. A task lost to a crash is never re-run automatically, on any harness; it
waits for review, as today.

## Credentials and subscription terms

Checked November 12, 2026 against each vendor's current terms and docs. Consumer plans for Claude, ChatGPT and Grok
belong to one person: each vendor's terms say you may not make your account available to anyone else. So a
shared assistant, or another member's personal one, cannot run on Nicolas's subscription. Pay-per-token API keys
can: the developer agreements read allow the key owner to serve his own users.

| Credential | Nicolas's own assistants | Shared or other members' assistants |
| --- | --- | --- |
| Claude Agent SDK on Nicolas's Pro, Max or Ultra login | Allowed with conditions | Not allowed |
| Claude Agent SDK on a Console API key | Allowed | Allowed |
| Codex app-server on Nicolas's ChatGPT login | Pending OpenAI; API key until then | Not allowed |
| Codex on an OpenAI Platform API key | Allowed | Allowed |
| Grok Build on Nicolas's X subscription | Allowed | Not allowed; a member may use their own xAI team-plan seat |
| Grok Build on an xAI API key | Allowed | Allowed in principle; xAI's Enterprise Terms are unread, so read them first |
| OpenCode with an OpenRouter key | Allowed | Allowed |
| OpenCode with a Claude plan login | Not allowed | Not allowed |

- Anthropic says plan limits "assume ordinary, individual usage of Claude Code and the Agent SDK" and bars routing
  "requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users"
  ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)). Max and Ultra include $100 and
  $200 of monthly API credits usable from a linked Console organization's key
  ([API credits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers),
  [plan notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan),
  updated October 7, 2026). That is the natural way to pay for shared Claude assistants. When the credits run out,
  API requests stop unless pay-as-you-go is on, and shared Claude bots go quiet until the month resets.
- OpenAI's app-server docs say its authentication "has never been permitted for commercial or hosted services"
  ([app-server](https://learn.chatgpt.com/docs/app-server)) without defining "hosted". OpenAI recommends API keys
  for automation. Whether a server Nicolas runs for himself counts as hosted is open; the Sign in with ChatGPT
  interest form ([guide](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)) is the way to ask.
- Grok Build speaks ACP through `grok agent stdio`, with either the subscription login or `XAI_API_KEY`
  ([CLI reference](https://docs.x.ai/build/cli/reference)). Individual plans are for one person; team plans give
  each member a seat ([team plans](https://docs.x.ai/x-subscription/team-plans)).
- OpenCode removed its Claude plan login at Anthropic's request
  ([PR #18186](https://github.com/anomalyco/opencode/pull/18186)), so OpenCode uses OpenRouter or API keys.
  OpenRouter's account holder must be 18 or older ([terms](https://openrouter.ai/terms)).
- Minors: Claude accounts are 18 or older. Serving a child through Anthropic's API requires age checks, content
  filtering, monitoring and telling them it is an AI
  ([guidelines](https://support.claude.com/en/articles/9307344-responsible-use-of-anthropic-s-models-guidelines-for-organizations-serving-minors)).
  OpenAI requires parental consent for minors ([terms](https://openai.com/policies/terms-of-use/)).

The data model enforces this where it is configured, not only when a bot runs. Every credential has an owner and a
kind. A subscription credential is allowed only for a named pair of vendor and owner: today Nicolas for Claude and
Grok, Codex once OpenAI answers, and another member only on their own xAI team seat. Every action that widens who
can reach a bot checks the rule and is refused if it would break it: sharing a personal bot, adding it to a group
chat, a hand-off from another member's bot and a routine posting into a group chat. Owners sign in on the host
through each vendor's own CLI flow, such as `claude setup-token` or Codex's device sign-in, into their own Unix
account; WildBots never reads, stores or relays the tokens, which Anthropic's legal page forbids.

## Memory and skills

Each bot has server-owned memory, facts about the household and the people in it, and a skills folder of
instructions and resources for recurring tasks. Both are versioned in the app database, so every change can be
shown and undone. Harnesses see them read-only; edits go through the server.

- Every harness gets them through a WildBots MCP server: read, search and propose-edit tools for memory and skills,
  a search over the bot's past chats, and generated `CLAUDE.md` or `AGENTS.md` instructions at the start of each
  harness session. The generated instructions also carry the app's reply formats: interactive replies, inline
  views, email drafts, forms and progress lines.
- Each harness's own built-in memory is turned off, so WildBots stays the one record of what a bot knows.
- Learning: after each completed task, a short background review run on the bot's own model proposes memory
  additions and corrections and new or edited skills from the task's transcript.
- Cleaning: a scheduled consolidation run per bot dedupes facts, retires stale or contradicted ones and merges
  overlapping skills, within a size budget.
- The app shows what was learned or cleaned, when and from which task, with undo. Whether reviews apply at once or
  wait for approval is a per-bot setting.
- Hermes's existing `MEMORY.md`, `USER.md` and skills import as the starting state.

## Routines

A durable scheduler in the app database starts harness runs: cron and one-off schedules, time zones, missed-run
policy, no overlapping runs of one routine and delivery into the bot's chat and notifications. It carries today's
routine options: try once, script-only runs, model and tool pins, context from other routines and posting into
group chats. A main assistant's check-ins become routines. Goals, native tasks and event triggers move to the same
scheduler.

Each routine has exactly one scheduler of record. A routine moves with its bot in step 7: imported into WildBots
and disabled in Hermes in one step, so it can never run on both.

## Hermes features that move

| Feature | Where it goes |
| --- | --- |
| Questions with options and multi-select | Each harness's ask-the-user call, such as the Claude SDK's question tool and Codex's user-input request, maps to the existing question cards |
| Secret, login and computer hand-off requests | The same request cards, served by WildBots through MCP |
| Attachments: images, PDFs and text, up to 10 files of 20 MB | Passed in each harness's own input format; files a harness cannot read go as paths it can open |
| Speed and reasoning settings, model warnings that need confirmation | Mapped per harness where it supports them, hidden where it does not |
| Shared computer and browser | The computer host moves into the WildBots server; the browser is an MCP server every harness gets |
| Google Workspace and other OAuth tools, per-bot MCP servers in Access | MCP servers with tokens held by WildBots |
| Vault | WildBots, exposed through MCP; redaction applied to transcripts and logs |
| Voice: Talk, read-aloud and transcription | WildBots's own voice service; the realtime plugin moves out of Hermes |
| Image generation | An MCP tool |
| Hand-offs between bots | WildBots, as messages between bots' chats through MCP |
| Group chats | WildBots's own coordinator: a lead assistant, rounds, mentions and threads |
| Per-bot tool and skill toggles | The bot's MCP tool list and skills folder |
| Account usage | Each harness's own usage reporting, where it has one |
| Hermes updates screen | Pinned harness versions with an upgrade check; harnesses never update themselves, so Grok runs with `--no-auto-update` |
| Discord and other gateways | Dropped; the web and iOS apps are the clients |

## Steps

Each step ships on its own and is accepted before the next.

1. **Transcript store.** WildBots keeps its own paged copy of every chat, fed from Hermes, and serves chat opens,
   scroll-back, files, search and Today from it. Backfill every chat, reconcile continuously, then run a shadow
   mode that compares store pages with Hermes's windows before chat opens stop reading Hermes. Compaction rewrites
   and row IDs are part of the comparison. `HermesCapabilityMatrix.md`, which says the app has no history table,
   changes when this ships. The store becomes the source of truth once a bot moves to a harness.
2. **Credentials and the first harness, one bot.** The credential model and its rule above, per-owner Unix users,
   then the Codex adapter for one test bot on an API key: admission, streaming, steering, interruption, receipts,
   questions, and recovery when the harness or the server dies mid-task, using the existing failure probes.
3. **Other harnesses.** Claude Agent SDK, OpenCode with OpenRouter and Grok over ACP, each with capability flags and
   recorded replay fixtures for its protocol.
4. **Memory and skills service,** with learning, cleaning and the review UI.
5. **Routines, goals and triggers** on the new scheduler, for bots already on a harness.
6. **Tool parity** through MCP: computer and browser, Google, vault, voice, images, hand-offs and group chats. The
   minors safeguards above are in place before any assistant a child uses moves.
7. **Move bots one at a time,** with their routines. Before moving, export the bot's Hermes memory, skills and
   history as a rollback copy. Rolling back after new turns means Hermes resumes from that copy plus a summary of
   the turns it never saw. When every bot has moved, retire Hermes and the add-on.

## Open questions

- Whether OpenAI counts a server Nicolas runs for himself as hosted. Until it answers, Codex runs on an API key.
- Whether Anthropic would allow each adult to sign in with their own Claude account inside WildBots; its legal page
  points to sales.
- xAI's Enterprise Terms for shared bots on an API key.
- Whether learning reviews apply at once or wait for approval by default.
