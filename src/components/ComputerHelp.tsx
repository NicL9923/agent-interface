import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { Icon, type IconName } from "./Icon";
import help from "../shared/computer-help.json" with { type: "json" };

/** How to use the shared desktop by touch. The iOS app shows the same sections, checked by its tests. */
export function ComputerHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Dialog open={open} className="computer-help" aria-labelledby="computer-help-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header>
      <Button className="icon-button" aria-label="Close help" onClick={onClose}><Icon name="close" /></Button>
      <h2 id="computer-help-title">{help.title}</h2>
    </header>
    <div className="computer-help-body">
      {help.sections.map(section => <section key={section.title} aria-label={section.title}>
        <h3>{section.title}</h3>
        <ul>
          {section.items.map(item => <li key={item.title}>
            <Icon name={item.icon as IconName} size={22} />
            <div><strong>{item.title}</strong><p>{item.web}</p></div>
          </li>)}
        </ul>
      </section>)}
    </div>
  </Dialog>;
}
