# Household experience

The web and native iOS clients add a Today overview, voice messages, editable
Hermes memory, interactive replies and routine recipes. They use the existing
household sign-in and canonical Hermes conversations.

## Today

Open Today in the assistant navigation. It shows pending approvals and questions,
current work, recorded results since you last caught up, and recent attachments.
Open a row to return to its assistant. Mark caught up advances the read marker for
your account across web and iOS, using the exact page's durable event frontier.
Late-arriving completions remain unread even if their original event time is
older. When more results are waiting, marking one page loads the next page.

An assistant that cannot be checked has unknown activity. Loaded results remain
visible after a failed refresh with an explanation that they may be out of date.
The web overview checks again every 30 seconds while open. Pull to refresh on iOS.

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
adding it to the draft. Read aloud uses the device's built-in voice and has a stop
control. Microphone and audio behavior on a physical phone require separate
device acceptance.

## Memory

Assistant settings > Memory reads the selected Hermes profile's native notes and
user facts. Correct entries or forget them, then save. Each document has a
revision guard checked inside Hermes's native file lock. If another person or
native tool changes it first, your edits stay available for review instead of
overwriting the newer memory. Hermes's content checks, character limits and
disabled-memory settings still apply.

The profile label describes the real scope. Personal assistant organization does
not isolate household data. Existing Hermes conversations retain their original
memory snapshot until Hermes starts a new session. Saving a memory edit does not
rewrite a conversation's current context.

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

## Routine recipes and trials

Morning brief, weekly meal plan and VPS health digest presets fill the existing
routine editor. New recipes start paused. Choose notification recipients and
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

## Integration and release

The add-on adds one finite, service-authenticated experience endpoint. It calls
Hermes's native memory stores and scheduler under their existing profile context.
Voice uses the existing native transcription and speech endpoints. The service
bridge excludes the native voice configuration endpoint, which can contain secrets.

The new integration files and native experience probe are included in the exact
qualification digest. Release activation requires fresh disposable-home
qualification and the existing private Google and shared-OAuth regressions.
No Hermes version upgrade is required.
