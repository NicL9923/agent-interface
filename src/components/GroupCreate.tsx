import { useId, useState } from 'react';
import { write } from '../client-api';
import { useAction } from '../app/use-action';
import { groupCreateKey } from '../app/storage';
import { pendingGroup, type PendingGroup } from '../app/home-rooms';
import { Dialog } from './ui/dialog';
import { FormMessage } from './ui/form-message';
import type { Bootstrap } from '../shared/types';
import type { GroupRoom } from '../shared/collaboration';
import { Avatar } from './Avatar';
import { Button } from './ui/button';
import { Icon } from './Icon';
import './collaboration.css';

/**
 * Starts a group chat from home's New menu. The request is saved before it is sent and kept
 * until Hermes answers, so a retry after a lost connection checks the same room instead of
 * making a second one. Home offers a saved request as "Finish creating group".
 */
export function GroupCreate({ bootstrap, canSend, onClose, onCreated }: { bootstrap: Bootstrap; canSend: boolean; onClose(): void; onCreated(room: GroupRoom): void }) {
  const createKey = groupCreateKey(bootstrap.user.id);
  const action = useAction();
  const { busy, error } = action;
  const [name, setName] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [saved, setSaved] = useState<PendingGroup | null>(() => pendingGroup(bootstrap.user.id));
  const titleId = useId();
  const writable = canSend && bootstrap.connection.connected;
  const create = () => {
    const input = saved || { requestId: crypto.randomUUID(), name: name.trim(), botIds: members };
    return action.run(async () => {
      localStorage.setItem(createKey, JSON.stringify(input)); setSaved(input);
      const value = await write<{ room: GroupRoom }>('/groups', input);
      localStorage.removeItem(createKey); setSaved(null);
      onCreated(value.room);
    }, { onError: cause => `${(cause as Error).message} Retry the saved request to check this room's creation.` });
  };
  const choices = bootstrap.bots.filter(bot => !['all', 'everyone'].includes(bot.id.toLowerCase()));
  return <Dialog className="settings-sheet group-create-sheet" aria-labelledby={titleId} initialFocus="input, button.primary" onCancel={onClose} onClose={onClose}>
    <header className="sheet-header">
      <Button className="sheet-close" aria-label="Close" onClick={onClose}><Icon name="close" /></Button>
      <h2 id={titleId}>{saved ? 'Finish creating group' : 'New group chat'}</h2>
    </header>
    <form className="sheet-body group-create" onSubmit={event => { event.preventDefault(); void create(); }}>
      {error && <FormMessage tone="error">{error}</FormMessage>}
      {!canSend && <p className="capability-note">Hermes group chats are unavailable right now. Try again once Hermes is connected.</p>}
      {saved ? <p>{saved.name} · {saved.botIds.length} assistants. The saved request will be checked with Hermes.</p> : <>
        <label>Name<input value={name} maxLength={100} required onChange={event => setName(event.target.value)} /></label>
        <fieldset><legend>Choose 2–6 assistants <span role="status">· {members.length} chosen</span></legend>
          {choices.map(bot => <label key={bot.id}>
            <input type="checkbox" checked={members.includes(bot.id)} disabled={busy || members.length === 6 && !members.includes(bot.id)}
              onChange={event => setMembers(current => event.target.checked ? [...current, bot.id] : current.filter(id => id !== bot.id))} />
            <span aria-hidden="true"><Avatar avatar={bot.avatar} name={bot.name} botId={bot.id} size={24} reducedMotion /></span>{bot.name}
          </label>)}
        </fieldset>
        {members.length === 6 && <p className="muted" role="status">Six assistants selected. Deselect one to choose another.</p>}
        {members.some(id => bootstrap.bots.some(bot => bot.id === id && !bot.shared && bot.ownerId)) && <p className="muted">Only you will see this group, because it includes your personal assistant.</p>}
      </>}
      <div className="actions">
        <button type="button" onClick={onClose}>{saved ? 'Not now' : 'Cancel'}</button>
        <button type="submit" className="primary" disabled={busy || !writable || !saved && (members.length < 2 || !name.trim())}>{saved ? 'Retry saved group request' : 'Create group'}</button>
      </div>
    </form>
  </Dialog>;
}
