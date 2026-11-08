# Command sandbox policies

WildBots for Mac runs each assistant command under `sandbox-exec` with a Seatbelt profile built
by `SandboxPolicy.build` in `Sources/WildBotsMacCore/SandboxPolicy.swift`.

## Provenance

These files are copied unchanged from [openai/codex](https://github.com/openai/codex) at commit
`748ab55ca7de0b647d9a7a9d9a8e70e00f28666d`, under the Apache License 2.0 (`CODEX-LICENSE`):

| File | Used |
| --- | --- |
| `seatbelt_base_policy.sbpl` | Yes: closed by default, process, sysctl, PTY and minimal Mach rules |
| `seatbelt_read_only_platform_defaults.sbpl` | Yes: the minimal system read list |
| `seatbelt_network_policy.sbpl` | Yes: TLS, DNS and network configuration lookups |
| `seatbelt_preferences_policy.sbpl` | No. Codex includes it only when file reads are unrestricted, because `cfprefsd` can hand out other apps' preferences. WildBots restricts reads. |

`tools/embed-policies.sh` turns the used files into `Sources/WildBotsMacCore/EmbeddedPolicies.swift`.
`EmbeddedPolicyTests` fails if the Swift constants and these files differ, so edit the `.sbpl`
files and rerun the script; never edit the generated Swift.

## WildBots modifications

The vendored text is not edited. `SandboxPolicy.build` appends these rules after it. Seatbelt
applies the last matching rule, so the denies at the end win.

- **Network:** outbound to IP addresses, inbound and bind on local IP, and the mDNSResponder
  socket for DNS. Codex's full-network mode allows all `network-outbound`, which includes Unix
  domain sockets; WildBots does not, so a command cannot reach ssh-agent, Docker or other local
  daemons.
- **Developer tools, read and execute only:** `/opt/homebrew`, `/usr/local`, `/Library/Developer`,
  `/Library/Frameworks`, `/System/Library`, `/System/Cryptexes`, `/Applications/Xcode*.app`, the
  active developer directory, and in the home folder `.cargo`, `.rustup`, `.nvm`, `.pyenv`,
  `.local/bin`, `.gitconfig` and `.config/git`.
- **Ancestors:** metadata only (stat, never list) for the folders above each granted folder, the
  temporary folder and the home folder, so tools such as Git can look for a repository.
- **Granted folders:** read, write and map executables.
- **Private temporary folder:** read and write, one per command, created `0700` under the app's
  temporary root and deleted afterwards. `TMPDIR` points to it. Tools that ignore `TMPDIR` and ask
  macOS for the per-user temporary folder (for example `mktemp` with no template, and the `xcrun`
  shims) are denied, which is why the developer directory's `usr/bin` comes first on `PATH`.
- **Denies:** `appleevent-send`; the app's own Application Support folder and preferences file,
  `~/Library/Keychains`, `~/Library/LaunchAgents`, `/Library/LaunchAgents`, `/Library/LaunchDaemons`
  and `/Library/Keychains`; and, inside every granted folder and the temporary folder, the
  protected paths in `ProtectedPaths.patterns` (`.ssh`, `.gnupg`, `.aws`, `.netrc`, `.config/gh`,
  Keychains, browser profiles, Mail, Messages, this app's settings and others), matched
  case-insensitively because APFS usually is.

`SandboxProbeTests` runs the real `sandbox-exec` with the generated policy and is the merge gate
for any change here.
