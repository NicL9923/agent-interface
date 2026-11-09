# Household experience

The web and native iOS clients add a Today overview, voice messages, editable
Hermes memory, interactive replies and routine recipes. They use the existing
household sign-in and canonical Hermes conversations.

## Personal assistants

A personal assistant is private to its owner in WildBots. Nobody else sees it in
the assistant list, Today, search, saved items, automations, routines,
notifications or group chats, or can open it. A group that includes it exists
only for its owner. Shared assistants, and personal ones created before owners
were recorded, stay visible to everyone.

Anyone may make a shared assistant personal. Both clients first confirm that it
will disappear for the rest of the household. Only its owner can share it again.
Someone with that assistant open returns home with a short message.

WildBots hides the assistant; Hermes does not. The Hermes dashboard is
household-wide, so anyone with dashboard access can still reach its profile's
memory and logins.

### Privacy limits

Privacy here keeps a personal assistant out of other members' everyday use of
WildBots. It does not stop someone deliberately probing the server.

- A save, upload or download already under way when an assistant becomes
  personal can still finish for the person who started it.
- The shared computer is one household desktop. Anyone watching it can see a
  personal assistant using it; WildBots only leaves out the assistant's name.
- Someone guessing assistant IDs can still tell some hidden assistants apart
  from IDs that never existed.
- After an assistant is deleted, a former sender can still look up the receipt
  of their own message.
- While a Hermes update is waiting, "An assistant" in the busy list shows that
  some assistant is working, without saying which.
- Hermes keeps no boundary between profiles on the host. An assistant with the
  terminal, code or file tools can read or write any profile's files. The add-on
  stops a main assistant from running the Hermes command line or writing into
  another profile through those tools, but that is a guard against mistakes,
  not a boundary.
- Routines of assistants other than a main one can deliver into another
  assistant's Bot Chat, as Hermes allows today. A personal assistant's routine
  can post into a shared assistant's chat, a shared assistant's into a personal
  one's, or into another member's, and a result already queued keeps its
  destination after either assistant's sharing changes. WildBots checks only
  group-chat destinations against sharing. Closing this for every assistant,
  with a migration for results already queued, is follow-up work on the branch
  `t3/routine-delivery-privacy`.
- Making an assistant main waits for its routines' runs and held deliveries,
  but that check is best-effort for each routine's latest run only. Hermes
  records a routine's unfinished Bot Chat receipts per run and overwrites that
  record on the next run, so an older run's unfinished delivery can stay
  hidden and the assistant can still become main. That delivery's content was
  produced under the rules for an assistant that wasn't main, and it would
  have been delivered whether or not the assistant became main, so becoming
  main adds no new exposure. It is part of the cross-profile routine delivery
  limit above, taken up on `t3/routine-delivery-privacy`.

<!-- Main assistant: begin -->
## Main assistant

Each member can make one of their own personal assistants their main assistant, on
web and iOS. Shared assistants and personal ones without a recorded owner can't be
one: routines, delivery and followers belong to the assistant's profile, so only an
owned personal assistant keeps check-ins private to that member. The picker says
why each other assistant can't be chosen and offers **Make it personal**, which
opens its settings.

The main assistant leads home, above the pinned ones, with a **Main** mark, and
appears nowhere else on home. It is first in the command palette and the iPad
"Go to…" switcher, whose **Ask** entry puts the typed words in the main
assistant's draft for review. A member without one sees a suggestion card,
"Choose a main assistant: it checks in on what's coming up and hands work to your
other assistants," until they choose or dismiss it. **Make main** in an
assistant's details sets or clears it in one tap. Deleting the assistant, sharing
it, or losing it any other way clears it. Sharing your main assistant asks first
and turns off its check-ins before anyone else can read its chat.

### Check-ins

**Check in with me** in the main assistant's details is off by default. On, the
server keeps one routine named Check-ins on that assistant, running every 1 to 4
hours (2 by default) on a Hermes interval schedule. Its instructions carry the
member's timezone and tell the assistant to stay silent overnight there, to look
over connected calendars, email and task lists and the recent conversation, and to
speak only for something that clearly needs the member soon. When nothing does,
it answers with Hermes's `[SILENT]` marker. A silent, failed or stopped check-in
sends no notification and adds no Today entry, and no unread dot appears because
Hermes delivers nothing to the chat. Only a failed check-in shows as a run card in
the chat; one that found something is its own message there. Check-ins are not
listed in Today's scheduled work.

