#!/usr/bin/env node
// Local visual/interaction fixture. This never contacts Hermes or external services.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { WebSocketServer } from 'ws';
const port = Number(process.env.PREVIEW_PORT || 3000);
const host = process.env.PREVIEW_HOST || '127.0.0.1';
const root = resolve('dist/client');
// Visual-only onboarding fixture on insecure LAN previews. Push remains unsupported.
const fixtureHtml = async () => {
  const html = await readFile(resolve(root, 'index.html'), 'utf8');
  return process.env.PREVIEW_NOTIFICATION_PROMPT === '1'
    ? html.replace('<head>', '<head><script>if(window.Notification)Object.defineProperty(Notification,"permission",{get:()=>"default",configurable:true});</script>')
    : html;
};
// A fixture key only, never usable for delivery.
const previewPushKey = process.env.PREVIEW_PUSH_CONFIGURED === '1' ? Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url') : undefined;
// PREVIEW_THEME=light|dark|system and PREVIEW_PRESENTATION=simple|advanced pick the initial preferences.
const portrait = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="#d9c7a3"/><circle cx="40" cy="31" r="15" fill="#6b4f3a"/><path d="M12 80c4-20 16-29 28-29s24 9 28 29Z" fill="#3f6b57"/></svg>');
const bots = [
  { id: 'ranch', name: 'Ranch hand', shared: true, model: 'configured-model', provider: 'openrouter', activity: 'working', description: 'Everyday household help', avatar: { mode: 'geometric', shape: 'blob', color: '#1084FE', eyes: 'oval', accessory: 'none' } },
  { id: 'kitchen', name: 'Kitchen companion', shared: true, model: 'configured-model', provider: 'openrouter', activity: 'idle', avatar: { mode: 'mascot', family: 'bear', color: '#FF9800', eyes: 'round', accessory: 'none' } },
  { id: 'garden', name: 'Garden planner', shared: false, model: 'configured-model', provider: 'openrouter', activity: 'thinking', avatar: { mode: 'mascot', family: 'sprout', color: '#00BCA6', eyes: 'oval', accessory: 'hat' } },
  { id: 'homework', name: 'Homework helper', shared: false, model: 'configured-model', provider: 'openrouter', activity: 'waiting', avatar: { mode: 'geometric', shape: 'hex', color: '#9159FE', eyes: 'oval', accessory: 'glasses' } },
  { id: 'ledger', name: 'Ledger', shared: true, model: 'configured-model', provider: 'openrouter', activity: 'blocked', avatar: { mode: 'geometric', shape: 'triangle', color: '#FF309B', eyes: 'visor', accessory: 'none' } },
  { id: 'fox', name: 'Trail scout with a long name for wrapping', shared: false, model: 'configured-model', provider: 'openrouter', activity: 'done', avatar: { mode: 'mascot', family: 'fox', color: '#FF6700', eyes: 'oval', accessory: 'none' } },
  { id: 'guide', name: 'Trail guide', shared: true, model: 'configured-model', provider: 'openrouter', activity: 'failed', avatar: { mode: 'portrait', src: portrait, origin: 'uploaded' } },
];
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
const conversationFor = (id) => ({ botId: id, messages: [], approvals: [], files: [], activity: { state: bots.find(item => item.id === id)?.activity || 'idle' }, ...conversations[id] });
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
const computerStatus = () => ({ available: true, running: true, browserReady: true, label: 'Preview computer', control: computerControl,
  terminal: { available: true, target: 'preview@fixture' } });
let computerTicket = 0;
const computerTickets = new Map();
// PREVIEW_SIGNED_OUT=1 starts at the sign-in page; local sign-in then opens the fixture household.
let signedIn = process.env.PREVIEW_SIGNED_OUT !== '1';
const json = (response, data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); };
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  let body = {}; if (request.method !== 'GET') { const chunks = []; for await (const chunk of request) chunks.push(chunk); try { body = JSON.parse(Buffer.concat(chunks)); } catch {} }
  if (url.pathname.startsWith('/api/')) {
    const path = url.pathname.slice(4);
    if (path === '/auth/config') return json(response, { localDevAuth: true, nativeAuthVersion: 1 });
    if (path === '/auth/local') { signedIn = true; return json(response, { ok: true }); }
    if (path === '/bootstrap' && !signedIn) return json(response, { error: 'Sign in to continue.' }, 401);
    if (path === '/bootstrap') return json(response, { user: { id: 'preview', name: 'Nicolas', email: 'preview@localhost.invalid' }, household: [{ id: 'preview', name: 'Nicolas' }, { id: 'two', name: 'Jordan' }], bots, preferences, vapidPublicKey: previewPushKey, connection: { connected: process.env.PREVIEW_DISCONNECTED !== '1', version: 'Preview fixture' }, csrfToken: 'fixture-only', capabilities: Object.fromEntries(['chat', 'steering', 'approvals', 'uploads', 'generatedFiles', 'botConfiguration', 'tools', 'skills', 'routines', 'stop', 'avatarMetadata', 'durableEvents', 'idempotency', 'imageGeneration', 'portraitGeneration'].map(key => [key, { supported: true }])) });
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
    if (path === '/routines') return json(response, [{ id: 'r1', botId: 'ranch', name: 'Morning check', prompt: 'Summarize overnight sensor alerts and the weather.', schedule: '0 6 * * *', enabled: true, recipientIds: ['preview'] }]);
    if (path.endsWith('/draft')) return json(response, {text:'',attachments:[]});
    if (path === '/preferences') { Object.assign(preferences, body); return json(response, preferences); }
    return json(response, {});
  }
  try { const file = resolve(root, '.' + url.pathname); if (!file.startsWith(root + '/') && file !== root) throw Error(); const content = url.pathname === '/' ? await fixtureHtml() : await readFile(file); response.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.html': 'text/html' })[extname(file)] || 'text/html' }); response.end(content); }
  catch { try { const fallback = await fixtureHtml(); response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(fallback); } catch { response.writeHead(404); response.end('Run npm run build first.'); } }
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
