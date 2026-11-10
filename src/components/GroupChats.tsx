import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { api, ApiError, changeStream, write } from '../client-api';
import { insertMention, matchMembers, mentionAt } from '../app/mentions';
import { useAction } from '../app/use-action';
import { useResource } from '../app/use-resource';
import { groupSendKey } from '../app/storage';
import { GROUP_FALLBACK_POLL_MS, GROUPS_EVENT } from '../app/use-session';
import { FormMessage } from './ui/form-message';
import type { Bootstrap } from '../shared/types';
import type { GroupEvent, GroupPage, GroupState } from '../shared/collaboration';
import { assignmentText, groupStatus, memberActivity, scheduledPost } from '../shared/group-activity';
import { GroupSettings } from './GroupSettings';
import { Shimmer } from './Shimmer';
import { MessageMarkdown } from './MessageMarkdown';
import { Icon } from './Icon';
import { Avatar } from './Avatar';
import { When } from './When';
import { imeKey } from '../app/ime';
import { sendsOnKey, useEnterSends } from '../app/enter-key';
import './collaboration.css';
type PendingMessage = { requestId: string; threadId: string; text: string };
type RoomView = { state: GroupState; page: GroupPage };
function saved<T>(key: string): T | null { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }

/**
 * One group chat, open in the main pane. Home lists the rooms and creates them; this shows the
 * room chosen there: its messages, thread replies, approvals and stop control, and the composer.
 * `onChanged` tells home to refresh its preview when the room gets a message.
 */
