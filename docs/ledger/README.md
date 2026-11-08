# Validation ledger entries

Each validation record is one file here, named `<UTC stamp>-<slug>.md`, for example
`20261021T190417Z-app-release-f257cc09.md`. The stamp is `YYYYMMDDTHHMMSSZ`, so a
directory listing sorts oldest to newest, and two entries never share a name.
Entries through October 21, 2026 stay in the frozen archive,
[`docs/ValidationLedger.md`](../ValidationLedger.md); do not add to it.

`.agents/tools/release-app.py` writes the entry for each production release
(`<stamp>-app-release-<commit>.md`, stamped as in the release name). Add other
entries, such as a qualification or feature validation, by hand with the same shape.

## Entry format

- A heading `# <Month day> <what was validated>`, such as `# October 21 app release f257cc0`.
- Prose that names the exact code state: the commit or the `python3 .agents/tools/source-state.py`
  fingerprint (add path prefixes for one component), the runtime versions that matter, and
  the Hermes revision when Hermes took part.
- The checks that ran and their results, kept apart: application tests, real Hermes
  execution, visual checks, and acceptance that needs a physical phone or an external
  service. Say what was not exercised.
- Links to retained evidence in `docs/evidence/`, written relative to this directory
  (`../evidence/<file>`). Link earlier entries as `../ValidationLedger.md`.

`source-state.py` leaves this directory out of the fingerprint, as it does the archive,
because entries record fingerprints rather than change them.
