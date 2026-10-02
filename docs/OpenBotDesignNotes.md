# OpenBot design references

Reviewed pinned source from [nightly-labs/openbot](https://github.com/nightly-labs/openbot/tree/61a5a4760f3564b8175d277e836c3f0b1b363424) and [ashhart/OpenBot](https://github.com/ashhart/OpenBot/tree/b544cb743986193fdc3d234ae66c8e44ef68fc00). The former uses PolyForm Noncommercial and the latter MIT. No source or artwork was copied or executed.

The model picker now opens the selected provider initially, expands matching groups while searching, and offers Refresh models after a successful catalog load. These behaviors were useful in the MIT project's ModelPickerModels.tsx and ModelPicker.tsx. Existing explicit choices, aliases, favorites and disclosure state remain intact.

The brand avatar motion source reinforced keeping a character's silhouette visible during activity. Seasonal artwork uses this app's existing original SVG and SwiftUI motion rig.

Useful future ideas from the larger project include a Show in chat action for artifacts, grouping files by day, elapsed activity time after several seconds, and editing queued messages. Those require conversation navigation or queue capabilities and are outside this change. See packages/ui/src/features/files/ConversationFilesPanel.tsx and packages/ui/src/features/conversation/AgentActivity.tsx at the pinned revision.