export function GroupRoomView({ bootstrap, roomId, canSend, reason, onChanged }: { bootstrap: Bootstrap; roomId: string; canSend: boolean; reason?: string; onChanged(): void }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [events, setEvents] = useState<GroupEvent[]>([]);
  const [more, setMore] = useState(false);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const [threadId, setThreadId] = useState('');
  const [replyToId, setReplyToId] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  const scrollLatest = useRef(false);
  const [notice, setNotice] = useState('');
  // Another member made one of its assistants personal, so the group left this person's list.
  const [gone, setGone] = useState(false);
  const action = useAction();
  const { busy, error, setError } = action;
  const key = groupSendKey(bootstrap.user.id, roomId);
  const scope = useRef(key); scope.current = key;
  const changed = useRef(onChanged); changed.current = onChanged;
  // The room log is read from a cursor, so each check adds only newer events to what is shown.
  const cursor = useRef(0);
  // The event stream announces new room events and reloads on reconnect; this slow poll only covers a missed notice.
  const room = useResource<RoomView>(roomId && !gone ? `/groups/${encodeURIComponent(roomId)}` : null, {
    pollMs: GROUP_FALLBACK_POLL_MS,
    load: async (path, signal) => {
      const state = await api<GroupState>(path, { signal });
      // Read after the first request, once a room change has reset the cursor and the events.
      return { state, page: await api<GroupPage>(`${path}/log?since=${cursor.current}`, { signal }) };
    },
    onData: ({ page }) => {
      // Measure before appending so a reader above the bottom stays put.
      const view = panel.current;
      const newMessage = page.events.some(event => event.seq > cursor.current && ['message.user', 'message.member'].includes(event.kind));
      if (!more && !page.has_more && newMessage && view && (cursor.current === 0 || view.scrollHeight - view.clientHeight - view.scrollTop < 48)) scrollLatest.current = true;
      cursor.current = page.cursor;
      if (newMessage) changed.current();
      setEvents(current => [...new Map([...current, ...page.events].map(event => [event.event_id, event])).values()].sort((a, b) => a.seq - b.seq));
      setMore(page.has_more);
    },
    errorMessage: cause => {
      if (!(cause instanceof ApiError && cause.status === 404)) return (cause as Error).message;
      // Its name, members and transcript go at once, whether or not home's list refreshes.
      setGone(true); setEvents([]);
      setNotice('That group chat is no longer available to you.'); changed.current();
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
    // The household stream's catalog notice also covers this room leaving the person's list, which ends
    // this stream without a notice of its own.
    window.addEventListener(GROUPS_EVENT, refresh);
    return () => {
      clearInterval(retry); stream.close();
      window.removeEventListener('online', wake); window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake);
      window.removeEventListener(GROUPS_EVENT, refresh);
    };
  }, [roomId]);
  // Typing @ offers the room's assistants by handle or name.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionList = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  // On a touch screen with no mouse or trackpad, Return starts a new line. Ctrl+Enter and Cmd+Enter
  // send everywhere. See enter-key.ts.
  const enterSends = useEnterSends();
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
    cursor.current = 0; scrollLatest.current = false; setEvents([]); setMore(false); setError(''); setThreadId(''); setReplyToId(''); setGone(false); setNotice(''); setSettingsOpen(false);
    setDraft(saved<string>(`${key}:draft`) || ''); setPending(saved<PendingMessage>(key));
  }, [roomId, key]);
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
  const writable = canSend && bootstrap.connection.connected;
  const messages = events.filter(event => event.kind === 'message.user' || event.kind === 'message.member');
  const memberFor = (id: unknown) => state?.room.members.find(member => member.member_id === id);
  const memberName = (id: unknown) => { const member = memberFor(id);return member?.display_name || member?.profile || 'Assistant'; };
  const author = (event: GroupEvent) => {
    const routine = scheduledPost(event);
    if (routine) return routine.name;
    if (event.kind === 'message.user') return (event.sender?.id || event.actor.id) === bootstrap.user.id ? 'You' : event.sender?.name || 'Household member';
    const member = memberFor(event.actor.id) || memberFor(event.payload.member_id);
    return member?.display_name || member?.profile || event.actor.id || 'Assistant';
  };
  const snippet = (event: GroupEvent) => typeof event.payload.text === 'string' ? event.payload.text.replace(/\s+/g, ' ').trim().slice(0, 100) : 'Message';
  const describe = (event: GroupEvent) => `${author(event)}: ${snippet(event)}`;
  // Messages, with the lead's hand-offs between them. Each message knows the one before it, for thread runs.
  const transcript: { event: GroupEvent; previous?: GroupEvent }[] = [];
  let previousMessage: GroupEvent | undefined;
  for (const event of events) {
    if (event.kind === 'room.assignment') transcript.push({ event });
    else if (event.kind === 'message.user' || event.kind === 'message.member') { transcript.push({ event, previous: previousMessage }); previousMessage = event; }
  }
  // The first loaded message is context for the thread, not a claimed parent ID.
  const threadRoots = new Map<string, GroupEvent>();
  for (const event of messages) if (typeof event.payload.thread_id === 'string' && !threadRoots.has(event.payload.thread_id)) threadRoots.set(event.payload.thread_id, event);
  const replyingTo = messages.find(event => event.event_id === replyToId) || threadRoots.get(threadId);
  const avatar = (id: unknown) => { const bot = bootstrap.bots.find(bot => bot.id === id);return bot && <span aria-hidden="true"><Avatar avatar={bot.avatar} name={bot.name} botId={bot.id} size={24} reducedMotion/></span>; };
  const newTopic = () => { setThreadId('');setReplyToId('');field.current?.focus(); };

  const members = state?.room.members ?? [];
  const status = groupStatus(state?.driver_status, state?.context, members);
  // Who is working right now. Advanced adds each one's tool and round.
  const working = memberActivity(state?.driver_status, members, bootstrap.preferences.presentation === 'advanced');
  // Older Hermes versions have no room settings; a disbanded room has none either.
  const context = state?.context;
  const settingsSaved = () => { setSettingsOpen(false); void room.reload(); };
  useLayoutEffect(() => {
    const view = panel.current;
    if (!scrollLatest.current || !view) return;
    scrollLatest.current = false;
    // Include pending decisions and paging controls after the messages.
    view.scrollTop = view.scrollHeight;
  }, [events, state]);
  // Errors and notes sit inside the conversation's section. The composer sticks to the bottom of the panel only
  // within that section, so a note above the section would push the section down and the composer's buttons with
  // it, off a short screen.
  const notes = <>
    {room.error && <FormMessage tone="error">{room.error} <button onClick={() => void room.reload()}>Retry</button></FormMessage>}
    {error && <FormMessage tone="error">{error}</FormMessage>}
    {notice && <p className="capability-note" role="status">{notice}</p>}
    {reason && !canSend && !gone && <p className="capability-note">{reason}</p>}
  </>;
  return <div className="group-panel" ref={panel}>
    {gone && notes}
    {!gone && <section aria-label="Group conversation">{notes}{state ? <><div className="group-heading"><div>
        <p className="muted">{state.room.members.map(member => `${member.display_name || member.profile} (@${member.handle})`).join(' · ')}</p>
        {context?.purpose && <p className="group-purpose">{context.purpose}</p>}</div>
        <div className="group-heading-actions">
          {context && <button onClick={() => setSettingsOpen(true)}><Icon name="gear" size={14} /> Group settings</button>}
          {state.driver_status?.working && <button disabled={busy || !writable} onClick={() => void act('stop', { requestId: crypto.randomUUID() })}><Icon name="stop" size={14} /> Stop discussion</button>}
        </div></div>
        {transcript.map(({ event, previous }) => {
          const handoff = assignmentText(event, members);
          if (handoff !== null) return <p className="group-assignment" key={event.event_id}>{handoff}</p>;
          const root = typeof event.payload.thread_id === 'string' ? threadRoots.get(event.payload.thread_id) : undefined;
          const inThread = root && root.event_id !== event.event_id;
          const member = memberFor(event.actor.id) || memberFor(event.payload.member_id);
          const routine = scheduledPost(event);
          return <article className={`group-message${replyToId === event.event_id ? ' selected' : ''}${event.kind === 'message.user' && (event.sender?.id || event.actor.id) === bootstrap.user.id ? ' own' : ''}`} key={event.event_id}>
            <div className="message-attribution"><span className="group-speaker">{event.kind === 'message.member' && avatar(member?.member_id)}<strong>{author(event)}</strong>{routine && <span className="group-routine-tag">{routine.failed ? 'Routine failed' : 'Routine'}</span>}</span><When value={event.created_at * 1000}/></div>
            {inThread && previous?.payload.thread_id !== event.payload.thread_id && <p className="group-thread-context">In thread with {describe(root)}</p>}
            <MessageMarkdown text={typeof event.payload.text === 'string' ? event.payload.text : ''}/>
            {typeof event.payload.thread_id === 'string' && <button className="group-reply" aria-label={`Reply in thread to ${describe(event)}`} disabled={busy || !!pending || !writable} onClick={() => { setThreadId(event.payload.thread_id as string);setReplyToId(event.event_id);field.current?.focus(); }}>Reply in thread</button>}
          </article>;
        })}
        {more && <button className="group-more" onClick={() => void room.reload()}>Load more messages</button>}
        {!messages.length && <p className="muted">Start a discussion. Use @handle to address an assistant.</p>}
        {state.driver_status?.pending_actions.map(actionItem => actionItem.kind === 'approval' ? <div className="approval-card" key={actionItem.task_id}>
          <div className="group-requester">{avatar(actionItem.member_id)}<strong>{memberName(actionItem.member_id)} requests approval</strong></div>
          <p>{actionItem.approval?.description || actionItem.approval?.command || 'An assistant needs approval'}</p>
          <div className="actions">{(['once', 'deny'] as const).map(choice => <button key={choice} disabled={busy || !writable} onClick={() => void act('approve', { taskId: actionItem.task_id, memberId: actionItem.member_id, generation: actionItem.execution_generation, requestId: actionItem.request_id || actionItem.approval?.request_id, choice })}>{choice === 'once' ? 'Allow once' : 'Deny'}</button>)}</div>
        </div> : <p key={actionItem.task_id} className="capability-note">The last turn from {memberName(actionItem.member_id)} is unconfirmed. Open this group in Hermes to review it before retrying.</p>)}
        {working.length > 0 && <div role="status" className="state-working"><ul className="group-activity" aria-label="Who is working">
          {working.map(line => <li key={line.memberId}>{avatar(line.memberId)}<span><Shimmer text={line.sentence} />{line.round && <small>{line.round}</small>}</span></li>)}
        </ul></div>}
        <form className="composer group-composer" onSubmit={event => { event.preventDefault(); void send(); }}>{threadId && <div className="group-thread" role="status"><span><strong>Replying in thread</strong><small>{replyingTo ? describe(replyingTo) : 'Earlier messages in this thread'}</small></span><button type="button" onClick={newTopic}>New topic</button></div>}
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
              if (imeKey(event.nativeEvent)) return;
              if (suggesting) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  setMentionIndex(index => (Math.min(index, suggestions.length - 1) + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
                  return;
                }
                if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') { event.preventDefault(); if (chosen) accept(chosen.handle); return; }
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMention(null); return; }
              }
              if (sendsOnKey(event.nativeEvent, enterSends)) { event.preventDefault(); if (!busy && writable && draft.trim()) event.currentTarget.form?.requestSubmit(); }
            }} enterKeyHint={enterSends ? 'send' : 'enter'} />
          <div className="composer-tools"><span id="group-status" role="status" className="group-status">{status}</span>
            {pending ? <button type="submit" className="primary" disabled={busy || !writable}>Retry same saved message</button>
              : <button type="submit" className="send-button" aria-label={busy ? 'Sending…' : 'Send to group'} disabled={busy || !writable || !draft.trim()}><Icon name="send" size={19} /></button>}</div>
        </form></> : !room.error && <p role="status" className="muted">Opening group conversation…</p>}</section>}
    {settingsOpen && state && context && <GroupSettings roomId={roomId} name={state.room.name} members={members} context={context}
      writable={bootstrap.connection.connected} onClose={() => setSettingsOpen(false)} onSaved={settingsSaved} />}
  </div>;
}
