# Integrations

Open **Integrations** from the web sidebar or iOS Preferences. A bot's settings
also include **Connections**, already scoped to its Hermes profile. The list
shows the credential owner, account when available, granted permissions and the
last connection check. **Configured** means Hermes has saved configuration;
**Connected** requires a successful check. A provider check does not prove a paid
model or image request will succeed.

Connections belong to Hermes profiles. Household members share access to the
installation; marking a bot personal does not create an account boundary.
Connecting, reconnecting, disconnecting and adding MCP servers require an
integration administrator. Credentials remain in Hermes's existing stores and
are never returned in catalog responses. Disconnecting removes this profile's
local connection; it does not claim to revoke an account-wide grant at the vendor.

## Available connections

| Connection | Setup and use |
| --- | --- |
| Google Workspace | Connect or reconnect Gmail, Calendar, Drive, Tasks and Contacts through Google consent. Permission indicators describe the saved scopes; the health check identifies the service it actually queried. |
| GitHub | Use the official remote MCP server with a repository-scoped personal access token. Remote OAuth needs a separately configured GitHub application. |
| Selected files and Synology | Select an installer-approved directory visible to Hermes, including a mounted NAS directory. The bounded read tool lists directories and reads text without following symlinks. An existing NAS MCP service can also be connected. |
| Discord | Inspect Hermes's existing connection and check its status. Native messaging setup remains responsible for its bot token and gateway lifecycle. |
| Supabase | Connect the official remote MCP service. Prefer a selected project and read-only access for monitoring. |
| Cloudflare | Connect an official remote MCP service. The observability endpoint covers monitoring; the general endpoint exposes the permissions selected during authorization. |
| VPS health | Connect an existing HTTPS MCP service exposing the host information you want the bot to use. This does not install a server agent or grant SSH access. |
| Home Assistant | Connect the home's configured HTTPS `/api/mcp` endpoint using a long-lived access token. OAuth additionally needs the native client's IndieAuth settings. |
| Models, search and images | Manage supported native provider sign-ins and API keys. Existing native tool and model configuration continues to control execution. |
| Custom MCP | Add an HTTPS server with OAuth, a bearer token or no authentication. Hermes owns discovery and tool execution. Local command installation is not exposed. |
| Apple Calendar and Reminders | In iOS, grant device permission, select calendars or reminder lists and a date range, preview the selection, then add it to a bot's draft. Send the draft to share it. Refresh explicitly to share newer data. |

Apple access is labeled **On this iPhone**. A selected snapshot is an ordinary
attachment in the shared bot conversation once sent. The server cannot continue
reading the phone when the app is closed. Denying or revoking device permission
does not delete snapshots already sent to Hermes.

## Hosting configuration

Set `HERMES_INTEGRATION_ADMINS` on the app server to a comma-separated subset of
`HOUSEHOLD_EMAILS`. If omitted, it inherits `HERMES_UPGRADE_ADMINS`. An explicitly
empty value makes connection management read-only. Loopback development accounts
can manage integrations only outside production.

The qualified dashboard add-on exposes a finite private integration endpoint.
The app uses its existing permanent service credential. The gateway wrapper also
registers the selected-file tool for native execution. Update and qualify both
wrappers together. Their source bytes and the integration probe are included in
the qualification digest.

These settings belong to the **Hermes service environment**, not the browser:

| Variable | Purpose |
| --- | --- |
| `HERMES_AGENT_INTERFACE_GOOGLE_CLIENT_FILE` | Absolute path to an owner-only Google web OAuth client JSON file for automatic browser callbacks. |
| `HERMES_AGENT_INTERFACE_FILE_BASES` | Allowed directory bases, separated by the host's path separator. Administrators can share only directories within these bases. Mount a NAS on the host before selecting it. |
| `HERMES_AGENT_INTERFACE_MCP_HOSTS` | Installer-approved custom MCP hostnames. Required for public and private hosts outside the built-in presets; include only hosts whose MCP service and authorization endpoints you trust. |

