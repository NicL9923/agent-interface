#!/usr/bin/env node
// Local visual/interaction fixture. This never contacts Hermes or external services.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { WebSocketServer } from 'ws';
import { createHash, randomUUID } from 'node:crypto';
import { tsImport } from 'tsx/esm/api';
const { routinePresets } = await tsImport('../../src/shared/routine-presets.ts', import.meta.url);
const { replyCardsFromText, validReplyCardState } = await tsImport('../../src/shared/reply-cards.ts', import.meta.url);
const { apiPolicy, contentSecurityPolicy, cspViolations, permissionsPolicy } = await tsImport('../../src/server/security-headers.ts', import.meta.url);
const port = Number(process.env.PREVIEW_PORT || 3000);
const host = process.env.PREVIEW_HOST || '127.0.0.1';
const root = resolve('dist/client');
// LAN previews need request IDs even when HTTPS-only randomUUID is unavailable.
// Microphone and push remain subject to the browser's real secure-context rules.
// Served as a file, not inline, so the app's own Content-Security-Policy applies unchanged.
const fixtureScript = `if (!crypto.randomUUID) crypto.randomUUID = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0,8), hex.slice(8,12), hex.slice(12,16), hex.slice(16,20), hex.slice(20)].join('-');
};
${process.env.PREVIEW_NOTIFICATION_PROMPT === '1' ? 'if(window.Notification)Object.defineProperty(Notification,"permission",{get:()=>"default",configurable:true});' : ''}`;
const fixtureHtml = async () => (await readFile(resolve(root, 'index.html'), 'utf8'))
  .replace('<head>', '<head><script src="/preview-fixture.js"></script>');