The routine shows in routine lists as Check-ins, managed from the assistant's
details: it can't be edited, paused or deleted as a routine. Turning the switch
off, choosing another main assistant, sharing or deleting the assistant, and the
member leaving the household all remove it. The server records each check-in job
it creates and also marks its instructions with the member, signed with this
installation's secret, so a job created after a lost answer is found and adopted,
and a copied marker is never trusted. A check-in must deliver only to its own
assistant's chat, with no failure delivery, rooms, scripts or other overrides,
and any native setting the app does not read, such as a monitor script or a
working directory, counts as one, while the scheduler's own bookkeeping, such
as its claim on a run in progress or its record of the last dispatch, does not; a job like that is deleted and replaced. No
replacement is made while an earlier check-in could still run: a run in progress
must be seen to end, and pausing alone does not count. A completed run of a check-in this server
has not recorded yet is still quiet, because discovery checks the job first. It reconciles after every
change, at startup and every five minutes; a run in progress is stopped before its
job is deleted. A Hermes without routines hides the switch.

### Hand-offs

Hermes lists every assistant in each one's instructions and lets any of them
message any other. WildBots narrows that for every assistant, not only main ones:
the server sends each its roster, and the Hermes add-on lists and lets it reach
only that roster. A personal assistant's roster is its owner's other personal
assistants and the assistants the whole household sees; a shared assistant's,
or an older one's without an owner, is only the latter. Another member's personal
assistant is never listed or reached. The add-on sends each hand-off to exactly
the assistant it checked, by its Hermes ID, and refuses one whose ID is also a
registered peer gateway's name or is not a live local assistant, since Hermes
would send those elsewhere. Before an assistant's sharing changes, Hermes stops
listing it and stops it reaching anyone; if Hermes does not take that, the
change is refused. Rosters go to Hermes one at a time, each built from who sees
what when it is sent. An assistant the server has not described yet reaches
nobody.

A main assistant's routines post only in its own chat. Its own use of Hermes's
cron tool may list, pause, remove and stop routines, and create ones that name
its own chat as their only destination, with no script, monitor, working
directory or context source; changing, resuming or running one happens in
WildBots. WildBots's own routine saves (paused or not), resumes, trial runs and
event triggers refuse a main assistant's routine that posts anywhere else:
another assistant's chat, including the member's other personal ones, a group
chat, a messaging platform, or "where it was made" (`origin`). An assistant
can't be made main while any of its routines posts elsewhere, or while one is
running or Hermes still holds a delivery from it, wherever it posts: a run in
progress and a held delivery keep the routine as it was when they began. The
refusal names them. Hermes holds an assistant to a main assistant's limits
before WildBots records the choice, so the choice never runs ahead of them; if
Hermes doesn't take them, nothing changes.

Protection is the default while WildBots doesn't know. Until its first
successful look at Hermes's routines after it starts (one that actually listed
them, not one Hermes answered as unavailable, as it does while disconnected), every member's personal
assistant is held to a main assistant's limits in Hermes. After that, an
assistant keeps them while it is a member's main assistant or the last
successful look found a WildBots check-in on it. They come off only after a
look shows neither, taken in turn with every routine change, sharing change
and main assistant choice. Every main assistant request, even one that changes
nothing, waits its turn behind those and decides from what is current then.

A check-in is WildBots's alone. No assistant's cron tool can change, resume or
run one, whatever its designation; only pausing or removing it is allowed. An
assistant also keeps a main assistant's limits in Hermes while any check-in is
still on it, so a check-in Hermes refused to delete when the member cleared or
changed their main assistant can't be pointed elsewhere. The member hears that
the change isn't finished until WildBots removes it.

On each turn the main assistant also reads that roster as guidance and can hand
specialist work to it with Hermes's agent-message tool. A message to a shared assistant first asks
the member, through the usual question card, "Send this to Ranch Hand? Everyone
in the household can read its chat," with the message shown; nothing is sent
unless they choose Send it. Hand-offs to the member's own personal assistants need
no approval. Roster changes reach the assistant on its next turn. A hand-off in
a transcript offers **Open Ranch Hand's chat** when the reader can open that
chat. An add-on older than this gate gets no roster, and its assistants behave as
before. The roster protocol is versioned: an add-on that speaks only the first
version gets main assistants' rosters alone and leaves the others as Hermes has
them, and a roster without a main flag, from an older server or journal, is
treated as a main assistant's, so it still asks before shared hand-offs.
<!-- Main assistant: end -->

