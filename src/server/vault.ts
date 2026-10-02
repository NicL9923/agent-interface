import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { signedIn } from './auth.js';
import type { Runtime } from '../shared/types.js';
import type { SecureRequestAnswer, VaultRequest } from '../shared/vault.js';
const failure = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const source = z.enum(['onepassword', 'bitwarden']);
const method = z.enum(['vault.save_login', 'vault.code', 'vault.unlock_prompt', 'secret']);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const text = z.string().min(1).max(20000);
const owner = { epoch: id, sessionId: id };
const answer = z.union([
  z.object({ ...owner, method, cancel: z.literal(true) }).strict(),
  z.object({ ...owner, method: z.literal('vault.save_login'), identifier: z.string().trim().min(1).max(1000), password: text }).strict(),
  z.object({ ...owner, method: z.enum(['vault.code', 'vault.unlock_prompt', 'secret']), value: text }).strict(),
]);
const login = z.object({
  label: z.string().trim().min(1).max(200),
  origin: z.string().url().max(2048).refine(value => {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && (url.pathname === '/' || !url.pathname);
  }),
  identifierType: z.enum(['email', 'phone', 'username']),
  identifier: z.string().trim().min(1).max(1000),
  password: text,
  otpSecret: z.string().max(4000).optional(),
}).strict();
export async function installVaultRoutes(app: FastifyInstance, runtime: Runtime) {
  const busy = new Set<string>();
  async function request(userId: string, input: VaultRequest) {
    if (!(await runtime.listBots()).some(bot => bot.id === input.profile)) throw failure(404, 'Assistant not found');
    if (!runtime.vaultRequest) throw failure(409, 'The installed Hermes integration does not support secure credentials.');
    const key = userId + ':' + input.profile;
    if (input.operation !== 'overview' && busy.has(key)) throw failure(429, 'A credential operation is already running. Wait for it to finish.');
    if (input.operation !== 'overview') busy.add(key);
    try { return await runtime.vaultRequest(input); }
    catch (error) {
      // Secret-bearing operations never forward exception text, even in development.
      const status = (error as { statusCode?: number }).statusCode;
      throw failure(status && [400, 401, 403, 404, 409, 429].includes(status) ? status : 502,
        status === 409 ? 'This credential request changed or is unavailable. Refresh and review it before continuing.' : 'Hermes could not confirm this credential operation. Refresh its status before trying again.');
    } finally { if (input.operation !== 'overview') busy.delete(key); }
  }
  const botId = (req: { params: unknown }) => z.object({ id }).passthrough().parse(req.params).id;
  app.get('/api/bots/:id/vault', req => request(signedIn(req).id, { operation: 'overview', profile: botId(req) }));
  app.post('/api/bots/:id/vault/logins', req => request(signedIn(req).id, { operation: 'add_login', profile: botId(req), login: login.parse(req.body) }));
  app.delete('/api/bots/:id/vault/logins/:itemId', req => {
    const params = z.object({ id, itemId: id }).strict().parse(req.params);
    return request(signedIn(req).id, { operation: 'remove_login', profile: params.id, itemId: params.itemId });
  });
  app.put('/api/bots/:id/vault/sources/:source', req => {
    const params = z.object({ id, source }).strict().parse(req.params);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    return request(signedIn(req).id, { operation: 'source', profile: params.id, source: params.source, enabled });
  });
  app.post('/api/bots/:id/vault/sources/:source/unlock', req => {
    const params = z.object({ id, source }).strict().parse(req.params);
    const { password } = z.object({ password: text }).strict().parse(req.body);
    return request(signedIn(req).id, { operation: 'unlock', profile: params.id, source: params.source, password });
  });
  app.post('/api/bots/:id/vault/sources/:source/lock', req => {
    const params = z.object({ id, source }).strict().parse(req.params);
    z.object({}).strict().parse(req.body);
    return request(signedIn(req).id, { operation: 'lock', profile: params.id, source: params.source });
  });
  app.post('/api/bots/:id/secure-requests/:requestId', req => {
    const params = z.object({ id, requestId: id }).strict().parse(req.params);
    const payload = answer.parse(req.body) as SecureRequestAnswer;
    return request(signedIn(req).id, { operation: 'answer', profile: params.id, requestId: params.requestId, answer: payload });
  });
}
