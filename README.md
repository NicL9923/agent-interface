# WildBots

WildBots is a web client and native iOS app for a shared Hermes installation. The repository and internal identifiers keep the original `agent-interface` name. Each bot has a
persistent conversation, configurable instructions and capabilities, and an avatar
that reflects its current state. Each household member has separate preferences,
drafts and notification subscriptions.

Household installation: [agentui.wildflowersranch.com](https://agentui.wildflowersranch.com).

The web home lists every assistant with its latest message. A dot marks a chat you
have opened before that has a newer message than your last read, on any of your
devices. Pin assistants to show them as large live avatars at the top. In a conversation, the assistant's avatar and
name in the header open its details: Pin, Artifacts, Settings, "Notify me about all
activity" and its home section. Long-press (right-click on a computer) an assistant
on home to pin it or move it to a section. Phones open on home and push into a
conversation; Back returns. The account button opens Settings, which also holds Hermes
updates, Computer, Integrations, the assistants you follow and your home sections.
Each assistant can be in one section. New assistants start with their name and look,
then role and model. On the web, a new assistant's chat opens once it is created.

The self-hoster connects this server to Hermes once. Web users sign in to that
installation. iOS users enter its HTTPS address, then sign in to the same
household. The app keeps the sign-in alive while it is used, up to 90 days after
signing in with Google. The mobile app connects to this server, not directly to Hermes.

Web assistant settings load model options from the connected Hermes profile.
The selected provider starts expanded. Search the catalog, refresh it after
changing connected providers, and star models to keep personal favorites. Shared assistants keep one shared model. Existing selections remain
saved when a provider is unavailable, and Hermes model warnings still require
confirmation. In Advanced presentation, the model chip under the assistant's name in the web and iOS chat headers, with the provider's mark and the model's display name, switches
the assistant's model from the same catalog without opening settings. Simple presentation never shows the model. Display names come from Hermes's cached models.dev catalog through the add-on, and the server formats the identifier itself (`claude-opus-5-5` becomes Claude Opus 5.5) when the add-on is older or does not know the model. Both pickers control reasoning effort and Normal/Auto/Fast/Ultrafast speed for the current
conversation. Auto runs Fast at the start of each reply and drops back to Normal for long work, using Hermes's `agent.service_tier: auto` window (`agent.fast_auto_seconds`, 60 seconds unless the profile sets it). A Hermes without Auto refuses it with the reason instead of saving Normal. On a model without fast mode, Auto runs at Normal speed. The native picker includes search, provider groups, refresh and model favorites. Hermes validates support for the selected model.

An assistant is either shared with the household or personal. A personal assistant
is private to its owner in WildBots: nobody else sees it in lists, Today, search,
notifications, automations, routines or group chats, or can open it. Anyone may make
a shared assistant personal after confirming it will disappear for everyone else;
only its owner can share it again. Personal assistants created before owners were
recorded stay visible to everyone. WildBots hides a personal assistant, but the
Hermes dashboard is household-wide, so anyone with dashboard access can still reach
its memory and logins.

<!-- Main assistant: begin -->
Each member can make one of their own personal assistants their **main assistant**, on
web and iOS. It leads home with a **Main** mark, is first in the command palette, whose
Ask entry sends typed words to its draft, and hands specialist work to the member's
other assistants. A hand-off to a shared assistant asks the member first, because the
whole household can read that chat. **Check in with me** in its details runs a quiet
routine every 1 to 4 hours that speaks only when something needs the member and stays
silent overnight in their timezone. A main assistant's routines post only in its own chat.
Every assistant lists and reaches only its own roster
inside Hermes, so another member's personal assistant never appears in its instructions or
receives its messages. See [main assistant](docs/HouseholdExperience.md#main-assistant).
<!-- Main assistant: end -->

Web Settings > Notifications shows whether this account has notifications enabled
on the current device. Turn the browser switch on or off there. The iOS app asks the
same question in its own card after household sign-in when the server supports Apple
push, shows the system permission prompt only after Enable, and has the same switch
in Settings. Manage device permission in iOS Settings. A new browser asks once
whether to enable notifications and explains where to change the setting later.
On iPhone or iPad, add the app to the Home Screen and open it before enabling
notifications.

A chat you have open and are using sends no notifications to any of your devices.
Reading a chat on one device stops its pending notifications to the others and
removes its delivered ones from your iPhone and iPad. A browser tab counts while
it is focused and has had input in the last five minutes.

<!-- BEGIN device activity -->
Notifications go to the device you are using. While a browser window is focused
and touched in the last five minutes, or the iOS app is open and touched in the
last five minutes, only those devices get the alert; your other iPhones and iPads
get the new badge count silently, and other browsers update theirs when you next
open the app. With no device in use, or none of those able to receive it, every
device gets it as before. Security alerts always reach every device. See
[Device activity](docs/native-api.md#device-activity).
<!-- END device activity -->

Tapping a web notification while the app is open in a window switches that window to the
chat, as choosing it there would, and brings the window forward without reloading it. Every
tap ends one of two ways: a window known to be in front shows the chat, or the notification
is back on screen, quietly, to tap again. A window counts as in front only when it was focused
already, it came forward when asked, or the worker just opened it; a browser covered by
another application still reports itself visible. The worker follows four rules:

1. No window the worker controls: it opens a new one. If the browser refuses, the
   notification comes back.
2. The page answers its `OPEN_CHAT` message within 250 ms: the chat is open there. If the
   window is in front, that is all; if not, the notification comes back. No second window
   opens, so the chat never shows twice.
3. The page does not answer in time, on a first tap: it may be busy with something a reload
   would lose, such as an edited settings form, so the window is left as it is and asked to
   come forward, and the notification comes back marked as having come back. If the page
   opens the chat late after all, the notification simply stays until it is dismissed or
   tapped; a tap then gets a prompt answer.
4. The page does not answer in time, on a tap of a notification that came back: that is the
   person asking again, so the worker loads the chat's address into the window, or opens a
   new window when that fails. Unless a window is then known to be in front, the
   notification comes back again.

A window running a release from before pages answered gets the notification back on the
first tap and the chat on the second, as taps always did. A notification comes back only
because of a tap, so it never loops on its own. A second tap on the same chat while the
first is still being handled joins it, so nothing opens, loads or comes back twice. A tap
while the notification is coming back may be a tap on that notification, so it starts a new
try at once, and later taps join that one. A notification that comes back is tagged with its
chat, so it replaces one already back for that chat and never a new notification. The worker
waits at most 10 seconds for the browser to say a notification is back. Two cases the rules
cannot cover leave nothing on screen: the browser refuses to show the notification again and
refuses the worker's one further try, or it has neither shown nor refused it after those 10
seconds, when the worker stops waiting and the notification still appears if the browser
finishes later. Each fallback ends well
inside the one second Firefox allows a worker to open a window after a tap.

An open assistant settings sheet or Settings closes the way its close button does before the
chat opens. An edited assistant asks whether to discard the changes, and the chat opens only
if the person discards them. A section name being typed in Settings is saved, or, if it
cannot be, Settings stays open with the reason. The page answers the worker either way, so
the worker never reloads the window over the form. A chat waiting on a sheet belongs to that
sheet and account: if the sheet goes without closing, as when another tab signs in as someone
else, the chat never opens.

A notification or link that names a chat (`/?bot=ID`) starts reading that chat while the
web app checks the sign-in, instead of after. It does so only when this browser signed in
within the session's seven days and that sign-in's last check named the account and listed
the chat, so a signed-out browser or a chat you may not see usually sends no request that
would be refused. Two cases still cost one refused read: a session the server ended early,
such as an account removed from the household, and an assistant made private since the
last check. The app then shows what it shows today: the sign-in screen, or its notice that
the assistant is no longer available. The read is tagged with the account the record names,
and the chat shows it only if the sign-in check answers as that same account and no other
tab has signed out or in meanwhile; otherwise the chat reads again. The early read answers
only the first chat load after the page loads, once, whether it has finished or not; nothing a
person does can come before that load. Every later open of any chat, however soon, reads
fresh, and the chat's change stream reads fresh as it connects. A row's hover or press read
is joined only while it is still on its way; once finished it only fills the response cache,
which the chat shows while it reads again. The response cache keeps the body of the
latest-started read of each path, so a slower, older read that finishes last never replaces
it. The browser keeps only the lapse time, the account ID and the chat IDs, in
`agent-interface:sign-in-hint`, and drops them at sign-out, a refused session, or a check
that finds another account. A link to a message, Today or a group chat waits for the check
as before. See `src/app/linked-chat.ts`.

The browser tab title, favicon and installed app, and the iPhone and iPad app icon,
show how many assistants have unread messages or a decision waiting for you. A web
approval notification offers **Review** and **Decline** where the browser supports
notification buttons, as the iOS notification does. Decline works without opening
the app and can only decline that one request.

An approval card in a chat offers the choices Hermes allows for that request: Allow
once, Allow for this conversation, Decline and, under More choices, Always allow.
Always allow first says which kind of command Hermes will run for that assistant from
now on, in every conversation. A command Hermes's guardian doubted offers only Allow
once and Decline, and an older Hermes keeps Approve and Decline. Notifications never
offer more than Review and Decline. After Decline, the card reads "Declined. The
assistant stopped that step." and the message box asks what to do instead. Each
assistant's Access settings list its always-allowed commands with Remove, and an
integration administrator can turn on Hermes's auto-review of routine commands.
A question's recommended answer is tagged and, for a single choice, already chosen.
A message sent while the assistant works says "Added to the current task" once Hermes
adds it to that task.

## Run locally

Use Node 24.22 or 26.13 and npm. `.node-version` selects the tested Node 24 LTS
release. The lockfile pins application dependencies. See the
[dependency record](docs/Dependencies.md) for versions and verification.

```sh
npm ci
npm run setup
npm run build
npm start
```

Setup asks for the existing Hermes gateway address and token, then checks access
and compatibility before saving a private `.env`. Token entry is masked. Choose
Google sign-in for the household, or explicitly enable local test accounts for
development. A failed check leaves the previous configuration intact.

Open the app address printed by `npm start`, normally `http://127.0.0.1:3000`.
Household members only need to sign in; they never enter the Hermes token.
Local test accounts are refused in production or on a non-loopback host.
An unconfigured installation explains how to start setup from its sign-in page.

After changing configuration, restart the app. Use `npm run doctor` for a
read-only check of the active configuration and Hermes connection. It exits with
a failure status and an actionable explanation when something needs attention.
Exported environment settings override `.env`; setup reports conflicting keys
before writing so a saved change cannot silently be ignored.

For hot reload, set `APP_ORIGIN=http://127.0.0.1:5173`, run `npm run dev` and
`npm run dev:client` in separate terminals, and open port 5173. Vite proxies API
requests to the app server. The built application serves its API and static files
from one Fastify process.

## Web UI components

Shared controls live in `src/components/ui`, with shadcn configuration in
`components.json` and Base UI handling context menus and popovers. Keep the
existing WildBots colors, typography and spacing when adding controls.

Base UI is not part of the first load. Import its components only from modules the
entry reaches through `import()`, such as the assistant menu in `src/app/BotMenuPopup.tsx`.
Until that menu has loaded, `src/app/BotMenu.tsx` stands in for it and catches the first
right click, menu key or long press, so none is lost. `npm run build` fails when Base UI
returns to the entry's static imports.

### Motion and ambience

`src/motion.css` holds the web client's motion layer and loads after `src/styles.css`. Every
animation in it runs only when the system allows motion, and the existing reduced-motion rules
still win.

- On a phone, opening a chat from home and going Back use the View Transitions API. The avatar
  flies between its home row and the chat header while the screens slide. Browsers without the
  API change screens at once.
- A chat with a drawn avatar takes a light tint from the avatar's color in its header, your own
  messages and the composer's focus ring. Photo avatars keep the app's green.
- The chat header lifts with a border and shadow once messages scroll under it. This uses
  scroll-driven animations where the browser supports them.
- While a turn runs, the live row shows its tools as a strip that fills in as each finishes.
- While a reply streams, its text appears at a steady pace instead of jumping a line or two at
  each of the server's updates, up to four a second. Each update is revealed within about a third
  of a second of arriving, however long it is, with at most 30 paints a second, and a reply
  already under way when the chat opens shows at once. A caret at the text's logical end, right of
  Latin text and left of Arabic or Hebrew, or past the line's end where text of the other direction
  touches that edge with no space, pulses until the reply is saved, and follows a code
  block or table scrolled sideways. The text shows at once in a hidden tab, and under reduced
  motion, where the caret stays lit and still.
- When a streamed reply is saved under Hermes's own ID, its row usually stays in place: React
  keeps the same nodes, so a text selection, a code block's copy state and the reader's spot
  survive. That holds when the client sees the saved copy replace the live reply as the one new
  row, with the same text. A progress line never takes the live reply's row, and a live reply that
  starts in the same update as a saved one gets a new row, even when it begins the same way. When
  more than one row lands at once, such as a progress line saved beside the reply, the reply's row
  is built again, as before. A steer or another member's message
  arriving mid-reply starts a new turn, and the live reply moves into it, which also builds its row
  again, so a selection in it is lost. If the saved reply is longer than 25,000 characters, or its
  blocks would parse differently from the whole reply, it is parsed whole in the same row, and a
  selection in it is lost too. The row's time and actions appear in
  space it already held while streaming. Files the turn made still appear below the reply once it
  is saved, since their size is not known before.
- On a computer, pinned avatars glance at a nearby mouse pointer. When a pinned assistant finishes,
  it hops and the other pinned ones look over. Approving a request or answering a question makes
  the assistant cheer, and settled approval cards fold away.
- Dark mode adds a faint glow, rail grain and lit edges on raised panels.
- Home shows the season with a slight accent shift and a few faint drifting shapes. The calendar
  decides first. Between holidays, a pinned seasonal character brings its own season.

While an assistant uses the computer, a small watch-only view of the desktop docks in the
transcript's corner on the web and in the iOS app, with its own ticket that never takes control.
It opens the full computer view, can be dismissed for the turn, and holds no connection when
hidden, dismissed or failed.

The rest of this section is web-only. The avatar conductor and pose math that iOS mirrors are unchanged.

### Crash reports

A render failure anywhere outside a lazy screen shows a "Something went wrong" page with
Reload instead of a blank screen. A lazy screen that cannot load, as when a tab stayed
open across a deploy and the screen's file is gone, says "This screen could not load" with
Reload, and the rest of the app keeps working. The server answers a missing `/assets/` path
with an uncached plain-text 404, never the app shell. The page never reloads itself; Reload
loads the release the server has now, since the worker fetches the app shell from the network
first. Chat and group drafts are written to the device on
every edit, so a reload keeps them. While someone is signed in, the web client sends
that crash, uncaught errors and unhandled rejections to `POST /api/client-errors`: each
distinct report once, at most five per page load, and never chunk-load failures the
screens already handle. The server logs each one as a `Client error` warning with the
person's id and stores nothing. It accepts 20 reports per person every 10 minutes. The iOS
app sends the crashes and hangs that MetricKit delivers on the next launch to the same route,
as `crash` and `hang` reports with `platform: "ios"`; see `docs/native-api.md`.

### Offline cache

`scripts/build-worker.mjs` turns `scripts/service-worker.js` into `sw.js`, and
`scripts/precache-plan.mjs` sorts the built files into three groups. The install step
fetches only the pages and the static import graph of both HTML entries, which is enough
to open offline without racing the first visit. Install fails, and the browser retries it
later while the old worker keeps serving, if any of those files is an error or comes back
as `text/html` in place of code. Lazy screens and libraries are fetched in the background,
three at a time, when the page posts `{ type: "WARM" }` to the active worker after it goes
idle. The worker runs that under `waitUntil` so the browser keeps it alive, never delays
activation for it, and skips files already cached, so any later page load finishes what a
stopped run missed. The terminal and remote desktop chunks wait for first use. A file that
was never warmed is kept after its first use, unless it is an error or `text/html`.
Installing a release copies every hashed `assets/name-HASH.ext` file already held by an
earlier release's cache instead of downloading it again. The pages, icons, manifest and
unhashed files are always fetched fresh. The worker's hashed-name rule must match
`src/server/static-cache.ts`; a test compares them.

The worker opens the app shell (`/` and `/index.html`) from its own release's cache, without
waiting on the network, while it has no sign that the cached shell is out of date. Install
fills that cache all or nothing, so the shell and the code it loads first come from one
release. After each such open the worker fetches the server's `index.html` in the background
and compares the text. The server sends the file as it is on disk, so the text differs only
when a release changed it.

- A different shell means a new release. The worker notes that in its own cache, which
  survives the worker being stopped, and runs the update check at once. From the next load
  on it opens the network's shell, with the cached one as the offline fallback, as it did
  before this change. So after a deploy the old shell opens until one background check has
  finished, which is one load in ordinary use, even if the new worker cannot install. Two
  windows opened before that check finishes both get the old shell. The new release's worker
  starts with a new cache and no note.
- A redirect, 401, 403, server error or no network changes nothing. No window reloads and
  the worker stays, so one bad answer never costs a person their work.
- With no cached shell, as on a first visit or after storage is cleared, the network answers.

A release that finishes installing is offered with **Refresh**, as before; the worker never
switches releases under an open page. The shell is not fetched with navigation preload,
since the cached copy usually answers first.

Tailwind 4 uses the app's CSS tokens through `src/ui.css`. Utilities have a `tw:`
prefix so they cannot collide with existing semantic class names. Preflight is
omitted to preserve native control styling. Keep custom layout, avatar and
markdown CSS where it is clearer than utilities.

Standard shadcn color utilities map to the live WildBots palette: `primary` is
the brand green, `accent` is its soft hover background, and `muted` is a quiet
surface. Use `tw:text-muted-foreground` for subdued text or `tw:text-brand` for
the brand color. Dark variants follow the app's light, dark and system setting.

Preview additions with `npx shadcn@4.22.0 add <component> --dry-run --diff`, then adapt
the generated component to the existing controls, icons and styling. Registry
items can also change `src/ui.css`. The stock card leaves it alone, while custom
items that supply theme variables can append `:root` and `.dark` palettes.
Keep the existing token mappings and dark variant. Map any needed new colors
to app tokens instead of accepting those generated palettes. Do not run preset
or theme initialization over this file.

The `cn` helper and `@/` alias support generated shadcn components. Native
wrappers forward existing classes directly, so they do not load the class
merging helper at startup.

Use the shared `Button`, `Input`, `Textarea` and `NativeSelect` controls in the
migrated settings and panels. `Button` defaults to `type="button"`; form submit
actions must explicitly use `type="submit"`. The shared `Dialog` preserves the
native top layer and owns opening, closing and focus restoration. Pass `open`
for panels that stay mounted while hidden. Nested overlay wrappers inherit the
dialog as their portal container.

## Connect Hermes

Hermes runs separately from this application. Guided setup saves `HERMES_URL` and
`HERMES_TOKEN` on the app server. An existing HTTPS gateway is supported; cleartext
HTTP is restricted to loopback. Provider credentials remain in Hermes. Open
**Integrations** to inspect the selected profile's accounts, check their health,
and connect or reconnect supported services. Connection changes require an
integration administrator. An assistant that needs a service it lacks can ask in
the chat: its card holds that connection's setup and continues once it is set up.
See the [integration guide](docs/Integrations.md) for supported services, one-time
hosting configuration and device limitations.

The [shared computer](docs/SharedComputer.md) provides one persistent desktop and
browser for all assistants, with human takeover for every household member and a
real VPS terminal for terminal administrators. The iOS app shows the desktop on its
own Computer screen with Take over and Hand back; the terminal still opens in Safari.
On a phone, web and iOS add touch controls with a help sheet: two-finger scroll and
right-click, pinch to zoom the view, trackpad mode and clipboard copy and paste.
An assistant can ask for a person in the conversation; the card's Take over opens the
computer with control in one step, and handing back tells the assistant to continue.
While a browser tool runs, the live row offers Watch.
An assistant can also offer the system terminal in chat; its card's Open terminal offers the
suggested command for you to paste at the prompt, never runs it, and Done tells the assistant to
check the result.

The [capability matrix](docs/HermesCapabilityMatrix.md) records the tested upstream
revision, native integration probes, and the small revision-bound extension for
durable admission receipts and event discovery. Read its compatibility and
rollback instructions before using that extension. The app does not directly
edit Hermes databases or take over execution from an existing Hermes owner.
Setup connects to an existing compatible owner; it does not install Hermes or
change its supervisor. A missing add-on, incompatible revision, rejected token,
or unreachable gateway gets a distinct diagnostic. When Hermes rejects the server's
token, requests fail with 502 and keep people signed in to the app.

For a Google-protected Hermes dashboard, run this app on the same host and use
the private service connection described in the capability matrix. This keeps
the permanent server credential separate from expiring household Google
sessions. The original dashboard retains its Google sign-in and address.

Google sign-in requires `GOOGLE_CLIENT_ID`, the app origin registered in the
Google OAuth client's authorized JavaScript origins, and an explicit comma-separated
`HOUSEHOLD_EMAILS` allowlist. Setup collects the client ID and household emails;
Google's external configuration remains a separate step. Production requires HTTPS. Web Push additionally
requires the three `VAPID_*` settings in `.env.example`. Accounts, credentials,
runtime databases and private operating notes stay outside this repository.

After a new release, the web app shows **Update available** at the top of home, and
above the conversation on phones, until you choose **Refresh**. An open tab or installed
app checks for a new release every 30 minutes and whenever it returns to the foreground.
Drafts are saved before it reloads. The iOS app shows the same notice with an **Update**
link when the host sets `IOS_APP_LATEST_BUILD` and `IOS_APP_UPDATE_URL`; see the
[native API contract](docs/native-api.md#app-updates).

During an outage, the app retains loaded conversations and personal drafts,
rechecks the connection automatically, and refreshes when the browser comes back
online or into view. Manual reconnect checks immediately. The transport bounds
stalled requests and backs off repeated failures. It never automatically replays
messages or configuration changes; uncertain admissions are reconciled through
Hermes's durable receipts.
Known native admission refusals return the message to its draft. Crashes and
unrecognized native errors keep the saved request ID for receipt checks.

## Household experience

The app opens **Today** unless you choose an assistant start page or follow a notification. Today shows pending decisions, scheduled work, recent results and files
across your assistants. **Mark caught up** shares your recap position between
web and iOS. Voice messages are transcribed into a draft for review before you
send. The speaker button in any reply's action row reads that reply with Hermes speech on web and iOS, one reply at a time. On the web, **Talk** holds a live spoken conversation with an assistant: a voice model listens and answers out loud while the assistant does the work, passes on what the assistant says it is checking as it goes, and each assistant has its own voice. Assistants say what they will check before slow tool work, and the chat shows that as a quiet progress line; see [Progress lines](docs/HouseholdExperience.md#progress-lines). See [Live Talk](docs/HouseholdExperience.md#live-talk). Each message shows its time under its bubble beside its actions, and a reply made of several parts shows the time once, under the last. A name appears above a message only for another household member or a scheduled prompt. Copy is available on your own messages too.

Hermes questions on web and iOS show each suggested answer as a card to tap, with
**Write my own answer** last. A question that allows several answers shows checkboxes.
On a computer, number keys pick an option. Choosing an answer moves on to the next
question, and Send answers waits until every question has one.

**Search & saved** searches native answers, attachment names, and routine previews across your visible assistants as you type. A match in an assistant's current conversation opens that chat at the message. Results mark the matching words. Open original history, page through older messages, and save a conversation, reply, or routine output. Saved items belong to your account and hold references rather than copied transcripts.

Its **Automations** tab lists next runs, recent execution or delivery failures, result recipients, and pause/resume controls. Usage shows Hermes's recorded main-session tokens, reported cost, and estimates separately. Missing cost reporting stays unknown. Simple conversations show tool receipts with the native outcome and any reported result link.

The avatar at the top of home opens your profile menu: **Usage**, **Settings** and **Sign out**. **Usage** shows plan limits and credits for each provider account your assistants run on, as Hermes reads them from the provider: ChatGPT session and weekly limits with banked resets, Claude sign-in session and weekly limits, OpenRouter credits and key quota, Nous Portal credits, and any provider plugin that reports usage. Each account shows once, with the assistants that use it and whether it is only a fallback. A banked ChatGPT reset can be spent after a confirmation, which warns when no limit is used up yet. Providers without a usage endpoint say so. Usage reads each account at most once a minute, or every 15 seconds with Refresh.

Attach images, PDFs, and text files with the paperclip, by pasting a screenshot or copied file into the message box, or by dropping files anywhere on the conversation. Markdown and CSV files are sent as plain text. Each attachment shows a thumbnail or file card with its upload progress; select an image to preview it. A message holds up to 10 files of up to 20 MB each. Unsupported files are explained instead of uploaded, and a failed upload offers Retry and blocks Send until you retry or remove it, so a message never goes out without a file you meant to include.

An empty conversation on web and iOS offers a role discussion using the assistant's description and adds it to the draft. Settings include a start page, quiet hours in your timezone, and notification batching. Quiet hours delay notifications except security alerts; decisions and failures skip batching outside them. Digest notifications open Today.

The native iPhone app includes a share extension for webpages, photos, PDFs, and text. Choose an assistant, save the share, and open the app to review and add it to a draft. The extension shares no sign-in token. Existing draft content is kept, and nothing sends automatically. HEIC and other unsupported image formats convert to a bounded PNG. Device installation requires the app and extension to be signed with the shared App Group.

The iPhone and iPad app also works with Siri, Shortcuts and Spotlight: ask WildBots to open an assistant or Today, or to put a question in an assistant's draft for you to review and send. Assistant names show in Spotlight search, and the Assistants widget can be edited to show only the assistants you choose. None of these hold your sign-in token, and they clear when you sign out. An iPad with a keyboard opens pinned assistants with Cmd+1 to 9 and any destination with Cmd+K.

Assistant settings has five sections: **Profile** (name, description, sharing,
avatar, live Talk voice), **Behavior** (instructions, model, tools and skills), **Access**
(connections, logins and, in Advanced presentation, MCP servers), **Automation**
(routines, goals, tasks and triggers) and **Memory & learning**. On a phone it
opens on that list. One **Save changes** saves everything in Profile, Behavior and
Access; it stays visible on other sections while those changes are unsaved.
Memory keeps its own Save, and list actions such as adding a routine or a login
save at once.

**Memory & learning** lets you inspect, correct and forget native
Hermes profile memory. Existing conversations keep their memory snapshot until
a new Hermes session starts. In **Behavior**, enable interactive replies to add
checklists, itineraries and reviewed calendar proposals to assistant answers.
Your checks and itinerary notes are saved for your account.

Assistant replies can also contain interactive charts, calculators, diagrams and
small tools inline on web and iOS. These generated views follow your theme and
resize to their content. **Reset view** starts over, and **View source** shows the
HTML. Their controls affect only the view; changes reset when you reopen the
conversation. Hermes receives the format instructions automatically in WildBots
conversations. See [inline views](docs/HouseholdExperience.md#inline-views) for
the reply format and supported behavior.

Assistants can also hand you an email draft to open in your mail app or Gmail, or
a short form to fill in. **Send answers** posts your answers as your own message
without touching your draft. When an assistant connected to T3 Code starts a
thread, the chat shows a card with **Open in T3 Code**. These work on web and
iOS. See [email drafts and forms](docs/HouseholdExperience.md#email-drafts-and-forms)
and [T3 Code threads](docs/HouseholdExperience.md#t3-code-threads).
<!-- BEGIN draft revisions -->
When an assistant revises an email draft from earlier in the chat, the new draft
marks the words it added and removed, with **Hide changes** to read it clean.
<!-- END draft revisions -->

**Routines** includes morning brief, meal plan and VPS health recipes, schedule
previews in the actual Hermes timezone, and **Try once** with durable run
receipts. See the [household experience guide](docs/HouseholdExperience.md) for
controls, supported reply cards, voice requirements and recovery behavior.

In Advanced presentation, routine **Advanced** options include skills,
model/provider pins, toolsets, profile scripts, script-only runs and context from
other routines; Simple presentation keeps saved overrides without showing them.
**Automation** also manages standing goals, native tasks and event triggers.
Behavior's skill rows read and lock installed skills, and **Memory & learning**
reviews proposed skill changes. New work
requires an explicit start. Memory edits apply to the canonical conversation at
the next safe turn boundary, with pending/applied status and preserved history.

Each routine run also appears in its assistant's conversation, in time order with the
messages, as a collapsed card: a status dot, the routine's name, when it ran and a line of
its output. Failed, running and undelivered runs say so in words beside the dot. Open a
card to read the output with its files, save it, or open all results. A run whose output
Hermes delivered into the chat shows once, as that message. Cards follow the loaded
history, so paging back brings in earlier runs, and they update while the chat is open.
**Hide this routine in chat** on a card, with Undo, or **Show runs in chat** in the
routine's settings, keeps a routine such as a certificate check out of your chat. It
is your own setting and doesn't change the routine for anyone else. Run status needs the
current Hermes add-on; with an older one, runs show as "Status unknown".

Use **View results** beside a routine to read its saved runs, including trials.
Routine notifications name the routine and quote the start of its answer, or the
error for a failed run, and open this history directly. Results stay within the selected
Hermes profile; a run with only a saved preview says so.

**Group chats** lets 2–6 local assistants discuss a task in one room. Rooms are rows
in the home list beside the assistants, with overlapping member faces, the last
message and who said it, and its time. Rooms follow the assistants, newest message first, because assistant rows keep
the roster's order and do not jump. Home reads Hermes's room catalog when the household event stream
says this person's rooms changed, when it reconnects or the page wakes, and every 5 minutes as a fallback.
While any household stream is open, the server checks the catalog once for everyone at most every
30 seconds, and right away after a group or assistant change made in the app, and tells only the people
whose visible rooms changed. It adds each room's newest message to the catalog and re-reads a room's log
only when the room has a newer message, so home never polls room logs. Home has no group unread dot, since
the app keeps no read position for rooms. Choose a room to open it like a conversation
(`?view=group&room=ID`; the old `?view=groups` link opens home). Make a group from the **+** button's
New group chat, which opens it. Create a
named group, address assistants with `@handle` (typing `@` suggests members),
reply in a thread, approve a pending action or stop the discussion. Messages show
which household member sent them, and new messages arrive live. While assistants work, the room
names each one, as "Planner is working..."; Advanced presentation adds the tool it is in and its
round, such as "Round 2 of 3". **Group settings** in the room sets its purpose, shared notes
that every assistant reads from the next message on, and an optional lead assistant who picks who
answers a message that names no one; the room then shows each hand-off. Anyone who can open the
room can change them. A routine can also post its results in group chats you choose in its
editor. Its posts show under the routine's name, marked Routine, and assistants answer one only when
it @mentions them. A personal assistant's routine can post only in groups with one of your personal
assistants. While a routine posts in a group, a sharing change, or a new assistant reusing a deleted
one's name, that would let someone who can't see the routine's assistant read the group is refused
until that group is removed from the routine. A group that lists a deleted assistant closes for everyone. These need a Hermes with room
activity and settings, such as `3a1e9ef`; with an older one the room says only that assistants
are discussing, and settings and routine posts stay hidden.
Hermes owns the persistent coordinator.
If that coordinator is unavailable, rooms remain readable and sending is disabled.
After an uncertain send or creation, retry the saved request to check its status
without creating a duplicate. Conversation activity keeps bot messages, scheduled-job handoffs, subagents,
background processes, and diagnostics in separate collapsed sections in both
presentations. Expand them to inspect the original input and results. Scheduled
answers stay in the conversation with a Scheduled label. Decisions and requests
for input stay visible. Unknown messages from other clients remain in chat;
only recognized automation sources move into activity.

Assistant settings > **Access** manages the selected Hermes profile's encrypted
login vault. Native login, code, vault-unlock and secret requests appear inline
with masked fields, outside chat and drafts. Each card shows when it is sending and
when Hermes took the answer, then folds to one line. Sending a message instead
closes the request so the assistant reads it and can ask again. Ownership and source controls follow
Hermes. See [passwords and logins](docs/PasswordsAndLogins.md) for storage scope,
external password managers and uncertain-request recovery.

## Chatting

Each finished reply offers **Copy reply**, **Share reply** where the device can share,
**Save reply** and **Quote in reply**. On a computer they appear when you point at or
tab to the reply; on touch screens and in the iOS long-press menu they are always
there. Select part of a web reply to quote just that part. Code blocks are colored by
language, and tables can be copied as Markdown or CSV.

When a reply fails, **Retry** under it sends your message again without touching
your draft. A failed turn can be retried once, by anyone, from any device: a second
tap, tab or phone gets the first retry's result instead of starting another turn.

After you send, your message moves near the top and the reply grows below it.
While it grows, a short stretch of bold, italics, strikethrough, inline code or a link waits at
the end and appears whole once its closing marker arrives, instead of flashing as raw Markdown.
One longer than about a short sentence shows as typed until it closes. A table header waits
while its line is typed, shows as typed while the delimiter row, the `| --- |` line under it,
arrives, and becomes a table once that row is recognized. Code blocks show every character as
it arrives, and a code block still arriving keeps your text selection.
On the web, the reply keeps growing across tool calls: after each tool the server reads the
running turn itself and sends its saved parts with the reply, so text resumes about one Hermes
read later instead of waiting for the chat to reload. The iOS app still reloads after each tool.
Scrolling up stops the view from following; it follows again once you return to
the end. Each finished turn folds its tool calls and delegated work into one row,
such as "Worked for 2m 14s · 3 tool calls". Expand it for the details. While the
assistant works, one live line shows its current tool and, in Advanced, its latest
reasoning. Decisions and requests for input stay outside the fold.

**Find in chat** (Cmd/Ctrl+F on web, Find on iOS) matches loaded messages at once and
adds older matches from the conversation's history; choosing one opens the chat at
that message. A status area above the message box gathers send problems, the
interrupted-task review, waiting decisions with **Review**, and connection trouble,
most urgent first.

On a computer, Cmd/Ctrl+K opens a command palette for assistants, group chats, Today,
Search, Settings and appearance. Cmd/Ctrl+1 to 9 open pinned assistants in the
installed app (browsers keep those keys for tabs), Cmd/Ctrl+. stops the current
reply after asking, and `?` lists every shortcut. An iPad with a keyboard has Cmd+K
"Go to…" and Cmd+1 to 9. In an empty message box, Up recalls your earlier messages
in that chat. Enter sends and Shift+Enter starts a new line. While a Japanese,
Chinese or Korean input method is composing a word, Enter, Escape and the arrow keys
belong to it, in every browser including Safari, so confirming a word never sends the
message, moves a find, or picks a palette entry. Pasting 32 KB of text or more attaches it as `Pasted text.txt`. Pinning
or moving an assistant on home shows Undo for five seconds. Web text follows the
browser's text size setting.

On a phone, the message box sits directly above the on-screen keyboard and the latest
message stays in view as the keyboard opens and closes. Android browsers resize the page
for the keyboard through the viewport's `interactive-widget=resizes-content`. Safari on
iPhone and iPad and the installed iOS web app ignore it through iOS 27.2, so
`src/app/keyboard-viewport.ts` sizes the app to the visible area while the keyboard is up.
WebKit added the setting in the iOS 27.3 beta ([bug 259770](https://bugs.webkit.org/show_bug.cgi?id=259770)),
where a report says the field still ends up behind the keyboard; the app's behavior on that
beta is unverified. The code compares the visible area with the page instead of checking the
browser, so it steps aside wherever the browser resizes the page itself. A pinch zoom leaves
the app's size alone, except one within 1% of normal scale, which counts as unzoomed.

When the visible area is too short for everything, the transcript gives up its space first,
then the notices, the Talk panel, the attachment tray and the message box, which scroll inside
their own boxes down to one line of text, and last the header, cut from the top. Send and Stop
stay on screen whenever the area is at least as tall as one line of text and the row of
buttons, about 112 pixels. A shorter area, as in landscape on a small iPhone where Safari's
bars take most of what the keyboard leaves, keeps the app at full height and lets Safari
scroll the message box into view. A group chat's composer stays at the bottom of the chat as it
scrolls and follows the same order. `.agents/tools/check-send-visible.mjs` checks both in Chromium.
Pressing Send or Stop leaves focus in the message box, so the keyboard stays up between
messages. Attach and Talk switch to the file picker or your voice, so they let it close.

## Hermes updates and activity

Open Hermes and updates in web Settings, or Hermes updates in iOS
Preferences. Administrators can check the next official Hermes revision before
choosing to upgrade. Checking stages the exact source and tests it in a disposable
home. It never installs an update. Progress survives closing the client and
restarting the app server. An uncertain request is reconciled without replay.

The installer must enable the [Linux upgrade hooks](docs/HermesUpgradeLinux.md)
and administrator allowlist first. Installation waits for native work to finish,
backs up the current source and runtime, and verifies the original sign-in and
connections before releasing maintenance. Failed verification restores the
previous version when rollback is safe. A failed or uncertain recovery keeps
maintenance closed. Administrators can retry a failed update, request safe
cancellation, or restart and verify Hermes when the recorded operation allows it.
Cancellation restores the previous version when needed; recovery never clears
maintenance without verifying the resulting runtime. Unverifiable legacy failures
still require installer repair. The app does not silently update Hermes.

The add-on turns off the native Hermes dashboard's own updater, which would skip
qualification and disable the add-on. The dashboard hides its update control, and
its update routes refuse with a message pointing to the app. Running
`hermes update` on the host still bypasses the app; the capability matrix
describes recovery.

Conversations show an animated avatar inline after the latest message while
Hermes thinks or uses tools. Thinking keeps the character visible with a gentle
tilt and upward gaze. Completed work leaves the final reply without a separate
Done status. Tool calls and delegated work appear in counted accordions inside each turn's fold.
Advanced view adds tool inputs, outputs, errors and timestamps, plus reasoning
Hermes exposes. Approval buttons show submission feedback immediately. Stop
replaces Send while a response is active and the draft has no text or attachments;
adding a draft brings Send back for guidance. Sending spins the Send button; a
notice with Retry appears only when a send ends without a receipt. Replies do not
repeat the assistant's name, and tool-call rows without reply text stay in the
tool accordion. While a recognizable tool runs, the web avatar holds a small prop:
a magnifying glass for search and browsing, a laptop for terminal and code, a book
for reading, or a notepad for writing. Disconnecting marks activity unknown;
the last tool event is not evidence that execution is still running.

Mascot avatars offer eight everyday characters: Bear, Fox, Sprout, Panda, Raccoon,
Owl, Cactus and Dinosaur. They take whichever color you choose; a panda keeps its
white face and wears the color on its ears and eye patches. Ten seasonal characters
follow under their own heading in calendar order: Leprechaun, Easter Bunny, Bald
Eagle, Pumpkin, Bat, Ghost, Turkey, Santa, Rudolph and Snowman. Both web and native
iOS offer every character. Each keeps its character during working/thinking
animation and supports the existing eye and accessory controls. Choosing a seasonal
character applies its default color and preserves your other customization. Very
light heads get a soft edge so they stay visible on the light theme. All use
original artwork.

Open Artifacts from the assistant's details (tap its name in the conversation header) to browse its generated
outputs and shared attachments. Search filenames, filter by type, and preview
images, text, or supported media. PDFs and other files can be opened or downloaded.
External file sources open only when you choose their link.
<!-- BEGIN reply files -->
A reply whose turn produced files it does not already show as attachments lists
them as chips under it, up to four and then **+N more**. A chip opens Artifacts on
that file; **+N more** opens the whole list. Files you shared yourself are not chips.
<!-- END reply files -->

## Validate

```sh
npm test
npm run lint
npm run test:py
npm run lint:py
npm run build
npm run test:e2e
python3 .agents/tools/source-state.py
```

`npm test` runs the application tests with Vitest. It refuses to start on a Node
outside the `engines` range in `package.json`, and `.npmrc` makes `npm ci` refuse too:
older Node 24 releases hang the event-stream tests. `npm run lint` runs oxlint over the
TypeScript and JavaScript, with warnings failing the run. `npm run test:py` runs every
Python test file it discovers in `tests/*_test.py`, `scripts/*-test.py` and
`scripts/spike/*_test.py`, one subprocess each, and fails if a test-looking file
sits outside those paths. Pass file paths to run a subset, for example
`npm run test:py -- tests/hermes_vault_test.py`. Use Python 3.14, which the
Hermes host runs. Test files use `unittest`, and a file passes only if at least
one test ran. A file whose tests all skip, such as the system terminal test
without `tmux`, shows SKIP locally and fails when `CI=true`.
`npm run lint:py` runs ruff for undefined names and likely bugs. Install the
version pinned in `.github/requirements-ci.txt`. CI runs both in its Python job.

`npm run test:e2e` runs a short Playwright smoke suite in real Chromium. Run `npm run build`
first, and `npx playwright install chromium` once per Playwright version. `e2e/server.ts`
starts the real app server and built client on loopback ports 4173 and 4174, in memory,
with local sign-in and a scripted assistant, so it never contacts Hermes, Google or the
network. It covers sign-in, sending a message and receiving the reply over the live event
stream, the service worker opening the app offline and recovering, a deploy whose new shell
reaches the next load and whose release is offered until taken, a deploy whose worker cannot
install still reaching the next load, a lazy screen whose file a deploy retired offering
Reload without reloading on its own, a notification's chat opening in the open window
without a reload, and no page errors,
console errors or CSP violation reports. It does not cover real Hermes behavior, push
delivery, Google sign-in, the iOS app, or other browsers. CI runs it in the `browser` job
and uploads the report and traces when it fails.

The [validation ledger](docs/ledger/README.md) distinguishes application tests,
real Hermes execution using a deterministic local provider, visual checks, and
acceptance that needs a physical phone or configured external service. Tests with
a runtime double do not prove Hermes integration. Simulated push checks do not
prove delivery to an installed phone app while it is closed.

Pull requests run the application tests, lint, production build and Python syntax checks
on both supported Node versions. Native builds and simulator tests run on the
Mac mini using Xcode 27.0. The isolated Hermes probes remain a separate
explicit run using the capability matrix's reproduction instructions.

The standalone [avatar specimen](avatar-specimen/index.html) is available at
`/avatar-specimen/` in the Vite development server. Its
[reference inventory](docs/AvatarReferenceInventory.md) records observed geometry,
controls, motion and reuse restrictions. All shipped avatar artwork is original.

The [settled plan](docs/Plan.md) remains the scope and acceptance brief.
Nicolas authorized hosting this application at `agentui.wildflowersranch.com`
on the existing Hermes VPS. The [deployment record](docs/Hosting.md) tracks
that installation and any remaining acceptance steps.

## WildBots for Mac

[`mac/`](mac/) holds WildBots for Mac, a menu bar app that lets your personal
assistants run commands, read and write files in folders you choose, and take a
screenshot on your Mac, unattended when you allow it. The Mac decides what each
assistant may do and connects out to this server, so it needs no open port. Linked
Macs appear in Settings > Macs, where Revoke disconnects one at once. The server
turns Mac links on with `MAC_LINK_KEY`; see [WildBots for Mac](docs/MacLink.md) for
setup, the confinement model, its limits and the protocol.

## Native iOS

The SwiftUI app lives in [`ios/`](ios/). It uses the same authenticated application
API, bot configuration and canonical conversations as the web client. Its
[parity record](ios/Parity.md) distinguishes implemented features, simulator
checks and external acceptance.

Connect to the app server's HTTPS origin. HTTP is limited to loopback development,
including an iOS simulator on the server's Mac. A physical phone needs an HTTPS
address it can reach. Household sign-in opens the system authentication browser;
the resulting app token stays in Keychain, scoped to that server.

### LAN and tailnet routes

Set `DIRECT_ROUTES=lan`, `tailnet` or `lan,tailnet` to let the iOS app reach this
server over the household network or a Tailscale (or Headscale) tailnet when it
can, instead of the public origin. The server opens an HTTPS listener on
`DIRECT_PORT` (default 3443) on each matching private address, and adds and drops
them as addresses change. It finds LAN addresses on ordinary adapters, never
container bridges or other VPNs, and tailnet addresses on Tailscale's adapter. A
cloud server should list only `tailnet`, since its provider's private network is no
household's LAN. Allow `DIRECT_PORT` through the host firewall on those interfaces
only, and through the tailnet's access rules for the phones that should use it. Linux
accepts a packet for any of its addresses on any interface, so the firewall, not the
listener's address, decides who can connect.

Each listener uses a self-signed certificate kept in `DIRECT_TLS_DIR`, by default
`direct-tls` beside the database. The app learns each route and the certificate's
fingerprint over the HTTPS origin, then pins it. The listener serves only the signed-in
native API; sign-in and the web app stay on the origin. Deleting the directory makes
a new certificate at the next start, and the app picks it up the next time it
reaches the origin. See [direct routes](docs/native-api.md#direct-routes) for the
contract.

Native notifications require the `APNS_*` settings in `.env.example` and a signed
app whose bundle ID and APNs environment match the server. The
[native API contract](docs/native-api.md) documents sign-in, expiry and device
registration. Apple signing and closed-app notification delivery on a physical
phone remain external acceptance work. Adding the app does not deploy the server
or configure an Apple account.

The [runtime assessment](docs/HarnessAssessment.md) records the tradeoffs in
keeping Hermes, replacing it, or wrapping existing executors such as Codex and
Claude Code. Hermes remains the current execution owner.