## Today

Open Today in the assistant navigation. It shows pending approvals and questions,
current work, recorded results since you last caught up, and recent attachments.
Open a row to return to its assistant. Mark caught up advances the read marker for
your account across web and iOS, using the exact page's durable event frontier.
Late-arriving completions remain unread even if their original event time is
older. When more results are waiting, marking one page loads the next page.

An assistant that cannot be checked has unknown activity. Loaded results remain
visible after a failed refresh with an explanation that they may be out of date.
The overview checks again every 30 seconds while it is open and the page or app is in use, and once on return. Pull to refresh on iOS. "Checked" shows when this device last checked; an unchanged overview is not downloaded again.

## Voice

Web recording needs HTTPS or localhost, microphone permission, and a browser with
MediaRecorder support. Record up to two minutes or 8 MiB, then stop. Hermes
transcribes the audio into your draft. Review it before sending. Transcription
never submits a message. A failed web transcription keeps the recording for an
explicit retry or discard.

The speaker button in each assistant reply's action row uses the selected Hermes profile's configured speech provider and
that stored, completed reply, one reply playing at a time. The server returns private audio through a
short-lived, single-use URL bound to the signed-in account. Stop speaking ends
playback. Provider credentials stay in Hermes. If no speech provider is available,
the app explains the missing configuration.

iOS records an M4A voice message and shows the transcription for review before
adding it to the draft. Listen to reply plays the same Hermes audio as the web and
has a stop control. iOS cannot play Ogg or WebM speech and says so. Microphone and audio behavior on a physical phone require separate
device acceptance.

### Live Talk

Talk, beside Record voice in the composer on the web and in the iOS app, holds a live spoken conversation
with the open assistant. A voice model listens and speaks; the assistant does the
work. Each real request goes to the assistant as an ordinary message from the
person speaking, in their words, so it appears in the chat, uses the same
admission and steering as typing, and never sends twice for one spoken request.
While the assistant works, the voice says a short filler and then reads the
answer back briefly. A spoken request that starts a new turn runs on Hermes's
voice route at the reasoning effort set for it, `low` in this household, so it
answers faster than the same words typed. Long answers end at a sentence and point to the chat. When
an approval or a question is waiting, the voice asks the person to check the
screen, and reads the answer once they decide.

The panel above the composer shows whether Talk is connecting, listening,
thinking, working or speaking, the latest words from each side, Mute and End.
Starting Talk stops a reply being read aloud and turns off recording and read
aloud until it ends. Talk ends when you press End, switch assistants, leave the
chat or the page, after five quiet minutes, after 30 minutes, and in a phone's
browser when the page goes to the background. The voice knows only this
assistant's name and description.

