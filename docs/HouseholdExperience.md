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

Listen to reply uses the selected Hermes profile's configured speech provider and
the stored, completed assistant reply. The server returns private audio through a
short-lived, single-use URL bound to the signed-in account. Stop speaking ends
playback. Provider credentials stay in Hermes. If no speech provider is available,
the app explains the missing configuration.

iOS records an M4A voice message and shows the transcription for review before
adding it to the draft. Listen to reply plays the same Hermes audio as the web and
has a stop control. iOS cannot play Ogg or WebM speech and says so. Microphone and audio behavior on a physical phone require separate
device acceptance.

## Memory

Assistant settings > Memory reads the selected Hermes profile's native notes and
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
those saved actions are needed. Keep a short text explanation outside the view
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

Assistant settings > Work provides native goals, tasks and event triggers on web
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

Event triggers target an existing routine in the same profile. New triggers start
disabled and return a signing secret once. Copy it to the event sender before
leaving; the clients never persist it. An integration administrator can create,
edit, enable or delete triggers. Hermes's webhook channel must be enabled by the
installer, and the target routine must be enabled. Hermes owns event verification,
filtering, admission and delivery. A lost creation response cannot reveal the
secret again; inspect the disabled trigger and replace it if needed.

Learning shows installed skill documents and pending changes. Read the actual
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