const documentHeaders = request => ({ 'Content-Security-Policy': contentSecurityPolicy(`http://${request.headers.host || `${host}:${port}`}`),
  'Permissions-Policy': permissionsPolicy, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
// A fixture key only, never usable for delivery.
const previewPushKey = process.env.PREVIEW_PUSH_CONFIGURED === '1' ? Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url') : undefined;
// PREVIEW_THEME=light|dark|system and PREVIEW_PRESENTATION=simple|advanced pick the initial preferences.
const portrait = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="#d9c7a3"/><circle cx="40" cy="31" r="15" fill="#6b4f3a"/><path d="M12 80c4-20 16-29 28-29s24 9 28 29Z" fill="#3f6b57"/></svg>');
const bots = [
  { id: 'ranch', name: 'Ranch hand', shared: true, model: 'configured-model', provider: 'openrouter', activity: 'working', description: 'Everyday household help', instructions: 'Explicit fixture instructions.', avatar: { mode: 'geometric', shape: 'blob', color: '#1084FE', eyes: 'oval', accessory: 'none' } },
  { id: 'kitchen', name: 'Kitchen companion', shared: true, model: 'configured-model', provider: 'openrouter', activity: 'idle', avatar: { mode: 'mascot', family: 'bear', color: '#FF9800', eyes: 'round', accessory: 'none' } },
  { id: 'garden', name: 'Garden planner', shared: false, model: 'configured-model', provider: 'openrouter', activity: 'thinking', avatar: { mode: 'mascot', family: 'sprout', color: '#00BCA6', eyes: 'oval', accessory: 'hat' } },
  { id: 'homework', name: 'Homework helper', shared: false, model: 'configured-model', provider: 'openrouter', activity: 'waiting', avatar: { mode: 'geometric', shape: 'hex', color: '#9159FE', eyes: 'oval', accessory: 'glasses' } },
  { id: 'ledger', name: 'Ledger', shared: true, model: 'configured-model', provider: 'openrouter', activity: 'blocked', avatar: { mode: 'geometric', shape: 'triangle', color: '#FF309B', eyes: 'visor', accessory: 'none' } },
  { id: 'fox', name: 'Trail scout with a long name for wrapping', shared: false, model: 'configured-model', provider: 'openrouter', activity: 'done', avatar: { mode: 'mascot', family: 'fox', color: '#FF6700', eyes: 'oval', accessory: 'none' } },
  { id: 'guide', name: 'Trail guide', shared: true, model: 'configured-model', provider: 'openrouter', activity: 'failed', avatar: { mode: 'portrait', src: portrait, origin: 'uploaded' } },
];
const savedItems = [];
const preferences = { theme: process.env.PREVIEW_THEME || 'system', presentation: process.env.PREVIEW_PRESENTATION || 'simple', favorites: ['ranch'], sections: [{ id: 'house', name: 'Around the house', botIds: ['ranch', 'kitchen', 'garden'] }], followBots: [], modelFavorites: [] };
const modelCatalog = { provider: 'openrouter', model: 'configured-model', providers: [
  { id: 'openrouter', name: 'OpenRouter', authenticated: true, models: [{ id: 'configured-model', name: 'Configured model', available: true }, { id: 'openai/gpt-6.1-sol', name: 'GPT-6.1 Sol', available: true }, { id: 'anthropic/claude-sonnet', name: 'Claude Sonnet', available: true }] },
  { id: 'openai-codex', name: 'OpenAI subscription', authenticated: true, models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', available: true }] },
  { id: 'xai', name: 'xAI', authenticated: false, warning: 'Connect this provider in Integrations to use its models.', models: [{ id: 'grok-4.6', name: 'Grok 4.6', available: false }] },
] };
const artifactFiles = [
  { id: 'preview-plan', name: 'gate-battery-plan.md', mime: 'text/markdown', url: '/api/files/preview-plan' },
  { id: 'preview-icon', name: 'assistant-icon.png', mime: 'image/png', url: '/api/files/preview-icon' },
  { id: 'preview-shared', name: 'sensor-history.csv', mime: 'text/csv', url: '/api/files/preview-shared' },
  { id: 'preview-unavailable', name: 'archived-notes.txt', mime: 'text/plain', url: '/api/files/preview-unavailable' },
  { id: 'preview-html', name: 'reminder.html', mime: 'text/html', url: '/api/files/preview-html' },
];
const artifactBodies = new Map([
  ['preview-plan', '# Gate battery plan\n\n| Gate | Battery | Reminder |\n| --- | --- | --- |\n| North | Replaced today | Nov 1 |\n| East | 62% | Nov 1 |\n| Barn | 48% | Nov 1 |\n\nExplicit preview fixture. No reminders were created.\n'],
  ['preview-shared', 'gate,battery_percent,signal_dbm\nnorth,14,-71\neast,62,-64\nbarn,48,-69\n'],
  ['preview-html', '<!doctype html><html><body><h1>Gate reminders</h1><p>Explicit preview fixture.</p></body></html>'],
]);
const at = (minutes) => new Date(Date.UTC(2026, 9, 1, 16, minutes)).toISOString();
const ranchMessages = [
  { id: 'm1', role: 'user', sender: { id: 'preview', name: 'Nicolas' }, text: 'The north gate sensor keeps saying it is open. Can you check its history and tell me if it is the battery?', createdAt: at(2) },
  { id: 'm2', role: 'assistant', text: 'I looked at the last **48 hours** of events for `binary_sensor.north_gate`.\n\n- 31 open/close pairs, all under 4 seconds\n- Battery reported **14%** this morning\n- Signal strength is steady at -71 dBm\n\nShort, frequent flaps with a low battery usually mean the contact is browning out. I would swap the CR2032 first.', createdAt: at(4) },
  { id: 'm3', role: 'tool', toolName: 'home_assistant.history', text: '{"entity":"binary_sensor.north_gate","events":62}', createdAt: at(4), toolCall: { id: 'call_7f2', name: 'home_assistant.history', status: 'completed', arguments: '{"entity_id":"binary_sensor.north_gate","hours":48}', result: '62 state changes; battery 14%', startedAt: at(3), completedAt: at(4) } },
  { id: 'm4', role: 'user', sender: { id: 'two', name: 'Jordan' }, text: 'I replaced it. Can you add a reminder to check the other gate batteries next month?', createdAt: at(21) },
  { id: 'm5', role: 'assistant', text: 'Here is what I will set up:\n\n| Gate | Last battery | Reminder |\n| --- | --- | --- |\n| North | Replaced today | Nov 1 |\n| East | 62% | Nov 1 |\n| Barn | 48% | Nov 1 |\n\nCreating the reminder now. I need your approval because it notifies both of you.', createdAt: at(22) },
];
const conversations = {
  ranch: { messages: ranchMessages, activity: { state: 'working', detail: 'Creating a shared reminder in Google Calendar', runId: 'run_preview_42', updatedAt: at(22) }, toolCalls: [{ id: 'call_8a1', name: 'calendar.create_event', status: 'running', arguments: '{"title":"Check gate batteries","date":"2026-11-01"}', startedAt: at(22) }], approvals: [{ id: 'approve-reminder', title: 'Add a shared reminder for both of you?', detail: 'Ranch hand wants to create “Check gate batteries” on November 1 and notify Nicolas and Jordan.', status: 'pending', expiresAt: '2026-10-02T16:00:00Z' }] },
  ledger: { messages: [{ id: 'l1', role: 'assistant', text: 'September is reconciled except for one charge I cannot match.', createdAt: at(10) }], activity: { state: 'blocked', detail: 'Waiting for you to identify a $48.20 charge from “TX FEED CO”.' }, attention: [{ id: 'ask', kind: 'clarify', title: 'Which category is the TX FEED CO charge?', detail: 'It does not match a receipt in the shared folder.', questions: [{ id: 'category', prompt: 'Category', options: ['Livestock feed', 'Garden supplies', 'Something else'] }] }] },
  guide: { messages: [{ id: 'g1', role: 'assistant', text: 'I could not reach the trail conditions service. Your request is saved.', createdAt: at(12) }], activity: { state: 'failed', detail: 'The trail conditions service did not respond.' } },
};
conversations.ranch.files = artifactFiles;
ranchMessages[0].files = [artifactFiles[2]];
ranchMessages.at(-1).files = [artifactFiles[0], artifactFiles[1], artifactFiles[3], artifactFiles[4]];
const fixtureCards = { version: 1, cards: [
  { id: 'meal-list', type: 'checklist', title: 'Three easy dinners: fixture grocery list', items: [
    { id: 'beans', text: 'Black beans, 2 cans' }, { id: 'tortillas', text: 'Corn tortillas, 1 pack' },
    { id: 'tomatoes', text: 'Tomatoes, 4' }, { id: 'rice', text: 'Brown rice, 1 bag' },
  ] },
  { id: 'hill-country', type: 'itinerary', title: 'A Hill Country Saturday: fixture proposal', items: [
    { id: 'leave', time: 'Saturday, 9 AM', title: 'Leave after breakfast', detail: 'Bring water and a picnic. Add your own timing notes below.' },
    { id: 'walk', time: 'Saturday, 11 AM', title: 'A short nature walk', detail: 'Check the weather and trail conditions before leaving.' },
  ] },
  { id: 'gate-check', type: 'event', title: 'Check gate batteries: fixture calendar proposal', start: '2026-11-01T09:00:00-06:00', end: '2026-11-01T09:30:00-06:00', location: 'Home', description: 'Explicit preview fixture. No calendar event was created.' },
] };
ranchMessages.push({ id: 'fixture-cards', role: 'assistant', createdAt: at(23), text: 'These are explicit preview fixtures for groceries, trip notes and a calendar proposal. No purchases, bookings or calendar events were created.\n\n```agent-ui\n' + JSON.stringify(fixtureCards) + '\n```' });
ranchMessages.push({ id: 'fixture-agent-message', role: 'user', text: 'Message from 🤖 Ledger (@ledger): The gate battery purchase is accounted for. You can go ahead with the replacement.', createdAt: at(24) });
ranchMessages.push({ id: 'fixture-agent-handoff', role: 'tool', text: 'Planner will review the weekend schedule.', toolCall: { id: 'handoff', name: 'message_agent', arguments: JSON.stringify({ target: 'planner', message: 'Check the weekend plans against the weather.' }), status: 'completed', result: 'Planner will review the weekend schedule.' }, createdAt: at(25) });
const previewRoom = { room_id: 'fixture-group', name: 'Weekend at the ranch', members: ['ranch', 'planner'].map(id => ({ member_id: id, profile: id, handle: id, display_name: bots.find(bot => bot.id === id)?.name || id })) };
const groupRooms = [previewRoom];
const groupEvents = [{ event_id: 'group-user', seq: 1, kind: 'message.user', actor: { kind: 'user', id: 'desktop' }, payload: { text: 'Can we fit a short nature walk around the gate repair? Explicit preview fixture.', thread_id: 'a624af77-b3de-46f9-a583-626018476e41' }, created_at: Date.now() / 1000 }, { event_id: 'group-reply', seq: 2, kind: 'message.member', actor: { kind: 'member', id: 'ranch' }, payload: { member_id: 'ranch', text: 'Replace the battery before breakfast, then take the shady trail. Bring water and check the weather before leaving.', thread_id: 'a624af77-b3de-46f9-a583-626018476e41' }, created_at: Date.now() / 1000 }];
const groupRequests = new Set();
const conversationFor = (id) => ({ botId: id, messages: [], approvals: [], files: [], activity: { state: bots.find(item => item.id === id)?.activity || 'idle' }, ...conversations[id] });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const vaults = new Map();
const vaultFor = botId => {
  if (!vaults.has(botId)) vaults.set(botId, { botId, profile: botId, scope: 'profile', owner: 'Hermes',
    notice: 'Explicit preview fixture. Native profiles define access; this preview never stores real credentials or contacts Hermes.',
    items: [{ id: 'fixture-login', kind: 'login', label: 'Ranch supply account', origin: 'https://supply.example.invalid', createdAt: at(1), identifier: 'ranch@example.invalid', identifierType: 'email', hasOtp: false, backend: 'local', canRemove: true }],
    sources: [
      { name: 'local', displayName: 'Hermes encrypted vault', enabled: true, needsUnlock: false, unlocked: true, installed: true, canToggle: false, canUnlock: false, canLock: false },
      { name: 'onepassword', displayName: '1Password', enabled: true, needsUnlock: true, unlocked: false, installed: true, canToggle: true, canUnlock: true, canLock: false },
      { name: 'bitwarden', displayName: 'Bitwarden', enabled: false, needsUnlock: true, unlocked: false, installed: false, canToggle: false, canUnlock: false, canLock: false },
    ] });
  return vaults.get(botId);
};
if (process.env.PREVIEW_SECURE_REQUEST) {
  const method = { login: 'vault.save_login', code: 'vault.code', unlock: 'vault.unlock_prompt', secret: 'secret' }[process.env.PREVIEW_SECURE_REQUEST] || 'vault.save_login';
  const metadata = method === 'vault.save_login' ? { origin: 'https://accounts.example.invalid', site: 'accounts.example.invalid' }
    : method === 'vault.code' ? { site: 'accounts.example.invalid', hint: 'Explicit authenticator fixture' }
    : method === 'vault.unlock_prompt' ? { backend: 'onepassword', displayName: '1Password' }
    : { envVar: 'EXAMPLE_API_KEY', prompt: 'Enter a synthetic API key for this fixture.' };
  conversations.ranch.activity = { state: 'blocked', detail: 'Waiting for secure native input. Explicit preview fixture.' };
  conversations.ranch.approvals = [];
  conversations.ranch.attention = [{ id: 'fixture-secure-request', kind: 'secure', title: method === 'vault.save_login' ? 'Save a login for accounts.example.invalid' : 'Hermes needs secure input',
    detail: 'Explicit preview fixture. Use made-up credentials; no website login or native vault change occurs.',
    secure: { epoch: 'fixture-epoch', sessionId: 'fixture-session', method, ...metadata } }];
}
const memories = new Map();
const memoryFor = botId => {
  if (!memories.has(botId)) memories.set(botId, { botId, profile: botId, scope: 'profile', owner: 'Hermes',
    notice: 'Explicit preview fixture. Profiles separate preferences, not household access. These edits never contact Hermes.',
    documents: [
      { target: 'memory', label: 'Assistant memory', enabled: true, charLimit: 2200, entries: [{ id: digest('quick dinners'), text: 'We prefer quick weeknight dinners.' }] },
      { target: 'user', label: 'About the household', enabled: true, charLimit: 1375, entries: [{ id: digest('nature'), text: 'Our family enjoys nature walks and a relaxed pace.' }] },
    ].map(document => ({ ...document, revision: digest(document.entries), charCount: document.entries.reduce((sum, entry) => sum + entry.text.length, 0) })) });
  return memories.get(botId);
};
const cardStates = new Map(), todaySeen = new Map(), routineReceipts = new Map(), fixtureAudio = new Map();
const routines = [{ id: 'r1', botId: 'ranch', name: 'Morning check', prompt: 'Summarize overnight sensor alerts and the weather.', schedule: '0 6 * * *', enabled: true, recipientIds: ['preview'] }];
const fixtureEvents = [{ id: 'fixture-completed', botId: 'fox', kind: 'completed', title: 'Trail options are ready', body: 'Explicit fixture. Open the conversation to review the proposal.', occurredAt: new Date(Date.now() - 10 * 60000).toISOString() }];
// Tiny WAV tone, never provider-generated speech. Used only to verify audio controls.
const fixtureWav = (() => {
  const rate = 8000, samples = rate, wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * index / rate) * 2000), 44 + index * 2);
  return wav;
})();
const schedulePreview = (botId, schedule) => {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/.exec(schedule);
  if (!match || Number(match[1]) > 59 || Number(match[2]) > 23) return null;
  const runs = [], candidate = new Date(); candidate.setUTCHours(Number(match[2]) + 5, Number(match[1]), 0, 0);
  // Stable preview uses UTC-05 fixture time. Native schedule parsing is tested separately.
  for (let day = 0; day < 25 && runs.length < 3; day++, candidate.setUTCDate(candidate.getUTCDate() + 1)) {
    const localDay = new Date(candidate.getTime() - 5 * 3600000).getUTCDay();
    if (candidate > new Date() && (match[3] === '*' || localDay === Number(match[3]))) runs.push(candidate.toISOString());
  }
  return { botId, schedule, timezone: 'America/Chicago', nextRuns: runs, kind: 'cron' };
};
const connections = [
  ['workspace', 'Google Workspace', 'productivity', 'connected', 'nic@example.invalid', 'Gmail, Drive, Calendar and Sheets access checked.'],
  ['github', 'GitHub', 'development', 'expired', 'ranch-team', 'Your sign-in expired. Reconnect to access repositories.'],
  ['files', 'Selected files', 'files', 'configured', undefined, 'Choose files in a conversation to share them with this assistant.'],
  ['synology', 'Synology NAS', 'files', 'missing_permission', 'family-library', 'The NAS is reachable. File Station access needs permission.'],
  ['discord', 'Discord', 'messaging', 'connected', 'Household bot', 'The bot identity and gateway connection were checked.'],
  ['supabase', 'Supabase', 'development', 'configured', undefined, 'Credentials are configured. Run a check to verify access.'],
  ['cloudflare', 'Cloudflare', 'development', 'unavailable', undefined, 'Cloudflare did not respond. Check again when the service is available.'],
  ['vps', 'VPS', 'development', 'connected', 'Hermes host', 'The configured server is reachable.'],
  ['homeassistant', 'Home Assistant', 'home', 'not_connected', undefined, 'Connect your Home Assistant server to use home tools.'],
  ['apple', 'Apple Calendar & Reminders', 'devices', 'unsupported', undefined, 'Open Integrations in the iPhone app to choose and share data from this device.'],
  ['openrouter', 'Model provider', 'providers', 'configured', undefined, 'Provider credentials are present. Model execution has not been checked.'],
  ['search', 'Web search', 'providers', 'not_connected', undefined, 'Configure a search provider for current information.'],
  ['images', 'Image generation', 'providers', 'configured', undefined, 'An image provider is configured. Generation has not been checked.'],
].map(([id, name, category, status, account, detail]) => ({ id, name, category, status, account, detail, owner: category === 'devices' ? 'This iPhone' : 'Hermes', profile: 'ranch', botIds: ['ranch'], setup: id === 'homeassistant' ? [{ key: 'url', label: 'Server address', kind: 'url', required: true }, { key: 'token', label: 'Access token', kind: 'secret', required: true }] : [], permissions: id === 'workspace' ? [{ id: 'drive', name: 'Drive files', granted: true }, { id: 'gmail', name: 'Gmail', granted: true }] : [], capabilities: [], checkedAt: ['connected', 'expired', 'unavailable', 'missing_permission'].includes(status) ? '2026-10-01T17:00:00Z' : undefined, actions: { connect: !['files', 'apple', 'vps'].includes(id), check: !['files', 'apple'].includes(id), disconnect: status === 'connected' } }));
let upgrade = { available: true, phase: 'failed', current: { revision: 'oldrevision', version: '2026.9' }, candidate: { revision: 'newrevision', version: '2026.10' }, message: 'The update could not restart Hermes. Your conversations are saved. Restart Hermes to check and restore the connection.', operationId: 'fixture-operation', checks: [{ id: 'restart', label: 'Restart and verify Hermes', status: 'failed', detail: 'Explicit preview fixture. No real Hermes upgrade was attempted.' }], canCheck: false, canInstall: false, canRetry: true, canCancel: true, canRestartService: true, busyBots: [], checkedAt: '2026-10-01T17:00:00Z' };
const flows = new Map();
const pushRegistrations = new Set();
// Computer fixture streams are simulations. They never open a shell or contact a desktop.
let computerControl = { kind: 'idle' };
// PREVIEW_TERMINAL=confirm asks for a fresh sign-in first; PREVIEW_TERMINAL=restricted shows a non-administrator.
let terminalConfirmed = process.env.PREVIEW_TERMINAL !== 'confirm';
const computerStatus = () => ({ available: true, running: true, browserReady: true, label: 'Preview computer', control: computerControl,
  terminal: process.env.PREVIEW_TERMINAL === 'restricted'
    ? { available: false, target: '', reason: 'The system terminal is limited to household administrators.' }
    : { available: true, target: 'preview@fixture', ...(terminalConfirmed ? {} : { confirmationRequired: true }) } });
