# OpenBot design references

Reviewed pinned source from [nightly-labs/openbot](https://github.com/nightly-labs/openbot/tree/61a5a4760f3564b8175d277e836c3f0b1b363424) and [ashhart/OpenBot](https://github.com/ashhart/OpenBot/tree/b544cb743986193fdc3d234ae66c8e44ef68fc00). The former uses PolyForm Noncommercial and the latter MIT. No source or artwork was copied or executed.

The model picker now opens the selected provider initially, expands matching groups while searching, and offers Refresh models after a successful catalog load. These behaviors were useful in the MIT project's ModelPickerModels.tsx and ModelPicker.tsx. Existing explicit choices, aliases, favorites and disclosure state remain intact.

The brand avatar motion source reinforced keeping a character's silhouette visible during activity. Seasonal artwork uses this app's existing original SVG and SwiftUI motion rig.

Useful future ideas from the larger project include a Show in chat action for artifacts, grouping files by day, elapsed activity time after several seconds, and editing queued messages. Those require conversation navigation or queue capabilities and are outside this change. See packages/ui/src/features/files/ConversationFilesPanel.tsx and packages/ui/src/features/conversation/AgentActivity.tsx at the pinned revision.

## November 2026 review: chat bubbles and the message rail

Reviewed [nightly-labs/openbot at 10442afd](https://github.com/nightly-labs/openbot/tree/10442afd11fb06fa1121a7db460ea18652c3ae4f), its changelog through 0.74.0, and the preview at openbot.run on November 19, 2026. The license is still PolyForm Noncommercial. No source or artwork was copied or executed; the ideas below were rebuilt from their descriptions.

Chat bubbles. OpenBot puts both sides of a chat in bubbles and fills a person's bubble with the agent's avatar color (0.3.0, 0.64.0, 0.72.0). WildBots takes the idea with three changes. Only a reply's prose sits in a bubble; tables, code, cards and any list or quote that holds one stay full-width blocks, because a table inside a filled bubble read poorly in a mock and OpenBot's own mobile app pulls tables out. A reply bubble is capped at 600 px, which brings a desktop line from about 101 characters to about 77. The solid fill caps the color's OKLCH lightness at 0.52: OpenBot picks white text whenever white reaches 3:1, which measured 3.17:1 on its blue agent, and four of this app's nine avatar colors cannot reach 4.5:1 with white or ink at full lightness. The app computes the fill once, in the same steps on web and iOS, and both clients test it against one vector file, because the browser's own fit into sRGB gave `#0062DA` for the blue avatar where iOS gave `#0066CA`. Chat style and the fill are per-person settings, as in OpenBot, and Classic keeps flat replies. A time stays under a person's message and under the last part of a reply when the message has one; OpenBot replaced them with a centered time after an hour's gap, which this app decided against on November 1.

Message rail. OpenBot 0.64.0 shows one tick per message a person wrote beside a long chat. The web client has the same for the messages people sent among those loaded, never for a scheduled prompt, with a 24 px pitch for target size, a window of ticks that follows the reader, and a single tab stop.

Table edge fades come from 0.72.0.

Group chats. Bubbles came to group chats in a follow-up (issue #461), with the same grouping: prose runs in bubbles, other blocks at the column's width. The person's own bubbles sit at the trailing edge and everyone else, people and assistants, speaks from the leading edge, as group chats in messaging apps do. Putting every person at the trailing edge, as a chat with one assistant does, was rejected: another person's words would sit on the reader's side, and only the name would say they were not the reader's. Each message keeps the speaker line it had in Classic, so a run from one speaker repeats no more than before; folding that run under one line was left out because each message's time and routine tag sit on that line. A person's message is Markdown in a group, so it follows the prose rule too, and a table they send keeps the column's width rather than squeezing into their bubble. A group has no one assistant's color, so the solid bubble takes the app's green rather than the lead's or the first member's color, which would read as that assistant speaking. Classic groups keep the log layout exactly; a computed-style comparison of the group panel before and after found no difference at 1440, 390 and 320 px in both themes.

Left out, with the reason:

- Reaction answers. In OpenBot 0.72.0 a reaction to a reply is also the person's answer, so a thumbs-up lets the agent continue. It was built here as a picker on the last reply and removed before merging. Three independent reviews each found a way for one tap to approve a newer question than the one the person saw. Closing that needs a conversation version that Hermes checks under its admission lock, and a durable record for refused sends. That belongs in its own change.
- A queue panel with edit, reorder and Send now. Hermes gives the app no way to list or change queued messages.
- Swipe right to reply on iOS. It would compete with the system back swipe out of a conversation, and Quote in reply already exists in the reply menu.
- Mark unread from a message. It changes the read state that badges and notification pruning depend on, and needs its own change.
- An avatar expression for each kind of step. That is new avatar artwork on two platforms and needs its own design review.
- Backdrop scenes and the trace waterfall. Seasonal ambience covers the first, and the second is built for developers.
