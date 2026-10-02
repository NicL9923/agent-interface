import { useEffect, useRef, useState } from 'react';
import { api, write } from '../client-api';
import type { Bootstrap } from '../shared/types';
import type { GroupCatalog, GroupEvent, GroupPage, GroupRoom, GroupState } from '../shared/collaboration';
import { MessageMarkdown } from './MessageMarkdown';
import './collaboration.css';
type PendingMessage = { requestId: string; threadId: string; text: string };
function saved<T>(key: string): T | null { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }

export function GroupChats({ bootstrap }: { bootstrap: Bootstrap }) {
  const [catalog, setCatalog] = useState<GroupCatalog | null>(null);
  const [roomId, setRoomId] = useState('');
  const [state, setState] = useState<GroupState | null>(null);
  const [events, setEvents] = useState<GroupEvent[]>([]);
  const [more, setMore] = useState(false);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const [threadId, setThreadId] = useState('');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const createKey = `agent-interface:group-create:${bootstrap.user.id}`;
  const [pendingCreate, setPendingCreate] = useState<{ requestId: string; name: string; botIds: string[] } | null>(() => saved(createKey));
  const key = `agent-interface:group-send:${bootstrap.user.id}:${roomId}`;
  const scope = useRef(key); scope.current = key;
  const loadRoom = useRef<() => Promise<void>>(async () => {});
  async function refreshCatalog() {
    const value = await api<GroupCatalog>('/groups');
    setCatalog(value); setRoomId(current => value.rooms.some(room => room.room_id === current) ? current : value.rooms[0]?.room_id || '');
  }
  useEffect(() => {
    let live = true;
    const load = async () => { try { const value = await api<GroupCatalog>('/groups'); if (live) { setCatalog(value); setRoomId(current => value.rooms.some(room => room.room_id === current) ? current : value.rooms[0]?.room_id || ''); setLoadError(''); } } catch (e) { if (live) setLoadError((e as Error).message); } };
    void load(); const timer = setInterval(() => void load(), 15000);
    return () => { live = false; clearInterval(timer); };
  }, [bootstrap.user.id]);
  useEffect(() => {
    let live = true, loading = false, cursor = 0;
    setState(null); setEvents([]); setMore(false); setError(''); setThreadId('');
    setDraft(saved<string>(`${key}:draft`) || ''); setPending(saved<PendingMessage>(key));
    const load = async () => {
      if (!roomId || loading) return;
      loading = true;
      try {
        const next = await api<GroupState>(`/groups/${encodeURIComponent(roomId)}`);
        const page = await api<GroupPage>(`/groups/${encodeURIComponent(roomId)}/log?since=${cursor}`);
        if (live) {
          setState(next); setEvents(current => [...new Map([...current, ...page.events].map(event => [event.event_id, event])).values()].sort((a, b) => a.seq - b.seq));
          cursor = page.cursor; setMore(page.has_more); setLoadError('');
        }
      } catch (e) { if (live) setLoadError((e as Error).message); }
      finally { loading = false; }
    };
    loadRoom.current = load; void load();
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void load(); }, 3000);
    return () => { live = false; clearInterval(timer); };
  }, [roomId, key]);
  async function create() {
    const input = pendingCreate || { requestId: crypto.randomUUID(), name: name.trim(), botIds: members };
    setBusy(true); setError('');
    try {
      localStorage.setItem(createKey, JSON.stringify(input)); setPendingCreate(input);
      const value = await write<{ room: GroupRoom }>('/groups', input);
      localStorage.removeItem(createKey); setPendingCreate(null); setCreating(false); setName(''); setMembers([]);
      await refreshCatalog(); setRoomId(value.room.room_id);
    } catch (e) { setError(`${(e as Error).message} Retry the saved request to check this room's creation.`); }
    finally { setBusy(false); }
  }
  async function send() {
    const input = pending || { requestId: crypto.randomUUID(), threadId: threadId || crypto.randomUUID(), text: draft.trim() };
    const attemptKey = key;
    setBusy(true); setError('');
    try {
      localStorage.setItem(attemptKey, JSON.stringify(input)); setPending(input);
      const response = await write<{ accepted: boolean }>(`/groups/${encodeURIComponent(roomId)}/messages`, input);
      if (response.accepted !== true) throw new Error('Hermes did not confirm this message.');
      localStorage.removeItem(attemptKey); localStorage.removeItem(`${attemptKey}:draft`);
      if (scope.current === attemptKey) { setPending(null); setDraft(''); setThreadId(''); await loadRoom.current(); }
    } catch (e) { if (scope.current === attemptKey) setError(`${(e as Error).message} The message may have arrived. Retry the same saved message to check, without sending a duplicate.`); }
    finally { setBusy(false); }
  }
  async function action(path: string, body: unknown) {
    setBusy(true); setError('');
    try { await write(`/groups/${encodeURIComponent(roomId)}/${path}`, body); await loadRoom.current(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const writable = catalog?.canSend && bootstrap.connection.connected;
  const messages = events.filter(event => event.kind === 'message.user' || event.kind === 'message.member');
  return <div className="group-panel"><div className="panel-header"><div><h2>Group chats</h2><p className="muted">A shared conversation with 2–6 assistants.</p></div><button type="button" disabled={!writable || busy} onClick={() => setCreating(value => !value)}>New group</button></div>
    {loadError && <p className="form-error" role="alert">{loadError} <button onClick={() => void refreshCatalog().catch(e => setLoadError(e.message))}>Retry</button></p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {!catalog && !loadError && <p role="status">Checking Hermes group chats…</p>}
    {catalog?.reason && <p className="capability-note">{catalog.reason}</p>}
    {(creating || pendingCreate) && <form className="group-create" onSubmit={event => { event.preventDefault(); void create(); }}><h3>{pendingCreate ? 'Finish creating group' : 'New group'}</h3>
      {pendingCreate ? <p>{pendingCreate.name} · {pendingCreate.botIds.length} assistants. The saved request will be checked with Hermes.</p> : <><label>Name<input value={name} maxLength={100} required onChange={event => setName(event.target.value)} /></label>
        <fieldset><legend>Choose 2–6 assistants</legend>{bootstrap.bots.filter(bot => !['all', 'everyone'].includes(bot.id.toLowerCase())).map(bot => <label key={bot.id}><input type="checkbox" checked={members.includes(bot.id)} disabled={busy || members.length === 6 && !members.includes(bot.id)} onChange={event => setMembers(current => event.target.checked ? [...current, bot.id] : current.filter(id => id !== bot.id))} />{bot.name}</label>)}</fieldset></>}
      <button type="submit" disabled={busy || !writable || !pendingCreate && (members.length < 2 || !name.trim())}>{pendingCreate ? 'Retry saved group request' : 'Create group'}</button>
    </form>}
    {catalog?.supported && !catalog.rooms.length && <p>No hosted group chats yet. Create one to let your assistants discuss a task together.</p>}
    {!!catalog?.rooms.length && <div className="group-layout"><nav className="group-rooms" aria-label="Group chats">{catalog.rooms.map(room => <button key={room.room_id} disabled={busy} aria-current={roomId === room.room_id ? 'page' : undefined} onClick={() => setRoomId(room.room_id)}>{room.name}<small>{room.members.length} assistants</small></button>)}</nav>
      <section aria-label="Group conversation">{state ? <><div className="panel-header"><h3>{state.room.name}</h3>{state.driver_status?.working && <button disabled={busy || !writable} onClick={() => void action('stop', { requestId: crypto.randomUUID() })}>Stop discussion</button>}</div>
        <p className="muted">{state.room.members.map(member => `${member.display_name || member.profile} (@${member.handle})`).join(' · ')}</p>
        {messages.map(event => { const member = state.room.members.find(member => member.member_id === event.actor.id || member.member_id === event.payload.member_id); return <article className="group-message" key={event.event_id}><div className="message-attribution"><strong>{event.kind === 'message.user' ? 'Household member' : member?.display_name || member?.profile || event.actor.id}</strong><time>{new Date(event.created_at * 1000).toLocaleString()}</time></div><MessageMarkdown text={typeof event.payload.text === 'string' ? event.payload.text : ''} />
          {typeof event.payload.thread_id === 'string' && <button disabled={busy || !!pending || !writable} onClick={() => setThreadId(event.payload.thread_id as string)}>Reply in thread</button>}</article>; })}
        {more && <button onClick={() => void loadRoom.current()}>Load more messages</button>}
        {!messages.length && <p>Start a discussion. Use @handle to address an assistant.</p>}
        <p role="status" className="muted">{state.driver_status?.blocked ? 'Discussion needs attention.' : state.driver_status?.working ? 'Assistants are discussing…' : 'Ready for a topic.'}</p>
        {state.driver_status?.pending_actions.map(actionItem => actionItem.kind === 'approval' ? <div className="approval-card" key={actionItem.task_id}><strong>{actionItem.approval?.description || actionItem.approval?.command || 'An assistant needs approval'}</strong><div className="actions">{(['once', 'deny'] as const).map(choice => <button key={choice} disabled={busy || !writable} onClick={() => void action('approve', { taskId: actionItem.task_id, memberId: actionItem.member_id, generation: actionItem.execution_generation, requestId: actionItem.request_id || actionItem.approval?.request_id, choice })}>{choice === 'once' ? 'Allow once' : 'Deny'}</button>)}</div></div> : <p key={actionItem.task_id} className="capability-note">Hermes cannot confirm a member's last turn. Review it in the native group client before retrying.</p>)}
        <form className="group-composer" onSubmit={event => { event.preventDefault(); void send(); }}>{threadId && <p>Replying in thread <button type="button" onClick={() => setThreadId('')}>New topic</button></p>}
          <label>Message the group<textarea value={pending?.text || draft} disabled={busy || !!pending || !writable} maxLength={16000} onChange={event => { setDraft(event.target.value); try { localStorage.setItem(`${key}:draft`, JSON.stringify(event.target.value)); } catch { setError('This browser cannot save your group draft.'); } }} /></label>
          <button type="submit" className="primary" disabled={busy || !writable || !pending && !draft.trim()}>{busy ? 'Sending…' : pending ? 'Retry same saved message' : 'Send to group'}</button>
        </form></> : <p role="status">Opening group conversation…</p>}</section>
    </div>}
  </div>;
}