Talk needs the WildBots voice plugin enabled in Hermes and the launch profile
signed in to ChatGPT; see [Hosting](Hosting.md#live-voice-plugin). When it is
unavailable, Talk shows why. A denied microphone, a signed-out ChatGPT account
and a lost connection each have their own message. Each person can start Talk
once every five seconds and 20 times an hour.

Each assistant has a Talk voice in its settings, under **Voice**: Alloy, Ash,
Ballad, Coral, Echo, Sage, Shimmer, Verse, Marin (the default) and Cedar. Each
has a short sample to play; one plays at a time, and closing settings stops it.
Choosing a voice saves it for the household with the assistant's profile.

In the iOS app, Talk sits beside Record voice whenever the keyboard is down, and
the Talk to assistant control in Control Center, on the Lock Screen and on the
Action button starts it, or a voice message where Hermes offers no live Talk.
Talk keeps going with the screen locked, and Apple's voice processing cancels
the voice's own echo, so you can interrupt it without headphones. A phone call
or another app taking the audio ends it.

## Memory

Assistant settings > Memory & learning reads the selected Hermes profile's native notes and
user facts. Correct entries or forget them, then save. Each document has a
revision guard checked inside Hermes's native file lock. If another person or
native tool changes it first, your edits stay available for review instead of
overwriting the newer memory. Hermes's content checks, character limits and
disabled-memory settings still apply.

The profile label describes the real scope. WildBots shows a personal
assistant's memory only to its owner, but anyone with Hermes dashboard access can
still read and change it. App edits refresh the canonical Bot Chat's memory at
its next safe turn boundary. A running turn keeps its current snapshot. The panel
distinguishes pending, next-turn and applied status. Refresh preserves the native
session, history, approvals and task identity. Native memory-tool writes keep
Hermes's usual snapshot behavior, and other native conversations are unaffected.

## Approvals, questions and steering

An approval card shows what Hermes asks to run and the choices Hermes allows for that
request. Allow once runs this command. Allow for this conversation lets the assistant
run that kind of command in this chat without asking again. Always allow, under More
choices, asks first: it names the kind of command, such as "recursive delete", and
says the assistant will run any command of that kind without asking, in every
conversation, until someone removes it in the assistant's Access settings under
Always-allowed commands. Removing one takes effect at the assistant's next command in
WildBots, on every qualified Hermes. Another Hermes app, such as Discord, may keep
allowing it until its chat ends or Hermes restarts. Anyone who can see the assistant can remove one. Only an
integration administrator can turn on Auto-review routine commands, which lets
Hermes's own guardian run commands it judges safe and send the rest to a person, who
can then allow only once. Notifications keep Review and Decline only.

Decline stops that step. The card folds to "Declined. The assistant stopped that
step." and the message box asks what to do instead, until the next message is sent.

When Hermes recommends one answer to a question, the card tags it Recommended and,
for a single choice, chooses it already, so one tap sends it. Several choices are
never chosen for the person.

A message sent while the assistant is working joins the task it is on. Once Hermes
admits it that way, it shows "Added to the current task" on every device.

## Interactive replies

In assistant Details, choose Enable interactive replies and save. This adds
readable schema instructions to the assistant's editable instructions. It does
not replace existing instructions or silently change other assistants.

Replies can include a fenced `agent-ui` JSON document with `version: 1` and a
`cards` array. Supported card types are:

- `checklist`, with a title and items containing an ID and text.
- `itinerary`, with a title and items containing an ID, title, optional time,
  detail and HTTP or HTTPS link. Add personal timing or travel notes to an item.
- `event`, with a title, an ISO timestamp with an explicit timezone offset,
  optional later end timestamp, location and description.

IDs contain letters, numbers, underscores or hyphens. Documents are limited to
eight cards and 60 items per card. Invalid JSON, unsupported fields, ambiguous
IDs or invalid dates remain readable code. Cards never run arbitrary HTML or script.

Checklist selections and itinerary notes are saved for your account. The original
assistant proposal stays in the canonical conversation. The server verifies card
and item IDs against that message before saving state. Calendar proposals require
review. Web opens an editable Google Calendar draft or downloads an ICS file;
iOS opens the system event editor, where you choose whether to save.

### Email drafts and forms

Two more card types need no setting. Hermes receives their format with the inline
view instructions in every WildBots conversation.

- `email`, with a title, a body, and optional `to` and `cc` address lists and
  subject. **Open in Mail** opens a `mailto:` draft in the device's mail app,
  **Open in Gmail** opens Gmail's compose window, and **Copy** copies the whole
  draft as text. Nothing is sent from WildBots.
  <!-- BEGIN draft revisions -->
  A revised draft names the draft it revises in its `id`: `NEW__revises__EARLIER`,
  where EARLIER is the earlier card's id up to any `__revises__`. The card shape
  is unchanged, because the first clients with email cards refuse any other field.
  An id holds at most 80 characters, lineage included, or the whole block shows as
  code; the guidance asks for short draft ids and, when a revision id would be too
  long, a new short id without lineage, which keeps the email without highlights.
  A card that revises an earlier email card in the same conversation shows the
  recipients, subject and body words it added and removed, with **Hide changes**
  and **Show changes**. Only that explicit lineage links drafts; subjects and
  recipients are never matched. When several earlier cards share the name, the
  latest wins; a card cannot revise itself or a later card. Changes compare word
  by word: runs of spaces, tabs and line breaks, and runs of everything else. Past
  a million compared word pairs the changed middle shows as replaced whole. The
  rules are in `src/shared/draft-diff.ts`, mirrored by iOS's `DraftDiff.swift`
  with shared vectors in `ios/AgentInterfaceTests/Vectors/draft-diff.json`;
  `tests/fixtures/reply-cards-c2fae16.ts` keeps the released parser to prove
  older clients still show these cards.
  <!-- END draft revisions -->
- `form`, with a title, optional description and submit label, and 1 to 20
  fields. Field kinds are `text`, `textarea`, `number`, `date`, `select`,
  `choice`, `multi` and `toggle`. `select`, `choice` and `multi` carry 1 to 20
  options. A field can be `required` and can suggest a starting `value`.

**Send answers** posts the answers as your own message, written as the form's
title and one "Label: answer" line per answered field. It goes through the same
durable admission as the message box and never reads or changes your draft. If
you ticked "I've reviewed the task's last actions" after an interruption, the
answers go under that review too.

The request ID is derived from a key only your devices receive, the message, the
card and an attempt number, so every tab and device sends the same request, the
server admits it once, and nobody else can work out the ID to claim it first. An
answer whose outcome is unknown is checked by that ID, across reloads, until
Hermes settles it. Answers you have typed are kept on the device until you send
them. A refusal before Hermes sees the answers keeps the same attempt; a refusal
from Hermes moves to the next one. A Hermes restart marks the request
interrupted, which does not say whether the answers arrived, so the card asks you
to check the conversation and offers to send them again as a new attempt. A sent
form folds into a read-only list of your answers. Another tab or device that
opens the form skips refused attempts and finds the one that was sent or
interrupted.

Web and iOS show both types. iOS opens a draft in Mail or Gmail and sends a form's
answers under the same request IDs as the web, so a form sent from one is shown as
sent on the other.

### T3 Code threads

An assistant connected to T3 Code's MCP server can start a T3 Code thread with
`t3_thread_launch`. The conversation then shows a card between the turn's folded
work and its reply: the thread's title, the start of its first prompt, the model,
the workspace and **Open in T3 Code**. While the launch runs, the card says the
thread is starting; a failed launch shows T3 Code's reason. WildBots does not read
T3 Code, so the card describes the launch, not the thread's later progress.

T3 Code gives outside MCP clients a hosted `https://app.t3.codes/threads/...`
link, which offers the desktop app, the mobile app or the browser. A
`t3-thread://v2/` link is rewritten to that hosted link. Any other link, or one
that is not HTTPS, opens nothing. The card recognizes the tool under any MCP
server name Hermes gives it, such as `mcp_t3code_t3_thread_launch`. See
[connecting T3 Code](Integrations.md#t3-code).

## Inline views

Web and iOS conversations render an assistant's `wildbots-html` fence as an
interactive view. Ordinary `html` fences, user messages, tool output, invalid
documents and unfinished fences stay readable code. The JSON has exactly three
fields and a 100,000 UTF-16 code unit limit, including JSON syntax:

````text
```wildbots-html
{"version":1,"title":"Supply calculator","html":"<!doctype html><html><body><label>Bales <input id='bales' type='number' min='0' value='12'></label><p id='days'>24 days</p><script>bales.oninput=()=>days.textContent=(Number(bales.value)*2)+' days'</script></body></html>"}
```
````

Use self-contained HTML, inline CSS, vanilla JavaScript, SVG and data images.
External libraries, fonts and images cannot load. A view has no app API access,
cookies, local storage or action bridge to Hermes. Controls can calculate,
filter, expand or draw within the view. They cannot send messages, approve work,
or save changes. Use the existing checklist, itinerary and calendar cards when
those saved actions are needed, and a form card to collect answers. Keep a short text explanation outside the view
for notifications and other clients.

The host supplies `--background`, `--foreground`, `--muted-foreground`, `--card`,
`--border`, `--primary`, `--primary-foreground` and `--radius`. Use fluid widths,
accessible labels and content-driven height. The frame grows from 80 to 1,600
pixels and scrolls for longer content. Avoid `100vh` in generated content.
Reset view reruns the document. View source exposes the original HTML.

The web uses an opaque sandbox inside a static relay at `/inline-ui`. The relay
allows only `about:` child frames, which also blocks the generated frame from
navigating to an external page. The app keeps its existing script policy. iOS
uses a nonpersistent WebKit view with the same nested sandbox and a navigation
delegate that cancels external loads. The only host messages report view size,
loading and theme. Generated views never receive application credentials.

This isolates the application account; it is not a complete browser network
sandbox. Browser channels such as WebRTC are outside `connect-src`, and support
for CSP's separate WebRTC restriction varies. DNS hints can also sit outside
ordinary resource loading. The shell turns off DNS prefetch and the agent
instructions prohibit those APIs, but those measures are not a network security
guarantee. See the [CSP WebRTC directive](https://www.w3.org/TR/CSP/#directive-webrtc)
and its [browser implementation issue](https://bugzilla.mozilla.org/show_bug.cgi?id=1783489).
Do not put credentials in a generated view.

The Hermes add-on supplies the format instructions through
`ephemeral_system_prompt` while an unresolved app-submitted turn invokes the model. It keeps
existing ephemeral instructions and restores them afterward, including on
failure. User text, durable receipts, profile instructions and skill selections
stay as saved. No separate skill installation or assistant setting is required.
The add-on matches the active durable app receipt and skips background or
attributed bot messages. Standalone scheduled jobs
need the format in their routine prompt if they should produce a view.

Deploy the app and updated Hermes add-on together through the usual qualification
workflow. The shared format instructions and shell are included in the
integration digest, so an old qualification receipt cannot qualify this release.

## Routine recipes and trials

Morning brief, weekly meal plan and VPS health digest presets fill the existing
routine editor. New recipes start paused. Choose notification recipients; a
personal assistant's results reach only its owner. Then
preview the schedule before enabling it. The preview reports the actual Hermes
profile timezone and its next three runs, or the one scheduled run for a one-shot.
Presets use connected sources and do not authorize purchases or server changes.

Try once executes the saved instructions through Hermes's native scheduler. It
records a durable request ID before native admission. Hermes applies its normal
schedule and repeat rules: the next run can move and a one-time routine can finish.
Paused recurring routines remain paused. Rechecking or retrying that same ID cannot create another trial. The
receipt follows the native execution ledger, including detached native workers.
An uncertain outcome requires review. The app does not silently start another
run, and it blocks routine edits while a trial's outcome remains unconfirmed.

## Work and learning

Assistant settings > Automation provides native goals, tasks and event triggers on web
and iOS. Each section reports whether the installed Hermes supports it. Refresh
status after an uncertain response; the clients never replay a mutation on their
own.

A standing goal saves paused with a continuation-turn budget. Resume starts a
real task through the app's durable admission journal. Pause and Clear remain
available during execution. An interrupted task requires explicit review before
another admission. Resume requests retain their identity while their outcome is
uncertain. After reviewing the conversation, the person can explicitly start a
new attempt with a fresh request ID. Replacing a goal requires confirmation
because it resets progress and removes native subgoals, completion contracts and
verification gates.

The task board lists this assistant's work on Hermes's current board. New tasks
start blocked. Choose a visible assistant, edit instructions and priority, add
same-owner dependencies, then Start. Hermes owns dispatch and worker claims.
Request review hands an unclaimed ready task to a chosen reviewer. An active
native reviewer owns requests for changes; WildBots does not take over its claim.
Tasks assigned to a hidden personal assistant and private dependency edges remain
hidden. The overview shows the newest 100 visible owner tasks and reports when
older tasks were omitted. Choosing Unassigned clears the native assignment.
If a create response is lost, Refresh status checks for a new task with the same
title. A possible match locks the draft for review; nothing is resent automatically.

Event triggers target an existing routine in the same profile. New triggers start
disabled and return a signing secret once. Copy it to the event sender before
leaving; the clients never persist it. An integration administrator can create,
edit, enable or delete triggers. Hermes's webhook channel must be enabled by the
installer, and the target routine must be enabled. Hermes owns event verification,
filtering, admission and delivery. A lost creation response cannot reveal the
secret again; inspect the disabled trigger and replace it if needed.

Behavior's skill rows show installed skill documents and their locks. Memory &
learning shows pending changes. Read the actual
diff before approving or rejecting it. The decision names that diff's revision,
so a changed skill requires another review. Oversized diffs cannot be approved
here. An uncertain skill decision requires native inspection before another
attempt. Integration administrators control whether Hermes requires approval for
skill writes; ordinary assistant editors can review pending changes.

Routine Advanced options select skills, a provider/model pin, toolsets, an
existing profile script, script-only execution, and previous results from this
assistant's other routines. Script-only execution skips its model call, but
delivery to Bot Chat starts a separate model turn. Context sources supply their
latest saved outputs and do not impose execution order. Cycles and cross-profile
dependencies are refused. Omitted native settings stay saved during edits. Scripts must exist
inside the profile's scripts directory. Hermes's dashboard cannot save a new empty
toolset selection safely, so WildBots rejects that change and preserves existing
zero-tool settings.

## Integration and release

The add-on provides finite, service-authenticated experience and automation
endpoints. They call Hermes's native stores and scheduler under their existing
profile context.
Voice uses the existing native transcription and speech endpoints. The service
bridge excludes the native voice configuration endpoint, which can contain secrets.

The new integration files and native experience probe are included in the exact
qualification digest. Release activation requires fresh disposable-home
qualification and the existing private Google and shared-OAuth regressions.
No Hermes version upgrade is required.
