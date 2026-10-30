import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { api, ApiError, changeStream, write } from '../client-api';
import { insertMention, matchMembers, mentionAt } from '../app/mentions';
import { useAction } from '../app/use-action';
import { useResource } from '../app/use-resource';
import { groupCreateKey, groupSendKey } from '../app/storage';
import { FormMessage } from './ui/form-message';
import type { Bootstrap } from '../shared/types';
import type { GroupCatalog, GroupEvent, GroupPage, GroupRoom, GroupState } from '../shared/collaboration';
import { MessageMarkdown } from './MessageMarkdown';
import { Icon } from './Icon';
import { Avatar } from './Avatar';
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
  const [replyToId, setReplyToId] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  const lastMessage = useRef<HTMLElement>(null);
  const scrollLatest = useRef(false);
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
  // The event stream announces new room events; this slow poll only covers a missed notice.
  const room = useResource<RoomView>(roomId ? `/groups/${encodeURIComponent(roomId)}` : null, {
    pollMs: 30000,
    load: async (path, signal) => {
      const state = await api<GroupState>(path, { signal });
      // Read after the first request, once a room change has reset the cursor and the events.
      return { state, page: await api<GroupPage>(`${path}/log?since=${cursor.current}`, { signal }) };
    },
    onData: ({ page }) => {
      // Measure before appending so a reader above the bottom stays put.
      const view = panel.current;
      const newMessage = page.events.some(event => event.seq > cursor.current && ['message.user', 'message.member'].includes(event.kind));
      if (newMessage && view && view.scrollHeight - view.clientHeight - view.scrollTop < 48) scrollLatest.current = true;
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
  // While a room is open, its stream asks the server to watch it, and a `group` notice names new events.
  const reloadRoom = useRef(room.reload); reloadRoom.current = room.reload;
  useEffect(() => {
    if (!roomId) return;
    // Notices that arrive while the room loads share one more load after it, instead of each
    // restarting it. This room's own reload does nothing once another room is open.
    const reload = reloadRoom.current;
    let loading = false, again = false;
    const refresh = () => {
      if (loading) { again = true; return; }
      loading = true;
      void reload().finally(() => { loading = false; if (again) { again = false; refresh(); } });
    };
    const stream = changeStream(`/events?group=${encodeURIComponent(roomId)}`, refresh, undefined, {
      // Every notice counts, even one at the cursor: the server also announces driver status
      // changes, such as a new pending approval, that add no event.
      group: data => {
        try {
          if ((JSON.parse(data) as { roomId?: string }).roomId === roomId) refresh();
        } catch { refresh(); }
      },
    });
    const wake = () => { if (document.visibilityState !== 'hidden' && navigator.onLine !== false) stream.open(); else stream.close(); };
    wake();
    const retry = setInterval(wake, 45_000);
    window.addEventListener('online', wake); window.addEventListener('focus', wake); document.addEventListener('visibilitychange', wake);
    return () => {
      clearInterval(retry); stream.close();
      window.removeEventListener('online', wake); window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake);
    };
  }, [roomId]);
  // Typing @ offers the room's assistants by handle or name.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionList = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  const suggestions = mention && state ? matchMembers(state.room.members, mention.query) : [];
  const suggesting = suggestions.length > 0;
  const chosen = suggestions[Math.min(mentionIndex, suggestions.length - 1)];
  const findMention = (input: HTMLTextAreaElement) => {
    const found = input.selectionStart === input.selectionEnd ? mentionAt(input.value, input.selectionStart) : null;
    setMention(current => current?.start === found?.start && current?.query === found?.query ? current : found);
    if (found?.start !== mention?.start) setMentionIndex(0);
  };
  const saveDraft = (text: string) => { setDraft(text); try { localStorage.setItem(`${key}:draft`, JSON.stringify(text)); } catch { setError('This browser cannot save your group draft.'); } };
  const accept = (handle: string) => {
    if (!mention) return;
    const next = insertMention(draft, mention, handle);
    caret.current = next.caret;
    saveDraft(next.text); setMention(null);
  };
  useLayoutEffect(() => {
    if (caret.current === null || !field.current) return;
    field.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [draft]);
  useEffect(() => {
    cursor.current = 0; scrollLatest.current = false; setEvents([]); setMore(false); setError(''); setThreadId(''); setReplyToId('');
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
      if (scope.current === attemptKey) { setPending(null); setDraft(''); setThreadId(''); setReplyToId(''); scrollLatest.current = true; await room.reload(); }
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
  const memberFor = (id: unknown) => state?.room.members.find(member => member.member_id === id);
  const memberName = (id: unknown) => { const member = memberFor(id);return member?.display_name || member?.profile || 'Assistant'; };
  const author = (event: GroupEvent) => {
    if (event.kind === 'message.user') return (event.sender?.id || event.actor.id) === bootstrap.user.id ? 'You' : event.sender?.name || 'Household member';
    const member = memberFor(event.actor.id) || memberFor(event.payload.member_id);
    return member?.display_name || member?.profile || event.actor.id || 'Assistant';
  };
  const snippet = (event: GroupEvent) => typeof event.payload.text === 'string' ? event.payload.text.replace(/\s+/g, ' ').trim().slice(0, 100) : 'Message';
  const context = (event: GroupEvent) => `${author(event)}: ${snippet(event)}`;
  // The first loaded message is context for the thread, not a claimed parent ID.
  const threadRoots = new Map<string, GroupEvent>();
  for (const event of messages) if (typeof event.payload.thread_id === 'string' && !threadRoots.has(event.payload.thread_id)) threadRoots.set(event.payload.thread_id, event);
  const replyingTo = messages.find(event => event.event_id === replyToId) || threadRoots.get(threadId);
  const avatar = (id: unknown) => { const bot = bootstrap.bots.find(bot => bot.id === id);return bot && <span aria-hidden="true"><Avatar avatar={bot.avatar} name={bot.name} botId={bot.id} size={24} reducedMotion/></span>; };
  const newTopic = () => { setThreadId('');setReplyToId('');field.current?.focus(); };

  const newGroup = <button type="button" className="group-new" disabled={!writable || busy} aria-expanded={creating} onClick={() => setCreating(value => !value)}><Icon name="plus" size={16} />New group</button>;
  const createForm = (creating || pendingCreate) && <form className="group-create" onSubmit={event => { event.preventDefault(); void create(); }}><h3>{pendingCreate ? 'Finish creating group' : 'New group'}</h3>
    {pendingCreate ? <p>{pendingCreate.name} · {pendingCreate.botIds.length} assistants. The saved request will be checked with Hermes.</p> : <><label>Name<input value={name} maxLength={100} required onChange={event => setName(event.target.value)} /></label>
      <fieldset><legend>Choose 2–6 assistants <span role="status">· {members.length} chosen</span></legend>{bootstrap.bots.filter(bot => !['all', 'everyone'].includes(bot.id.toLowerCase())).map(bot => <label key={bot.id}><input type="checkbox" checked={members.includes(bot.id)} disabled={busy || members.length === 6 && !members.includes(bot.id)} onChange={event => setMembers(current => event.target.checked ? [...current, bot.id] : current.filter(id => id !== bot.id))} />{avatar(bot.id)}{bot.name}</label>)}</fieldset>
      {members.length === 6 && <p className="muted" role="status">Six assistants selected. Deselect one to choose another.</p>}
      {members.some(id => bootstrap.bots.some(bot => bot.id === id && !bot.shared && bot.ownerId)) && <p className="muted">Only you will see this group, because it includes your personal assistant.</p>}</>}
    <div className="actions">{!pendingCreate && <button type="button" onClick={() => setCreating(false)}>Cancel</button>}<button type="submit" className="primary" disabled={busy || !writable || !pendingCreate && (members.length < 2 || !name.trim())}>{pendingCreate ? 'Retry saved group request' : 'Create group'}</button></div>
  </form>;
  // A saved uncertain request stays above the rooms so they remain readable until it is retried.
  const drafting = creating && !pendingCreate;
  const status = state?.driver_status?.blocked ? 'Discussion needs attention.' : state?.driver_status?.working ? 'Assistants are discussing…' : 'Type @ to address one assistant.';
  useLayoutEffect(() => {
    const target = lastMessage.current;
    if (!scrollLatest.current || !target) return;
    scrollLatest.current = false;
    const composerHeight = field.current?.form?.getBoundingClientRect().height || 0;
    // scrollIntoView aligns with the outer scrollport, including its padding.
    const bottomPadding = panel.current ? parseFloat(getComputedStyle(panel.current).paddingBottom) || 0 : 0;
    target.style.scrollMarginBottom = `${composerHeight + bottomPadding + 16}px`;
    target.scrollIntoView?.({ block: 'end' });
  }, [events, state, creating, pendingCreate]);
  return <div className="group-panel" ref={panel}>
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
        {messages.map(event => {
          const root = typeof event.payload.thread_id === 'string' ? threadRoots.get(event.payload.thread_id) : undefined;
          const inThread = root && root.event_id !== event.event_id;
          const member = memberFor(event.actor.id) || memberFor(event.payload.member_id);
          return <article className={`group-message${replyToId === event.event_id ? ' selected' : ''}${event.kind === 'message.user' && (event.sender?.id || event.actor.id) === bootstrap.user.id ? ' own' : ''}`} key={event.event_id} ref={event === messages.at(-1) ? lastMessage : undefined}>
            <div className="message-attribution"><span className="group-speaker">{event.kind === 'message.member' && avatar(member?.member_id)}<strong>{author(event)}</strong></span><When value={event.created_at * 1000}/></div>
            {inThread && <p className="group-thread-context">In thread with {context(root)}</p>}
            <MessageMarkdown text={typeof event.payload.text === 'string' ? event.payload.text : ''}/>
            {typeof event.payload.thread_id === 'string' && <button className="group-reply" aria-label={`Reply in thread to ${context(event)}`} disabled={busy || !!pending || !writable} onClick={() => { setThreadId(event.payload.thread_id as string);setReplyToId(event.event_id);field.current?.focus(); }}>Reply in thread</button>}
          </article>;
        })}
        {more && <button className="group-more" onClick={() => void room.reload()}>Load more messages</button>}
        {!messages.length && <p className="muted">Start a discussion. Use @handle to address an assistant.</p>}
        {state.driver_status?.pending_actions.map(actionItem => actionItem.kind === 'approval' ? <div className="approval-card" key={actionItem.task_id}>
          <div className="group-requester">{avatar(actionItem.member_id)}<strong>{memberName(actionItem.member_id)} requests approval</strong></div>
          <p>{actionItem.approval?.description || actionItem.approval?.command || 'An assistant needs approval'}</p>
          <div className="actions">{(['once', 'deny'] as const).map(choice => <button key={choice} disabled={busy || !writable} onClick={() => void act('approve', { taskId: actionItem.task_id, memberId: actionItem.member_id, generation: actionItem.execution_generation, requestId: actionItem.request_id || actionItem.approval?.request_id, choice })}>{choice === 'once' ? 'Allow once' : 'Deny'}</button>)}</div>
        </div> : <p key={actionItem.task_id} className="capability-note">The last turn from {memberName(actionItem.member_id)} is unconfirmed. Open this group in Hermes to review it before retrying.</p>)}
        <form className="composer group-composer" onSubmit={event => { event.preventDefault(); void send(); }}>{threadId && <div className="group-thread" role="status"><span><strong>Replying in thread</strong><small>{replyingTo ? context(replyingTo) : 'Earlier messages in this thread'}</small></span><button type="button" onClick={newTopic}>New topic</button></div>}
          <label className="sr-only" htmlFor="group-message">Message the group</label>
          {suggesting && <ul className="mention-list" id={mentionList} role="listbox" aria-label="Assistants in this group">
            {suggestions.map(member => <li key={member.member_id} id={`${mentionList}-${member.member_id}`} role="option" aria-selected={member === chosen}
              onPointerDown={event => event.preventDefault()} onClick={() => accept(member.handle)}>
              <strong>{member.display_name || member.profile}</strong><small>@{member.handle}</small></li>)}
          </ul>}
          <textarea ref={field} id="group-message" rows={2} placeholder="Message the group" aria-describedby="group-status" value={pending?.text || draft} disabled={busy || !!pending || !writable} maxLength={16000}
            aria-autocomplete="list" aria-controls={suggesting ? mentionList : undefined}
            aria-activedescendant={suggesting && chosen ? `${mentionList}-${chosen.member_id}` : undefined}
            onChange={event => { saveDraft(event.target.value); findMention(event.target); }}
            onSelect={event => findMention(event.currentTarget)} onBlur={() => setMention(null)}
            onKeyDown={event => {
              if (suggesting && !event.nativeEvent.isComposing) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  setMentionIndex(index => (Math.min(index, suggestions.length - 1) + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
                  return;
                }
                if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') { event.preventDefault(); if (chosen) accept(chosen.handle); return; }
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMention(null); return; }
              }
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy && writable && draft.trim()) event.currentTarget.form?.requestSubmit(); }
            }} />
          <div className="composer-tools"><span id="group-status" role="status" className="group-status">{status}</span>
            {pending ? <button type="submit" className="primary" disabled={busy || !writable}>Retry same saved message</button>
              : <button type="submit" className="send-button" aria-label={busy ? 'Sending…' : 'Send to group'} disabled={busy || !writable || !draft.trim()}><Icon name="send" size={19} /></button>}</div>
        </form></> : <p role="status" className="muted">Opening group conversation…</p>)}</section>
    </div>}
  </div>;
}
