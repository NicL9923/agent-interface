// Synthetic browser fixture only. No native Hermes operations or external events.
const profiles = new Map();
const revision = 'a'.repeat(64);
const stateFor = botId => {
  if (!profiles.has(botId)) profiles.set(botId, { botId, owner: 'Hermes', canManageTriggers: true,
    goals: { supported: true, goal: { title: 'Prepare a fall maintenance plan for the ranch', status: 'paused', turnsUsed: 0, maxTurns: 20 } },
    tasks: { supported: true, items: [{ id: 'task-fence', title: 'Review the north fence inspection', body: 'Read the latest inspection notes, then list repairs and supplies. Ask before ordering anything.', status: 'blocked', priority: 1, assignee: botId, owner: botId, dependencies: [], blockedReason: 'Waiting for you to start.' }] },
    triggers: { supported: true, platformEnabled: true, items: [{ id: 'ranch-alert', description: 'Review new ranch alerts', events: ['alert.created'], routineId: 'r1', enabled: false, url: 'https://hermes.example.test/hooks/ranch-alert', secretSet: true, revision }] },
    skills: { supported: true, approvalRequired: true, installed: [{ name: 'ranch-maintenance', description: 'Seasonal maintenance checklists and supply planning.' }], pending: [{ id: 'aabbccdd', summary: 'Check water before planning feed', origin: 'background review', revision }] },
  });
  return profiles.get(botId);
};

export function automationPreview(path, method, body, query, send) {
  const match = /^\/bots\/([^/]+)\/automation(.*)$/.exec(path);
  if (!match) return false;
  const state = stateFor(decodeURIComponent(match[1])), suffix = match[2];
  const reply = value => { send(value); return true; };
  if (!suffix && method === 'GET') return reply(state);
  if (suffix === '/goal') { state.goals.goal = { title: body.title, maxTurns: body.maxTurns, status: 'paused', turnsUsed: 0 }; return reply(state); }
  if (suffix.startsWith('/goal/')) {
    const action = suffix.split('/').at(-1);
    if (action === 'clear') state.goals.goal = null;
    else if (state.goals.goal) state.goals.goal.status = action === 'pause' ? 'paused' : 'active';
    if (action === 'resume') state.goals.resume = { requestId: body.requestId, status: 'accepted', runId: 'fixture-goal-run' };
    return reply(state);
  }
  if (suffix === '/tasks') {
    const prior = state.tasks.items.find(row => row.requestId === body.requestId);
    if (prior) return reply(prior);
    const task = { ...body, id: `task-${state.tasks.items.length + 1}`, status: 'blocked', owner: state.botId };
    state.tasks.items.push(task); return reply(task);
  }
  if (suffix.startsWith('/tasks/')) {
    const [, , id, action, dependency] = suffix.split('/'), task = state.tasks.items.find(row => row.id === id);
    if (!task) return reply({ error: 'Fixture task not found.' });
    if (action === 'dependencies') task.dependencies = body.remove ? task.dependencies.filter(id => id !== dependency) : [...new Set([...task.dependencies, dependency])];
    else if (action === 'actions') task.status = ({ start: 'ready', unblock: 'ready', block: 'blocked', request_review: 'review', request_changes: 'ready' })[body.action] || task.status;
    else if (method !== 'GET') Object.assign(task, body);
    return reply(task);
  }
  if (suffix === '/triggers') {
    const subscription = { ...body, enabled: false, url: `https://hermes.example.test/hooks/${body.id}`, secretSet: true, revision };
    state.triggers.items.push(subscription); return reply({ subscription, secret: 'synthetic-preview-secret-only' });
  }
  if (suffix.startsWith('/triggers/')) {
    const id = suffix.split('/').at(-1), item = state.triggers.items.find(row => row.id === id);
    if (method === 'DELETE') state.triggers.items = state.triggers.items.filter(row => row.id !== id);
    else if (item) Object.assign(item, body);
    return reply({ ok: true });
  }
  if (suffix === '/skills/policy') { state.skills.approvalRequired = body.approvalRequired; return reply({ ok: true }); }
  if (suffix === '/skills/content') return reply({ name: query.get('name'), content: '# Ranch maintenance\n\nRead the latest inspection. Check water and feed. Ask before purchases.', truncated: false });
  if (suffix.startsWith('/skills/pending/')) {
    const id = suffix.split('/').at(-1);
    if (method === 'GET') return reply({ id, diff: '--- SKILL.md\n+++ SKILL.md\n@@ -1 +1,2 @@\n Read the latest inspection.\n+Check water before planning feed.', revision: 'b'.repeat(64), truncated: false });
    state.skills.pending = state.skills.pending.filter(row => row.id !== id); return reply({ ok: true });
  }
  return reply({ ok: true });
}
