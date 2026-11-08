import { useId, useState } from 'react';
import { write } from '../client-api';
import { useAction } from '../app/use-action';
import { Dialog } from './ui/dialog';
import { FormMessage } from './ui/form-message';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { GROUP_NOTES_MAX_BYTES, GROUP_PURPOSE_MAX, type GroupContext, type GroupMember } from '../shared/collaboration';
import './collaboration.css';

/** Hermes counts shared notes in UTF-8 bytes once trimmed. */
export function notesBytes(notes: string) { return new TextEncoder().encode(notes.trim()).length; }

/**
 * A group chat's purpose, shared notes and lead. Anyone who can open the room may change them, as anyone
 * may message it. Hermes gives them to every assistant from the next message on.
 */
export function GroupSettings({ roomId, name, members, context, writable, onClose, onSaved }: {
  roomId: string; name: string; members: GroupMember[]; context: GroupContext; writable: boolean;
  onClose(): void; onSaved(): void;
}) {
  const titleId = useId();
  const action = useAction();
  const { busy, error } = action;
  const [purpose, setPurpose] = useState(context.purpose);
  const [notes, setNotes] = useState(context.notes);
  // A lead who has left the room is no choice at all.
  const [lead, setLead] = useState(context.routing === 'lead' && members.some(member => member.member_id === context.lead_member_id) ? context.lead_member_id : '');
  const over = notesBytes(notes) - GROUP_NOTES_MAX_BYTES;
  const save = () => action.run(async () => {
    await write(`/groups/${encodeURIComponent(roomId)}/context`, { requestId: crypto.randomUUID(), purpose, notes, leadMemberId: lead || null });
    onSaved();
  });
  return <Dialog className="settings-sheet group-create-sheet" aria-labelledby={titleId} initialFocus="input" onCancel={onClose} onClose={onClose}>
    <header className="sheet-header">
      <Button className="sheet-close" aria-label="Close" onClick={onClose}><Icon name="close" /></Button>
      <h2 id={titleId}>Group settings</h2>
    </header>
    <form className="sheet-body group-create group-settings" onSubmit={event => { event.preventDefault(); void save(); }}>
      {error && <FormMessage tone="error">{error}</FormMessage>}
      <p className="muted">Every assistant in {name} reads these from the next message on.</p>
      <label>Purpose
        <input value={purpose} maxLength={GROUP_PURPOSE_MAX} placeholder="What this group is for" disabled={busy || !writable} onChange={event => setPurpose(event.target.value)} />
      </label>
      <label>Shared notes
        <textarea rows={6} value={notes} placeholder="Facts every assistant should keep in mind" aria-describedby={over > 0 ? `${titleId}-notes` : undefined}
          disabled={busy || !writable} onChange={event => setNotes(event.target.value)} />
      </label>
      {over > 0 && <p id={`${titleId}-notes`} className="form-error" role="status">These notes are too long. Remove about {over.toLocaleString()} characters.</p>}
      <label>Lead assistant
        <select value={lead} disabled={busy || !writable} aria-describedby={`${titleId}-lead`} onChange={event => setLead(event.target.value)}>
          <option value="">No lead, every assistant answers</option>
          {members.map(member => <option key={member.member_id} value={member.member_id}>{member.display_name || member.profile}</option>)}
        </select>
      </label>
      <p id={`${titleId}-lead`} className="muted">A lead picks who answers a message that names no one. Messages with an @mention always reach the assistants named.</p>
      {!writable && <p className="capability-note">Reconnect to Hermes to change these settings.</p>}
      <div className="actions">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="primary" disabled={busy || !writable || over > 0}>{busy ? 'Saving…' : 'Save settings'}</button>
      </div>
    </form>
  </Dialog>;
}
