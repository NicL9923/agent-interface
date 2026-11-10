import { useId } from "react";
import { Icon } from "../components/Icon";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { formatCombo, shortcuts, type ShortcutId } from "./shortcuts";
import { useEnterSends } from "./enter-key";
import "./shell.css";

const order: ShortcutId[] = ["palette", "pinned", "find", "stop", "undo", "help"];
const composerKeys: [string, string][] = [
  ["Enter", "Send your message"],
  ["Shift+Enter", "Start a new line"],
  ["↑", "Recall your earlier messages from an empty composer"],
  ["↓", "Move forward, then back to your draft"],
  ["Esc", "Leave recall and restore your draft"],
];

export function ShortcutsDialog({ onClose }: { onClose(): void }) {
  const titleId = useId();
  const enterSends = useEnterSends();
  const row = ([keys, label]: [string, string]) => <div className="shortcut-row" key={label}><dt>{label}</dt><dd><kbd>{keys}</kbd></dd></div>;
  return <Dialog className="settings-sheet shortcuts-dialog" aria-labelledby={titleId} onCancel={onClose} onClose={onClose}>
    <header className="sheet-header">
      <Button className="sheet-close" aria-label="Close keyboard shortcuts" onClick={onClose}><Icon name="close" /></Button>
      <h2 id={titleId}>Keyboard shortcuts</h2>
    </header>
    <div className="sheet-body">
      <h3 className="shortcut-heading">Anywhere</h3>
      <dl className="shortcut-list">{order.map(id => row([formatCombo(shortcuts[id]), shortcuts[id].label]))}</dl>
      <h3 className="shortcut-heading">In the composer</h3>
      {!enterSends && <p className="shortcut-heading">On this touch screen, Return starts a new line and the Send button sends. These keys apply once you type on a hardware keyboard.</p>}
      <dl className="shortcut-list">{composerKeys.map(row)}</dl>
    </div>
  </Dialog>;
}
