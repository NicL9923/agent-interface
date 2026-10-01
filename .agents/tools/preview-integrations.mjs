#!/usr/bin/env node
// Local visual/interaction fixture. This never contacts Hermes or external services.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
const port = Number(process.env.PREVIEW_PORT || 3000);
const root = resolve('dist/client');
const bot = { id: 'ranch', name: 'Ranch hand', shared: true, model: 'configured-model', provider: 'openrouter', activity: 'idle' };
const preferences = { theme: 'system', presentation: 'simple', favorites: [], sections: [], followBots: [] };
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
const json = (response, data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); };
createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  let body = {}; if (request.method !== 'GET') { const chunks = []; for await (const chunk of request) chunks.push(chunk); try { body = JSON.parse(Buffer.concat(chunks)); } catch {} }
  if (url.pathname.startsWith('/api/')) {
    const path = url.pathname.slice(4);
    if (path === '/auth/config') return json(response, { localDevAuth: true, nativeAuthVersion: 1 });
    if (path === '/bootstrap') return json(response, { user: { id: 'preview', name: 'Preview member', email: 'preview@localhost.invalid' }, household: [], bots: [bot], preferences, connection: { connected: true, version: 'Preview fixture' }, csrfToken: 'fixture-only', capabilities: Object.fromEntries(['chat', 'steering', 'approvals', 'uploads', 'generatedFiles', 'botConfiguration', 'tools', 'skills', 'routines', 'stop', 'avatarMetadata'].map(key => [key, { supported: true }])) });
    if (path === '/integrations') return json(response, { profile: 'ranch', canManage: true, connections });
    if (path.includes('/integrations/flows/')) { const flow = flows.get(path.split('/')[3]); if (request.method === 'DELETE') flow.status = 'cancelled'; return json(response, flow || { status: 'expired', kind: 'instructions', message: 'Sign-in expired.' }); }
    if (path === '/integrations/mcp') { const item = { ...connections[0], id: body.name, name: body.name, category: 'custom', account: undefined, status: 'configured', detail: 'Custom server saved. Check the connection to verify it.', permissions: [], setup: [] }; connections.push(item); return json(response, item); }
    if (path.startsWith('/integrations/')) { const item = connections.find(item => item.id === path.split('/')[2]); if (path.endsWith('/connect')) { const flow = { flowId: `preview-${item.id}`, status: 'pending', kind: 'device_code', userCode: 'RANCH-42', message: 'Fixture sign-in pending. This preview does not contact account providers.' }; flows.set(flow.flowId, flow); return json(response, flow); } item.status = path.endsWith('/disconnect') ? 'not_connected' : 'connected'; item.detail = path.endsWith('/disconnect') ? 'Connection removed.' : 'Connection checked in the preview fixture.'; item.checkedAt = new Date().toISOString(); return json(response, item); }
    if (path === '/hermes/upgrade/control') { upgrade = { ...upgrade, phase: 'recovering', message: 'Waiting for a safe stopping point, then checking the connection.', canRetry: false, canCancel: false, canRestartService: false }; return json(response, upgrade); }
    if (path === '/hermes/upgrade') return json(response, upgrade);
    if (path.endsWith('/conversation')) return json(response, { botId: bot.id, messages: [{ id: 'hello', role: 'assistant', text: 'Your household workspace is ready. This preview uses local fixtures.', createdAt: '2026-10-01T17:00:00Z' }], activity: { state: 'idle' }, approvals: [], files: [], draft: { text: '', attachments: [] } });
    if (path.endsWith('/draft')) return json(response, {text:'',attachments:[]});
    if (path === '/preferences') { Object.assign(preferences, body); return json(response, preferences); }
    return json(response, {});
  }
  try { const file = resolve(root, '.' + url.pathname); if (!file.startsWith(root + '/') && file !== root) throw Error(); const content = await readFile(url.pathname === '/' ? resolve(root, 'index.html') : file); response.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.html': 'text/html' })[extname(file)] || 'text/html' }); response.end(content); }
  catch { try { const fallback = await readFile(resolve(root, 'index.html')); response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(fallback); } catch { response.writeHead(404); response.end('Run npm run build first.'); } }
}).listen(port, '127.0.0.1', () => process.stdout.write(`Fixture-only preview: http://127.0.0.1:${port}\n`));
