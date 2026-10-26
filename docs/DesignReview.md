# Full app design review

This pass covers the web client at desktop and phone widths and the native iOS
client. Nicolas requested a separate Claude Opus 5.5 review at High effort for
each screen. A screen must score at least 9/10 with no obvious remaining issues
before implementation moves to the next screen. Scores are reviewer judgments,
not objective measurements of design quality.

## Direction

Keep WildBots' warm neutral backgrounds, green accent and original animated
characters. Give primary tasks stronger hierarchy, use consistent type and
control sizes, keep reading widths comfortable, and preserve native iOS behavior.
Use spacing to group related content and reserve borders for useful separation.

## Accessibility checks

Normal text uses the [WCAG 2.2 contrast criterion](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum)
of at least 4.5:1. Pointer controls are checked against [WCAG 2.2 target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum),
with 44-pixel controls retained on phones. Native text uses semantic fonts and
large Dynamic Type layouts, following [Apple's font scaling guidance](https://developer.apple.com/documentation/uikit/scaling-fonts-automatically).
These references were checked October 25, 2026. They set measurable accessibility
requirements; the visual score remains an independent design judgment.

## References

References collected October 25, 2026. External artwork is reference material only.

- [OpenAI dots](https://openai.com/index/introducing-dots/): the published feedback
  screenshot shows a compact conversation beside a working document. Study the
  separation between conversation, composer and work, and the restrained chrome.
- [Meta Muse](https://www.testingcatalog.com/metas-muse-agent-enters-closed-alpha-with-invite-codes/):
  the published phone screenshot shows an avatar header, compact file cards and a
  persistent composer. Study spacing and the hierarchy of actions inside chat.
- [Claude Duet](https://venturebeast.tech/articles/claude-duet-first-look): the
  published conversation and Make screenshots show separate content groups,
  compact navigation and a persistent composer. The official launch article
  embeds video rather than still product screenshots.
- [Grok Bot](https://techdevnotes.com/apps/ios/grok-bot/6794501026): the App Store
  screenshots show a clear sign-in action and an avatar creator with tightly
  grouped controls. Images were retrieved from Apple's image CDN. The official
  product page blocks automated browsing with Cloudflare.

## Screen ledger

| Screen | Baseline | Implementation | Opus 5.5 High rating |
| --- | --- | --- | --- |
| Today, web and iOS | Web, iPhone and iPad captured | Complete | Web 9.2; iPhone 9.1; iPad 9.1 |
| Assistants home and menus | Web phone and native baseline captured | In progress | Pending |
| Conversation and composer | Pending | Pending | Pending |
| Questions, approvals and failure states | Pending | Pending | Pending |
| Assistant details and artifacts | Pending | Pending | Pending |
| Assistant creation and settings | Pending | Pending | Pending |
| Avatar editor | Pending | Pending | Pending |
| Models and capabilities | Pending | Pending | Pending |
| Memory, work and learning | Pending | Pending | Pending |
| Routines and results | Pending | Pending | Pending |
| Logins and secure requests | Pending | Pending | Pending |
| Search, saved items and automations | Pending | Pending | Pending |
| Group chats and threads | Pending | Pending | Pending |
| Settings, following and home sections | Pending | Pending | Pending |
| Integrations | Pending | Pending | Pending |
| Computer and terminal | Pending | Pending | Pending |
| Hermes updates and recovery | Pending | Pending | Pending |
| Sign-in and connection recovery | Pending | Pending | Pending |
| Command palette and keyboard help | Pending | Pending | Pending |
| Attachments, upload failures and large paste | Pending | Pending | Pending |
| Find in conversation | Pending | Pending | Pending |
| Voice recording and playback | Pending | Pending | Pending |
| Status dock, connection notices and app updates | Pending | Pending | Pending |
| Toasts, undo and stop confirmation | Pending | Pending | Pending |
| Notification setup and settings | Pending | Pending | Pending |
| Apple device connections | Pending | Pending | Pending |
| Offline library | Pending | Pending | Pending |
| iOS quick switcher | Pending | Pending | Pending |
| Empty household, app loading and load failure | Pending | Pending | Pending |
| iOS share extension | Pending | Pending | Pending |
| Widgets, Live Activity and notification content | Pending | Pending | Pending |
| Standalone computer page | Pending | Pending | Pending |

The avatar specimen is a developer tool and is outside this product design pass.
Native layouts also need a representative iPad check.

## Today review history

The initial independent review rated Today 5/10. The delegate result confirmed
`claude-opus-5-5` with `effort: high`. The reviewer made no implementation edits.
It identified flat hierarchy, names taking priority over requests, excessive
desktop width, inconsistent row alignment and empty-state overhead.

The first implementation leads with the request or result, includes written
reason and action labels, constrains the desktop column to 720 pixels, groups
pending decisions, preserves recognizable characters, and avoids listing the
same pending task again under current work. The empty state no longer creates
a separate attention card. The native regression test preserves acknowledgement
of the server's exact returned frontier.

The web and native capture tools share `.agents/fixtures/today-design.json` for
the populated state. Each platform also retains its original baseline fixture.

Screenshots use the repository's synthetic fixtures. Raw screenshots, annotated
comparisons and reviewer reports are staged under the task's DevSSD scratch
directory until the PR attachments are uploaded.

The first revised screen scored 8.5/10 on web and a provisional 8/10 on native.
The reviewer found that disconnected assistants lost their named errors and
conversation route, and that the work count included a task already listed under
decisions. Both now have focused regression coverage. The native screenshot
runner also corrected its large-text setting from AX2 to AX3. The current native
regression and capture tests passed, including opening a disconnected assistant.

Today passed the second independent review with no obvious remaining issues.
Scores were 9.2/10 on web and 9.1/10 on iPhone and the loaded iPad view. The
[review report](evidence/design-review/today-review.md) records the resolved
findings, accepted decisions and actual coverage.
