import { useEffect, useRef, useState } from 'react';
import { api, ApiError, write } from '../client-api';
import { useAction } from '../app/use-action';
import { useResource } from '../app/use-resource';
import { groupCreateKey, groupSendKey } from '../app/storage';
import { FormMessage } from './ui/form-message';
import type { Bootstrap } from '../shared/types';
import type { GroupCatalog, GroupEvent, GroupPage, GroupRoom, GroupState } from '../shared/collaboration';
import { MessageMarkdown } from './MessageMarkdown';
import { Icon } from './Icon';
import { When } from './When';
import './collaboration.css';
type PendingMessage = { requestId: string; threadId: string; text: string };
type RoomView = { state: GroupState; page: GroupPage };
function saved<T>(key: string): T | null { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }

export function GroupChats({ bootstrap }: { bootstrap: Bootstrap }) {
  const [roomId, setRoomId] = useState('');
  const [events, setEvents] = useState<GroupEvent[]>([]);
  const [more, setMore] = useState(false);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const [threadId, setThreadId] = useState('');
  const [notice, setNotice] = useState('');
  const action = useAction();
  const { busy, error, setError } = action;
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const createKey = groupCreateKey(bootstrap.user.id);
  const [pendingCreate, setPendingCreate] = useState<{ requestId: string; name: string; botIds: string[] } | null>(() => saved(createKey));
  const key = groupSendKey(bootstrap.user.id, roomId);
  const scope = useRef(key); scope.current = key;
  const groups = useResource<GroupCatalog>('/groups', {
    deps: [bootstrap.user.id], pollMs: 15000,
    onData: value => setRoomId(current => value.rooms.some(room => room.room_id === current) ? current : value.rooms[0]?.room_id || ''),
  });
  const { data: catalog, setData: setCatalog } = groups;
  // The room log is read from a cursor, so each check adds only newer events to what is shown.
  const cursor = useRef(0);
  const room = useResource<RoomView>(roomId ? `/groups/${encodeURIComponent(roomId)}` : null, {
    pollMs: 3000,
    load: async (path, signal) => {
      const state = await api<GroupState>(path, { signal });
      // Read after the first request, once a room change has reset the cursor and the events.
      return { state, page: await api<GroupPage>(`${path}/log?since=${cursor.current}`, { signal }) };
    },
    onData: ({ page }) => {
      cursor.current = page.cursor;
      setEvents(current => [...new Map([...current, ...page.events].map(event => [event.event_id, event])).values()].sort((a, b) => a.seq - b.seq));
      setMore(page.has_more);
    },
    errorMessage: cause => {
      if (!(cause instanceof ApiError && cause.status === 404)) return (cause as Error).message;
      // Another member made one of its assistants personal, so the group left this person's list.
      // Its name, members and transcript go at once, whether or not the list refreshes.
      setRoomId(''); setEvents([]);
      setCatalog(current => current && { ...current, rooms: current.rooms.filter(row => row.room_id !== roomId) });
      setNotice('That group chat is no longer available to you.'); void groups.reload();
      return '';
    },
  });
  const state = room.data?.state ?? null;
  useEffect(() => {
    cursor.current = 0; setEvents([]); setMore(false); setError(''); setThreadId('');
    setDraft(saved<string>(`${key}:draft`) || ''); setPending(saved<PendingMessage>(key));
  }, [roomId, key]);
  const create = () => {
    const input = pendingCreate || { requestId: crypto.randomUUID(), name: name.trim(), botIds: members };
    return action.run(async () => {
      localStorage.setItem(createKey, JSON.stringify(input)); setPendingCreate(input);
      const value = await write<{ room: GroupRoom }>('/groups', input);
      localStorage.removeItem(createKey); setPendingCreate(null); setCreating(false); setName(''); setMembers([]);
      await groups.reload(); setRoomId(value.room.room_id);
    }, { onError: cause => `${(cause as Error).message} Retry the saved request to check this room's creation.` });
  };
  const send = () => {
    const input = pending || { requestId: crypto.randomUUID(), threadId: threadId || crypto.randomUUID(), text: draft.trim() };
    const attemptKey = key;
    return action.run(async () => {
      localStorage.setItem(attemptKey, JSON.stringify(input)); setPending(input);
      const response = await write<{ accepted: boolean }>(`/groups/${encodeURIComponent(roomId)}/messages`, input);
      if (response.accepted !== true) throw new Error('Hermes did not confirm this message.');
      localStorage.removeItem(attemptKey); localStorage.removeItem(`${attemptKey}:draft`);
      if (scope.current === attemptKey) { setPending(null); setDraft(''); setThreadId(''); await room.reload(); }
    }, { onError: cause => scope.current === attemptKey ? `${(cause as Error).message} The message may have arrived. Retry the same saved message to check, without sending a duplicate.` : null });
  };
  // The room may change or leave the list while this runs. Its reload is then inert, and its error is not shown on another room.
  const act = (path: string, body: unknown) => {
    const attemptKey = key;
    return action.run(async () => {
      await write(`/groups/${encodeURIComponent(roomId)}/${path}`, body); await room.reload();
    }, { onError: cause => scope.current === attemptKey ? (cause as Error).message : null });
  };
  const writable = catalog?.canSend && bootstrap.connection.connected;
  const messages = events.filter(event => event.kind === 'message.user' || event.kind === 'message.member');
  const newGroup = <button type="button" className="group-new" disabled={!writable || busy} aria-expanded={creating} onClick={() => setCreating(value => !value)}><Icon name="plus" size={16} />New group</button>;
  const createForm = (creating || pendingCreate) && <form className="group-create" onSubmit={event => { event.preventDefault(); void create(); }}><h3>{pendingCreate ? 'Finish creating group' : 'New group'}</h3>
    {pendingCreate ? <p>{pendingCreate.name} · {pendingCreate.botIds.length} assistants. The saved request will be checked with Hermes.</p> : <><label>Name<input value={name} maxLength={100} required onChange={event => setName(event.target.value)} /></label>
      <fieldset><legend>Choose 2–6 assistants</legend>{bootstrap.bots.filter(bot => !['all', 'everyone'].includes(bot.id.toLowerCase())).map(bot => <label key={bot.id}><input type="checkbox" checked={members.includes(bot.id)} disabled={busy || members.length === 6 && !members.includes(bot.id)} onChange={event => setMembers(current => event.target.checked ? [...current, bot.id] : current.filter(id => id !== bot.id))} />{bot.name}</label>)}</fieldset>
      {members.some(id => bootstrap.bots.some(bot => bot.id === id && !bot.shared && bot.ownerId)) && <p className="muted">Only you will see this group, because it includes your personal assistant.</p>}</>}
    <div className="actions">{!pendingCreate && <button type="button" onClick={() => setCreating(false)}>Cancel</button>}<button type="submit" className="primary" disabled={busy || !writable || !pendingCreate && (members.length < 2 || !name.trim())}>{pendingCreate ? 'Retry saved group request' : 'Create group'}</button></div>
  </form>;
  // A saved uncertain request stays above the rooms so they remain readable until it is retried.
  const drafting = creating && !pendingCreate;
  const status = state?.driver_status?.blocked ? 'Discussion needs attention.' : state?.driver_status?.working ? 'Assistants are discussing…' : 'Ready for a topic.';
  return <div className="group-panel">
    {(groups.error || room.error) && <FormMessage tone="error">{groups.error || room.error} <button onClick={() => { void groups.reload(); void room.reload(); }}>Retry</button></FormMessage>}
    {error && <FormMessage tone="error">{error}</FormMessage>}
    {notice && <p className="capability-note" role="status">{notice}</p>}
    {!catalog && !groups.error && !room.error && <p role="status" className="muted">Checking Hermes group chats…</p>}
    {catalog?.reason && <p className="capability-note">{catalog.reason}</p>}
    {pendingCreate && createForm}
    {catalog?.supported && !catalog.rooms.length && !pendingCreate && <>{createForm || <div className="group-empty"><p>No group chats yet. Create one to let your assistants discuss a task together.</p>{newGroup}</div>}</>}
    {!!catalog?.rooms.length && <div className="group-layout"><nav className="group-rooms" aria-label="Group chats">{catalog.rooms.map(room => <button key={room.room_id} disabled={busy} aria-current={roomId === room.room_id && !drafting ? 'page' : undefined} onClick={() => { setCreating(false); setNotice(''); setRoomId(room.room_id); }}>{room.name}<small>{room.members.length} assistants</small></button>)}{newGroup}</nav>
      <section aria-label="Group conversation">{drafting ? createForm : (state ? <><div className="group-heading"><div><h3>{state.room.name}</h3>
        <p className="muted">{state.room.members.map(member => `${member.display_name || member.profile} (@${member.handle})`).join(' · ')}</p></div>{state.driver_status?.working && <button disabled={busy || !writable} onClick={() => void act('stop', { requestId: crypto.randomUUID() })}><Icon name="stop" size={14} /> Stop discussion</button>}</div>
        {messages.map(event => { const member = state.room.members.find(member => member.member_id === event.actor.id || member.member_id === event.payload.member_id); return <article className="group-message" key={event.event_id}><div className="message-attribution"><strong>{event.kind === 'message.user' ? 'Household member' : member?.display_name || member?.profile || event.actor.id}</strong><When value={event.created_at * 1000} /></div><MessageMarkdown text={typeof event.payload.text === 'string' ? event.payload.text : ''} />
          {typeof event.payload.thread_id === 'string' && <button className="group-reply" disabled={busy || !!pending || !writable} onClick={() => setThreadId(event.payload.thread_id as string)}>Reply in thread</button>}</article>; })}
        {more && <button className="group-more" onClick={() => void room.reload()}>Load more messages</button>}
        {!messages.length && <p className="muted">Start a discussion. Use @handle to address an assistant.</p>}
        {state.driver_status?.pending_actions.map(actionItem => actionItem.kind === 'approval' ? <div className="approval-card" key={actionItem.task_id}><strong>{actionItem.approval?.description || actionItem.approval?.command || 'An assistant needs approval'}</strong><div className="actions">{(['once', 'deny'] as const).map(choice => <button key={choice} disabled={busy || !writable} onClick={() => void act('approve', { taskId: actionItem.task_id, memberId: actionItem.member_id, generation: actionItem.execution_generation, requestId: actionItem.request_id || actionItem.approval?.request_id, choice })}>{choice === 'once' ? 'Allow once' : 'Deny'}</button>)}</div></div> : <p key={actionItem.task_id} className="capability-note">Hermes cannot confirm a member's last turn. Review it in the native group client before retrying.</p>)}
        <form className="composer group-composer" onSubmit={event => { event.preventDefault(); void send(); }}>{threadId && <p className="group-thread">Replying in thread <button type="button" onClick={() => setThreadId('')}>New topic</button></p>}
          <label className="sr-only" htmlFor="group-message">Message the group</label>
          <textarea id="group-message" rows={2} placeholder="Message the group… use @handle to address one assistant" value={pending?.text || draft} disabled={busy || !!pending || !writable} maxLength={16000} onChange={event => { setDraft(event.target.value); try { localStorage.setItem(`${key}:draft`, JSON.stringify(event.target.value)); } catch { setError('This browser cannot save your group draft.'); } }}
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy && writable && draft.trim()) event.currentTarget.form?.requestSubmit(); } }} />
          <div className="composer-tools"><span role="status" className="group-status">{status}</span>
            {pending ? <button type="submit" className="primary" disabled={busy || !writable}>Retry same saved message</button>
              : <button type="submit" className="send-button" aria-label={busy ? 'Sending…' : 'Send to group'} disabled={busy || !writable || !draft.trim()}><Icon name="send" size={19} /></button>}</div>
        </form></> : <p role="status" className="muted">Opening group conversation…</p>)}</section>
    </div>}
  </div>;
}
