# Passwords and logins

Open assistant settings > Logins on the web, or Passwords & logins in the native
app. Choose the Hermes profile, inspect saved login metadata, add a login, or
confirm removal of a local entry. External entries belong to their password
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

These fields never become chat messages or drafts. They clear on submission,
backgrounding and dismissal. An uncertain result disables resubmission of the
same request; Refresh request checks its current state. Management failures ask
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