let computerTicket = 0;
const computerTickets = new Map();
// PREVIEW_SIGNED_OUT=1 starts at the sign-in page; local sign-in then opens the fixture household.
let signedIn = process.env.PREVIEW_SIGNED_OUT !== '1';
const json = (response, data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Security-Policy': apiPolicy }); response.end(JSON.stringify(data)); };
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  let body = {}; if (request.method !== 'GET') { const chunks = []; for await (const chunk of request) chunks.push(chunk); try { body = JSON.parse(Buffer.concat(chunks)); } catch {} }
  if (url.pathname === '/preview-fixture.js') { response.writeHead(200, { ...documentHeaders(request), 'Content-Type': 'text/javascript' }); return response.end(fixtureScript); }
  if (url.pathname.startsWith('/api/')) {
    const path = url.pathname.slice(4);
    if (path === '/csp-report') {
      for (const violation of cspViolations(body)) process.stderr.write(`CSP violation: ${JSON.stringify(violation)}\n`);
      response.writeHead(204); return response.end();
    }
    // PREVIEW_GOOGLE_CLIENT_ID loads Google's real sign-in button; the fixture never verifies its tokens.
    if (path === '/auth/config') return json(response, { localDevAuth: true, nativeAuthVersion: 1, googleClientId: process.env.PREVIEW_GOOGLE_CLIENT_ID || undefined });
    if (path === '/auth/confirm') { terminalConfirmed = true; return json(response, { confirmedAt: new Date().toISOString() }); }
    if (path === '/auth/local') { signedIn = true; return json(response, { ok: true }); }
    if (path === '/bootstrap' && !signedIn) return json(response, { error: 'Sign in to continue.' }, 401);
    if (path === '/search') return json(response,{hits:[{botId:'ranch',botName:'Ranch',sessionId:'fixture-history',title:'Gate battery plan',snippet:'Replace the north gate battery and check the others next month.'}],unavailableBots:[]});
    if (/\/history\//.test(path)) return json(response,{botId:'ranch',sessionId:'fixture-history',messages:ranchMessages,offset:0,hasMore:false});
    if (path === '/saved') { if(request.method==='POST'){const item={...body,id:randomUUID(),createdAt:new Date().toISOString()};savedItems.push(item);return json(response,item);}return json(response,savedItems); }
    if(path.startsWith('/saved/')) { const index=savedItems.findIndex(item=>item.id===path.split('/').at(-1));if(index>=0)savedItems.splice(index,1);return json(response,{ok:true}); }
    if(path.endsWith('/starters')) return json(response,[{id:'meals',title:'Plan dinners',prompt:'Help me plan five easy dinners. Ask about our preferences and budget first.'},{id:'document',title:'Explain a document',prompt:'Help me understand the document I attach. Summarize the key points.'},{id:'server',title:'Check a server',prompt:'Review my server health. Confirm the server and connection first; inspect only.'}]);
    if(path==='/automations') return json(response,{routines:routines.map(row=>({...row,nextRunAt:new Date(Date.now()+3600000).toISOString(),lastStatus:'delivery_failed',lastDeliveryError:'Fixture: recipient destination unavailable'})),usage:bots.map(bot=>({botId:bot.id,days:30,sessions:4,inputTokens:1200,outputTokens:400,actualCost:null,estimatedCost:0.02,partial:true})),unavailableBots:[]});
    if (path === '/bootstrap') return json(response, { user: { id: 'preview', name: 'Nicolas', email: 'preview@localhost.invalid' }, household: [{ id: 'preview', name: 'Nicolas' }, { id: 'two', name: 'Jordan' }], bots, preferences, vapidPublicKey: previewPushKey, connection: { connected: process.env.PREVIEW_DISCONNECTED !== '1', version: 'Preview fixture' }, csrfToken: 'fixture-only', capabilities: Object.fromEntries(['chat', 'steering', 'approvals', 'uploads', 'generatedFiles', 'botConfiguration', 'tools', 'skills', 'routines', 'stop', 'avatarMetadata', 'durableEvents', 'idempotency', 'imageGeneration', 'portraitGeneration'].map(key => [key, { supported: true }])) });
    const fixtureUser = request.headers['x-preview-user'] || 'preview';
    const experiencePath = path === '/today' || path === '/today/seen' || /\/memory(?:\/|$)|\/vault(?:\/|$)|\/secure-requests\/|\/voice\/|\/cards\/|^\/routines\//.test(path);
    if (experiencePath && !signedIn) return json(response, { error: 'Sign in to use the preview fixture.' }, 401);
    if (path === '/today/seen') { todaySeen.set(fixtureUser, { seenAt: body.seenAt, frontier: Number(body.frontier) }); return json(response, { ok: true }); }
    if (path === '/today') {
      const marker = todaySeen.get(fixtureUser);
      const since = marker?.seenAt || new Date(Date.now() - 86400000).toISOString();
      return json(response, { generatedAt: new Date().toISOString(), since, frontier: String(fixtureEvents.length), hasMore: false, upcoming:routines.map(row=>({...row,nextRunAt:new Date(Date.now()+3600000).toISOString()})), unavailableBots: [], events: fixtureEvents.filter((_, index) => index + 1 > (marker?.frontier || 0)),
        items: bots.map(bot => { const conversation = conversationFor(bot.id); return { botId: bot.id, botName: bot.name, activity: conversation.activity,
          approvals: conversation.approvals || [], attention: conversation.attention || [], files: conversation.files || [], latestMessage: conversation.messages.findLast(message => message.role === 'assistant') }; }) });
    }
    const vaultMatch = /^\/bots\/([^/]+)\/vault(?:\/(logins|sources)(?:\/([^/]+)(?:\/(unlock|lock))?)?)?$/.exec(path);
    if (vaultMatch) {
      const [, encoded, group, itemId, operation] = vaultMatch, vault = vaultFor(decodeURIComponent(encoded));
      if (request.method === 'GET') return json(response, vault);
      if (group === 'logins' && request.method === 'POST') {
        if (!body.password || !body.identifier || !body.origin) return json(response, { error: 'Enter synthetic login details.' }, 400);
        const id = 'fixture-' + randomUUID();
        vault.items.push({ id, kind: 'login', label: body.label, origin: body.origin, identifier: body.identifier, identifierType: body.identifierType, createdAt: new Date().toISOString(), hasOtp: false, backend: 'local', canRemove: true });
        return json(response, { id });
      }
      if (group === 'logins' && request.method === 'DELETE') { vault.items = vault.items.filter(item => item.id !== itemId); return json(response, { removed: true }); }
      const source = vault.sources.find(source => source.name === itemId);
      if (!source || !source.installed) return json(response, { error: 'Fixture source unavailable.' }, 409);
      if (operation) { source.unlocked = operation === 'unlock'; source.canLock = source.unlocked; source.canUnlock = !source.unlocked && source.enabled; }
      else { source.enabled = body.enabled === true; source.canUnlock = source.enabled && !source.unlocked; }
      return json(response, { ok: true });
    }
    const secureMatch = /^\/bots\/([^/]+)\/secure-requests\/([^/]+)$/.exec(path);
    if (secureMatch) {
      const botId = decodeURIComponent(secureMatch[1]), conversation = conversations[botId], pending = conversation?.attention?.find(item => item.id === secureMatch[2]);
      if (!pending || body.epoch !== pending.secure.epoch || body.sessionId !== pending.secure.sessionId || body.method !== pending.secure.method) return json(response, { error: 'The fixture request expired.' }, 409);
      if (process.env.PREVIEW_SECURE_FAILURE === '1') return json(response, { error: 'Fixture result uncertain.' }, 502);
      if (!body.cancel && pending.secure.method === 'vault.save_login') vaultFor(botId).items.push({ id: 'fixture-' + randomUUID(), kind: 'login', label: pending.secure.site, origin: pending.secure.origin, identifier: body.identifier, identifierType: 'username', createdAt: new Date().toISOString(), hasOtp: false, backend: 'local', canRemove: true });
      conversation.attention = []; conversation.activity = { state: 'idle' };
      return json(response, { status: 'ok' });
    }
    const memoryMatch = /^\/bots\/([^/]+)\/memory(?:\/(memory|user))?$/.exec(path);
    if (memoryMatch) {
      const memory = memoryFor(decodeURIComponent(memoryMatch[1]));
      if (request.method === 'GET') return json(response, memory);
      const document = memory.documents.find(document => document.target === memoryMatch[2]);
      if (!document) return json(response, { error: 'Fixture memory document not found.' }, 404);
      if (document.revision !== body.revision) return json(response, { error: 'This profile memory changed. Reload the newer memory before saving.' }, 409);
      const entries = request.method === 'DELETE' ? document.entries.filter(entry => entry.id !== body.entryId) : body.entries;
      if (!Array.isArray(entries) || entries.some(entry => typeof entry.text !== 'string' || !entry.text.trim())) return json(response, { error: 'Enter a memory before saving.' }, 400);
      document.entries = entries.map(entry => ({ id: entry.id || digest(entry.text), text: entry.text.trim() }));
      document.charCount = document.entries.reduce((sum, entry) => sum + entry.text.length, 0);
      document.revision = digest(document.entries); return json(response, memory);
    }
    const cardMatch = /^\/bots\/([^/]+)\/messages\/([^/]+)\/cards\/([^/]+)\/state$/.exec(path);
    if (cardMatch) {
      const [, botId, messageId, cardId] = cardMatch;
      const message = conversationFor(botId).messages.find(message => message.id === messageId && message.role === 'assistant');
      const card = message && replyCardsFromText(message.text).find(card => card.id === cardId);
      if (!card) return json(response, { error: 'This fixture card is no longer available.' }, 404);
      const key = JSON.stringify([fixtureUser, botId, messageId, cardId]);
      if (request.method === 'PUT') { if (!validReplyCardState(card, body)) return json(response, { error: 'Choices do not belong to this fixture card.' }, 400); cardStates.set(key, body); }
      return json(response, cardStates.get(key) || { checkedIds: [], notes: {} });
    }
    if (path.endsWith('/voice/transcribe')) return json(response, { text: 'Explicit voice preview fixture: pick up milk and tortillas. Review this draft before sending.', provider: 'preview-fixture' });
    if (path.endsWith('/voice/speak')) {
      const key = randomUUID(); fixtureAudio.set(key, fixtureUser);
      return json(response, { url: `/api/voice/audio/${key}`, mime: 'audio/wav', expiresAt: new Date(Date.now() + 300000).toISOString() });
    }
    if (path.startsWith('/voice/audio/')) {
      const key = path.split('/').at(-1);
      if (fixtureAudio.get(key) !== fixtureUser) return json(response, { error: 'Fixture audio expired.' }, 404);
      fixtureAudio.delete(key); response.writeHead(200, { 'Content-Type': 'audio/wav', 'X-Content-Type-Options': 'nosniff' }); return response.end(fixtureWav);
    }
    if (path === '/routines/templates') return json(response, routinePresets);
    if (path === '/routines/preview') { const preview = schedulePreview(body.botId, body.schedule); return json(response, preview || { error: 'Fixture preview supports daily and weekly schedules. Native parsing is verified separately.' }, preview ? 200 : 400); }
    const runMatch = /^\/routines\/([^/]+)\/run(?:s\/([^/]+))?$/.exec(path);
    if (runMatch) {
      const routine = routines.find(routine => routine.id === runMatch[1]);
      if (!routine) return json(response, { error: 'Fixture routine not found.' }, 404);
      const requestId = runMatch[2] || body.requestId, key = JSON.stringify([fixtureUser, routine.id, requestId]);
      if (request.method === 'POST' && !routineReceipts.has(key)) routineReceipts.set(key, { requestId, routineId: routine.id, botId: routine.botId, status: 'completed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), message: 'Explicit fixture. No routine or external action was executed.' });
      return json(response, routineReceipts.get(key) || { error: 'Fixture run receipt not found.' }, routineReceipts.has(key) ? 200 : 404);
    }
    const resultsMatch = /^\/bots\/([^/]+)\/routines\/([^/]+)\/results(?:\/([^/]+))?$/.exec(path);
    if (resultsMatch) return json(response, resultsMatch[3] ? { previewOnly: false, messages: [{ id: 'fixture-run-output', role: 'assistant', text: '## Morning gate check\n\nThe north gate battery needs replacing. The east gate is at **62%** and the barn gate is at **48%**.\n\nExplicit fixture output. No routine was executed.' }] } : [{ id: 'fixture-run', title: 'Morning gate check', startedAt: new Date().toISOString(), previewOnly: false }]);
    if (path === '/groups') {
      if (request.method === 'POST') { let room = groupRooms.find(room => room.room_id === body.requestId); if (!room) { room = { room_id: body.requestId, name: body.name, members: body.botIds.map(id => ({ member_id: id, profile: id, handle: id, display_name: bots.find(bot => bot.id === id)?.name || id })) }; groupRooms.push(room); } return json(response, { room }); }
      return json(response, { supported: true, canSend: process.env.PREVIEW_GROUP_DRIVER_OFF !== '1', rooms: groupRooms, ...(process.env.PREVIEW_GROUP_DRIVER_OFF === '1' ? { reason: 'Fixture group coordinator is unavailable. History is still readable.' } : {}) });
    }
    const groupMatch = /^\/groups\/([^/]+)(?:\/(log|messages|stop|approve))?$/.exec(path);
    if (groupMatch) {
      const room = groupRooms.find(room => room.room_id === groupMatch[1]); if (!room) return json(response, { error: 'Fixture room not found.' }, 404);
      if (groupMatch[2] === 'messages') { if (!groupRequests.has(body.requestId)) { groupRequests.add(body.requestId); groupEvents.push({ event_id: body.requestId, seq: groupEvents.length + 1, kind: 'message.user', actor: { kind: 'user', id: 'desktop' }, payload: { text: body.text, thread_id: body.threadId }, created_at: Date.now() / 1000 }); } return json(response, { accepted: true }); }
      if (groupMatch[2] === 'log') return json(response, { events: groupEvents.filter(event => event.seq > Number(url.searchParams.get('since') || 0)), cursor: groupEvents.length, latest_seq: groupEvents.length, has_more: false });
      if (groupMatch[2]) return json(response, { cancelled: 0, approved: true });
      return json(response, { room, driver_status: { running: true, working: false, blocked: false, pending_actions: [] } });
    }
    const botMatch = /^\/bots\/([^/]+)$/.exec(path);
    if (botMatch && request.method === 'PATCH') {
      // Fixture-only: records the chosen model in memory without contacting Hermes.
      const bot = bots.find(bot => bot.id === botMatch[1]);
      if (!bot) return json(response, { error: 'Fixture assistant not found.' }, 404);
      Object.assign(bot, { model: body.model, provider: body.provider });
      return json(response, bot);
    }
    if (path === '/models') return json(response, modelCatalog);
    if (path === '/computer') return json(response, computerStatus());
    if (path === '/computer/control') { computerControl = body.action === 'take' ? { kind: 'human', mine: true, name: 'Nicolas' } : { kind: 'idle' }; return json(response, computerStatus()); }
    if (path === '/computer/terminal/end') { for (const client of computerSockets.clients) if (client.computerKind === 'terminal') { client.send(JSON.stringify({ type: 'exit' })); client.close(); } return json(response, { ok: true }); }
    if (path === '/computer/desktop' || path === '/computer/terminal') {
      const kind = path.split('/').at(-1), ticket = `fixture-${++computerTicket}`;
      computerTickets.set(ticket, kind);
      return json(response, { path: `/api/computer/${kind}/ws?ticket=${ticket}`, viewerId: 'fixture-viewer', sessionId: 'fixture-shell', expiresAt: new Date(Date.now() + 30000).toISOString(), target: 'preview@fixture' });
    }
    if (path === '/push/subscriptions/status') return json(response, { registered: pushRegistrations.has(body.endpoint) });
    if (path === '/push/subscriptions') { if (request.method === 'DELETE') pushRegistrations.delete(body.endpoint); else pushRegistrations.add(body.endpoint); return json(response, { ok: true }); }
    if (path.startsWith('/files/')) {
      const file = artifactFiles.find(item => item.id === decodeURIComponent(path.slice('/files/'.length)));
      if (!file || file.id === 'preview-unavailable') return json(response, { error: 'This archived file is unavailable in the preview fixture.' }, 404);
      const content = file.id === 'preview-icon' ? await readFile(resolve(root, 'icon-192.png')) : Buffer.from(artifactBodies.get(file.id));
      response.writeHead(200, { 'Content-Type': file.mime, 'Content-Disposition': `attachment; filename="${file.name}"`, 'X-Content-Type-Options': 'nosniff' });
      return response.end(content);
    }
    if (path === '/preferences/models') { preferences.modelFavorites = body.modelFavorites || []; return json(response, { modelFavorites: preferences.modelFavorites }); }
    if (path === '/integrations') return json(response, { profile: 'ranch', canManage: true, connections });
    if (path.includes('/integrations/flows/')) { const flow = flows.get(path.split('/')[3]); if (request.method === 'DELETE') flow.status = 'cancelled'; return json(response, flow || { status: 'expired', kind: 'instructions', message: 'Sign-in expired.' }); }
    if (path === '/integrations/mcp') { const item = { ...connections[0], id: body.name, name: body.name, category: 'custom', account: undefined, status: 'configured', detail: 'Custom server saved. Check the connection to verify it.', permissions: [], setup: [] }; connections.push(item); return json(response, item); }
    if (path.startsWith('/integrations/')) { const item = connections.find(item => item.id === path.split('/')[2]); if (path.endsWith('/connect')) { const flow = { flowId: `preview-${item.id}`, status: 'pending', kind: 'device_code', userCode: 'RANCH-42', message: 'Fixture sign-in pending. This preview does not contact account providers.' }; flows.set(flow.flowId, flow); return json(response, flow); } item.status = path.endsWith('/disconnect') ? 'not_connected' : 'connected'; item.detail = path.endsWith('/disconnect') ? 'Connection removed.' : 'Connection checked in the preview fixture.'; item.checkedAt = new Date().toISOString(); return json(response, item); }
    if (path === '/hermes/upgrade/control') { upgrade = { ...upgrade, phase: 'recovering', message: 'Waiting for a safe stopping point, then checking the connection.', canRetry: false, canCancel: false, canRestartService: false }; return json(response, upgrade); }
    if (path === '/hermes/upgrade') return json(response, upgrade);
    if (path.endsWith('/conversation')) return json(response, conversationFor(decodeURIComponent(path.split('/')[2])));
    if (path.endsWith('/tools') || path.endsWith('/skills')) return json(response, [{ id: 'web', name: 'Web search', description: 'Search the web when current information matters.', enabled: true }, { id: 'shell', name: 'Terminal', description: "Run commands on the assistant's server.", enabled: false }]);
    if (/^\/routines\/[^/]+\/state$/.test(path)) { const row=routines.find(row=>row.id===path.split('/')[2]);if(row)row.enabled=body.enabled;return json(response,{ok:true}); }
    if (path === '/routines') { if (request.method === 'POST') { const routine = { ...body, id: `fixture-routine-${routines.length + 1}` }; routines.push(routine); return json(response, routine); } return json(response, routines); }
    if (/^\/routines\/[^/]+$/.test(path)) { const id = path.split('/').at(-1), index = routines.findIndex(routine => routine.id === id); if (index < 0) return json(response, { error: 'Fixture routine not found.' }, 404); if (request.method === 'DELETE') { routines.splice(index, 1); return json(response, { ok: true }); } Object.assign(routines[index], body); return json(response, routines[index]); }
    if (path.endsWith('/draft')) return json(response, {text:'',attachments:[]});
    if (path === '/preferences') { Object.assign(preferences, body); return json(response, preferences); }
    return json(response, {});
  }
  try { const file = resolve(root, '.' + url.pathname); if (!file.startsWith(root + '/') && file !== root) throw Error(); const content = url.pathname === '/' ? await fixtureHtml() : await readFile(file); response.writeHead(200, { ...documentHeaders(request), 'Content-Type': ({ '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.html': 'text/html' })[extname(file)] || 'text/html' }); response.end(content); }
  catch { try { const fallback = await fixtureHtml(); response.writeHead(200, { ...documentHeaders(request), 'Content-Type': 'text/html' }); response.end(fallback); } catch { response.writeHead(404); response.end('Run npm run build first.'); } }
}).listen(port, host, () => process.stdout.write(`Fixture-only preview: http://${host}:${port}\n`));

const computerSockets = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${host}:${port}`);
  const ticket = url.searchParams.get('ticket'), kind = computerTickets.get(ticket);
  computerTickets.delete(ticket);
  if (!kind || url.pathname !== `/api/computer/${kind}/ws`) return socket.destroy();
  computerSockets.handleUpgrade(request, socket, head, client => {
    client.computerKind = kind;
    if (kind === 'desktop') return fixtureDesktop(client);
    const output = data => client.send(JSON.stringify({ type: 'output', data }));
    output('\x1b[32mAgent Interface terminal preview\x1b[0m\r\nExplicit fixture. Commands are echoed, never executed.\r\n\r\npreview@fixture:~$ ');
    let line = '';
    client.on('message', bytes => {
      let message; try { message = JSON.parse(String(bytes)); } catch { return; }
      if (message.type !== 'input' || typeof message.data !== 'string') return;
      for (const character of message.data) {
        if (character === '\x03') { line = ''; output('^C\r\npreview@fixture:~$ '); }
        else if (character === '\r' || character === '\n') { output(`\r\nFixture received: ${line || '(empty line)'}\r\npreview@fixture:~$ `); line = ''; }
        else if (character === '\x7f') { if (line) { line = line.slice(0, -1); output('\b \b'); } }
        else { line += character; output(character); }
      }
    });
  });
});

// Minimal RFB server with one static desktop frame for visual and takeover checks.
function fixtureDesktop(client) {
  const width = 1024, height = 640;
  const pixels = Buffer.alloc(width * height * 4);
  const rectangle = (left, top, w, h, [r, g, b]) => {
    for (let y = top; y < top + h; y++) for (let x = left; x < left + w; x++) {
      const offset = (y * width + x) * 4; pixels[offset] = b; pixels[offset + 1] = g; pixels[offset + 2] = r;
    }
  };
  rectangle(0, 0, width, height, [36, 70, 55]);
  rectangle(0, 0, width, 30, [21, 28, 24]);
  rectangle(70, 80, 884, 470, [248, 247, 239]);
  rectangle(70, 80, 884, 36, [220, 229, 219]);
  rectangle(70, 116, 884, 44, [236, 238, 230]);
  rectangle(186, 125, 656, 25, [255, 253, 247]);
  rectangle(246, 218, 532, 22, [36, 111, 89]);
  rectangle(294, 261, 436, 12, [159, 174, 157]);
  rectangle(322, 286, 380, 12, [193, 203, 187]);
  rectangle(150, 348, 724, 135, [228, 236, 224]);
  rectangle(428, 586, 168, 40, [21, 28, 24]);
  let phase = 'version', pending = Buffer.alloc(0), frameSent = false;
  client.send(Buffer.from('RFB 003.008\n'));
  client.on('message', chunk => {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    while (pending.length) {
      if (phase === 'version') {
        if (pending.length < 12) return;
        pending = pending.subarray(12); phase = 'security'; client.send(Buffer.from([1, 1]));
      } else if (phase === 'security') {
        pending = pending.subarray(1); phase = 'init'; client.send(Buffer.alloc(4));
      } else if (phase === 'init') {
        pending = pending.subarray(1); phase = 'ready';
        const title = Buffer.from('Explicit preview fixture. No real computer connected.');
        const init = Buffer.alloc(24); init.writeUInt16BE(width); init.writeUInt16BE(height, 2);
        init[4] = 32; init[5] = 24; init[7] = 1;
        init.writeUInt16BE(255, 8); init.writeUInt16BE(255, 10); init.writeUInt16BE(255, 12); init[14] = 16; init[15] = 8;
        init.writeUInt32BE(title.length, 20); client.send(Buffer.concat([init, title]));
      } else {
        const type = pending[0];
        let length = type === 0 ? 20 : type === 3 ? 10 : type === 4 ? 8 : type === 5 ? 6 : undefined;
        if (type === 2) { if (pending.length < 4) return; length = 4 + pending.readUInt16BE(2) * 4; }
        if (type === 6) { if (pending.length < 8) return; length = 8 + pending.readUInt32BE(4); }
        if (!length) return;
        if (pending.length < length) return;
        const fullRefresh = type === 3 && pending[1] === 0;
        pending = pending.subarray(length);
        if (type === 3 && (!frameSent || fullRefresh)) {
          frameSent = true;
          const header = Buffer.alloc(16); header.writeUInt16BE(1, 2); header.writeUInt16BE(width, 8); header.writeUInt16BE(height, 10);
          client.send(Buffer.concat([header, pixels]));
        }
      }
    }
  });
}