### Google Workspace authorization

App sign-in, Workspace access and the private app-to-Hermes service credential
are three separate connections. Workspace consent updates the selected profile's
existing `google_token.json`. It does not change household sign-in.

For automatic return from Google, install a **web application** OAuth client
file and register this exact authorized redirect URI:

```text
https://YOUR_APP_ORIGIN/integrations/google/callback
```

On the household installation the URI is
`https://agentui.wildflowersranch.com/integrations/google/callback`.
An authorized JavaScript origin alone does not register this redirect. Keep the
original Hermes login redirect. The callback is bound to a single-use state and
PKCE challenge. An existing installed-app client uses a manual callback fallback;
its loopback address belongs to the authorizing browser, not the remote VPS.

Enable the Google APIs corresponding to the requested services. A grant can be
valid while an API is disabled or a requested permission is missing. Reconnecting
must preserve the old grant until authorization completes, and must not silently
replace a known account with another one.

Older grants may have no saved account identity. In that case the form asks for
the Google email to connect and verifies it against Google's response. An expired
old grant need not be deleted first. Enable Hermes's native `google` dependency
extra before using Workspace consent or checks.

Google Tasks uses the add-on's read-only task-list and task reader. Enable the
bot's dedicated **Google Tasks** toolset to use it. Selected folders use the separate
**Selected files** toolset. Neither requires enabling native file-write tools.
Other Workspace operations continue through the existing native Google Workspace
skill. These adapters do not restrict unrelated tools already enabled on a bot.

The short grant commit freezes native dashboard admission and checks that the
old file has not changed. Separate gateway processes and legacy CLI scripts do
not share that fence. They remain a native ownership limitation; the app does not replace
their credential writer or claim cross-process locking that Hermes lacks.

Google projects in external **Testing** status generally issue seven-day refresh
tokens for Workspace scopes. Moving the consent screen to production and
reauthorizing is a host/account setup task, separate from implementing this UI.
The app cannot repair that project setting with repeated token refresh attempts.
See [Google's refresh-token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).

### Remote MCP presets

The official defaults were verified on October 1, 2026:

- GitHub: `https://api.githubcopilot.com/mcp/`. Append `readonly` to limit exposed
  tools. A scoped personal access token works without a host OAuth application.
  [Official GitHub MCP documentation](https://github.com/github/github-mcp-server).
- Supabase: `https://mcp.supabase.com/mcp`. Its documented query parameters allow
  project scoping, read-only mode and selected feature groups. OAuth uses dynamic
  client registration; bearer tokens are also supported.
  [Official Supabase configuration](https://supabase.com/docs/guides/ai-tools/mcp).
- Cloudflare: `https://observability.mcp.cloudflare.com/mcp` for observability,
  or `https://mcp.cloudflare.com/mcp` for the broader API.
  [Official Cloudflare server list](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/).
- Home Assistant: enable its MCP Server integration and use
  `https://YOUR_HOME_ASSISTANT/api/mcp`. A long-lived access token avoids needing
  an IndieAuth client registration in the Hermes setup.
  [Official Home Assistant setup](https://www.home-assistant.io/integrations/mcp_server/).

MCP browser authorization uses Hermes's native callback flow. Configure the
Hermes dashboard's externally reachable public URL before starting it from a
phone. Provider-specific client registration and account consent remain necessary
where the provider requires them. Do not put tokens in URLs.

## Validation and limits

The native integration probe runs against an exact Hermes checkout in a marked,
disposable home. It checks native API compatibility without using household
credentials. Local HTTP fixtures exercise credential failure and authorization
contracts; they do not prove live provider consent. The validation ledger records
the exact revision, successful checks and remaining external acceptance.

Live Google consent, MCP vendor authorization and physical iPhone permission
behavior require the configured installation and intended accounts/devices.
They remain part of [external acceptance issue #1](https://github.com/NicL9923/agent-interface/issues/1).
