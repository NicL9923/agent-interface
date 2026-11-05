import { expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import type { RuntimeEvent } from '../src/shared/types.js';

// Hermes lets two assistants hold jobs with one ID, so routine recipients are kept by assistant and routine.
function setup() {
  const store = new Store(':memory:');
  for (const id of ['alice', 'bob', 'carol']) store.user({ id, name: id, email: `${id}@example.test` });
  store.savePresentation('private', { shared: false, ownerId: 'alice' });
  return store;
}
const event = (botId: string): RuntimeEvent => ({ id: `${botId}-done`, botId, routineId: 'dup', kind: 'completed', title: 'Done', occurredAt: 'now' });

it("keeps each assistant's routine recipients apart when their routines share an ID", () => {
  const store = setup();
  store.routineRecipients('shared', 'dup', ['bob']);
  store.routineRecipients('private', 'dup', ['alice']);
  expect(store.getRoutineRecipients('shared', 'dup')).toEqual(['bob']);
  expect(store.getRoutineRecipients('private', 'dup')).toEqual(['alice']);
  expect(store.recipients(event('shared'))).toEqual(['bob']);
  expect(store.recipients(event('private'))).toEqual(['alice']);
  // Forgetting one assistant leaves the other's list.
  store.forgetBot('private');
  expect(store.getRoutineRecipients('shared', 'dup')).toEqual(['bob']);
  expect(store.getRoutineRecipients('private', 'dup')).toEqual([]);
});

it('moves the earlier recipients, kept by routine ID alone, to every assistant holding that ID', () => {
  const store = setup();
  // As an earlier release left them.
  for (const [routine, user] of [['dup', 'bob'], ['dup', 'carol'], ['solo', 'carol'], ['gone', 'bob']])
    store.db.prepare('INSERT INTO routine_recipients VALUES(?,?)').run(routine, user);
  // Before the move, the earlier record still reaches whoever holds the ID.
  expect(store.getRoutineRecipients('shared', 'dup')).toEqual(['bob', 'carol']);
  store.adoptLegacyRecipients([{ id: 'dup', botId: 'shared' }, { id: 'dup', botId: 'private' }, { id: 'solo', botId: 'shared' }]);
  // Two assistants hold "dup" and nobody can tell which was meant, so both keep its recipients.
  expect(store.getRoutineRecipients('shared', 'dup')).toEqual(['bob', 'carol']);
  expect(store.getRoutineRecipients('private', 'dup')).toEqual(['bob', 'carol']);
  expect(store.getRoutineRecipients('shared', 'solo')).toEqual(['carol']);
  // Once moved, a later saving or a new holder of the ID never touches another's list.
  store.routineRecipients('private', 'dup', ['alice']);
  expect(store.getRoutineRecipients('shared', 'dup')).toEqual(['bob', 'carol']);
  expect(store.getRoutineRecipients('third', 'dup')).toEqual([]);
  // An ID Hermes no longer lists waits; moving twice changes nothing.
  expect(store.getRoutineRecipients('shared', 'gone')).toEqual(['bob']);
  store.adoptLegacyRecipients([{ id: 'dup', botId: 'third' }]);
  expect(store.getRoutineRecipients('third', 'dup')).toEqual([]);
  // The earlier record stays as it was, for a rollback to the previous release.
  expect(store.db.prepare("SELECT COUNT(*) AS n FROM routine_recipients WHERE routine_id='dup'").get()).toEqual({ n: 2 });
});

it("keeps the earlier recipients another assistant still needs when one holding the same ID is deleted", () => {
  const store = setup();
  store.db.prepare('INSERT INTO routine_recipients VALUES(?,?)').run('dup', 'bob');
  // "a" ran a trial of its "dup", which ties the ID to it, and is then deleted before the move.
  store.rememberRoutineTrial('3f1c2a4e-8b7d-4c6e-9a5f-1d2e3c4b5a69', 'bob', 'dup', 'a');
  store.routineRecipients('a', 'other', ['carol']);
  store.forgetBot('a');
  expect(store.getRoutineRecipients('b', 'dup')).toEqual(['bob']);
  store.adoptLegacyRecipients([{ id: 'dup', botId: 'b' }]);
  expect(store.getRoutineRecipients('b', 'dup')).toEqual(['bob']);
  // Its own lists go.
  expect(store.db.prepare("SELECT COUNT(*) AS n FROM routine_profile_recipients WHERE bot_id='a'").get()).toEqual({ n: 0 });
});
