# Passwords and logins

Open assistant settings > Access on the web or in the native app. Choose the
Hermes profile, inspect saved login metadata, add a login, or confirm removal of a local entry. External entries belong to their password
manager. Manage their contents there.

Ownership follows Hermes profiles and the household's existing access. Usernames,
website origins and labels are visible metadata. The local vault encrypts stored
login secrets with Hermes's existing vault key. Hermes can use that key on its
host, so this is not a separate encryption boundary against a host operator.
The local vault stays available to Hermes. Installed 1Password and Bitwarden
sources retain native enable, unlock and lock controls.

When Hermes requests a login, the conversation shows the exact website and
masked input fields. Save login and continue sends the answer directly to the
pending native request. Hermes stores and fills the login using its existing
model-blind browser tools. One-time codes and external vault unlocks use the same
inline path. Native secret requests identify the environment variable and save
through Hermes's environment credential store, separately from the encrypted
login vault. Sudo and unsupported setup requests use the official interface.

An assistant can also ask for a login by address, without a browser page, with
its `vault_save_login` tool. Use this for a private network device, a service
Hermes cannot reach, or a login with no browser form. The tool takes an exact
origin such as `https://comet-pro-kvm.mesh.wildflowersranch.com`, a short name and
a one-sentence reason. Origins are http or https with an ASCII host or IPv4
address and an optional port, with no path, query or credentials. The card shows
the address, name, reason, the requesting assistant and household member, the
encrypted profile storage, and that profiles are not a household security
boundary. Only the member whose task asked can save or cancel it; others see
who it is waiting for. The answer repeats the address the card showed. Hermes
saves the login in the profile's local vault and gives the assistant a handle and
the username, never the password. Saving does not open, check or sign in to the
address, and Hermes fills the password only on a page whose origin matches
exactly. The tool uses the same native save-login prompt as a browser page, so
the Hermes desktop app and dashboard chat show their usual login prompt for it.
Scheduled, messaging and API runs have no prompt, so the tool refuses and tells
the assistant not to ask in chat. The tool's description lists each result it can
return (saved, user replied in chat, not saved, prompt unavailable, invalid
argument, save failed) with the next step for each. API keys and tokens are not logins; native
secret requests still handle them. The terminal CLI and TUI do not load the
WildBots add-on, so the tool is unavailable there.

These fields never become chat messages or drafts. They clear on submission,
backgrounding and dismissal. While an answer is on its way, the card locks its
fields and says **Sending securely…**. Once Hermes takes it, the card confirms,
for example "Login saved. Ranch hand is continuing.", then folds to that one line,
which stays a moment after Hermes stops listing the request. An uncertain result
disables resubmission of the same request; Refresh request checks its current state.
An answer that arrives after the request closed is not used, and the card says so.

To correct the assistant instead of answering, send a message. The composer says
"Or reply here instead…" while a request waits. Hermes admits the message first,
then closes that conversation's open requests, so the waiting tool returns and
the assistant reads the message next. The tool tells the assistant that nothing
was saved and that it may ask again with the corrected details. An answer already
being sent wins over a message that arrives at the same moment, so each request
has one outcome. A login asked for by address stays with the member whose task
asked: another member's message does not close it, and their composer says it
waits for that person. Questions from the assistant and computer handoff requests
close the same way; answers already chosen on a question are kept. Approvals keep
their own decision. Management failures ask
you to reload and review saved entries before entering anything again.

The server binds answers to the current executor, canonical session, profile,
request ID and supported method. It derives the destination from the native
request. While waiting for input, Hermes releases the shared computer lock; it
reacquires the lock and checks control, maintenance and recovery before continuing.
Native website checks and secret redaction still apply to credential filling.

The design uses native storage and restricted operations rather than introducing
another secret store. Access checks and fixed secret-safe errors follow the
[OWASP secrets management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html).
The local encryption boundary is described above because protecting stored data
also depends on key access, as explained in the
[OWASP cryptographic storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html).
Both references were checked on October 2, 2026.
