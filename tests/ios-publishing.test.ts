import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Operator tooling uses Node's built-in modules and has no TypeScript build step.
// @ts-expect-error Plain JavaScript operator module.
import { all, appleApi, distribute, requireReadyBuild, runPrivate } from '../.agents/tools/apple-api.mjs';

const ready = () => ({ id: 'build-42', attributes: { version: '42', processingState: 'VALID', expired: false }, marketingVersion: '1.0', relationships: { app: { data: { id: 'wildbots' } }, preReleaseVersion: { data: { id: 'v1' } } } });
const household = ['one@example.test', 'two@example.test'];

describe('iOS publishing fences', () => {
  it('retries a transient read failure but never repeats an uncertain mutation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wildbots-api-key-'));
    try {
      const keyFile = join(directory, 'test.p8');
      writeFileSync(keyFile, generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey, { mode: 0o600 });
      const reply = (status: number) => ({ ok: status === 200, status, text: async () => JSON.stringify(status === 200 ? { data: [] } : { errors: [{ code: 'UNEXPECTED_ERROR' }] }) });
      const transport = vi.fn().mockResolvedValueOnce(reply(500)).mockRejectedValueOnce(new Error('connection reset')).mockResolvedValueOnce(reply(200));
      const api = appleApi({ keyId: 'test', issuerId: 'test', keyFile }, transport);
      // Each of the two retries waits 2 s, which a virtual clock skips.
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      const read = expect(api('GET', '/apps')).resolves.toEqual({ data: [] });
      await vi.advanceTimersByTimeAsync(4000);
      await read;
      expect(transport).toHaveBeenCalledTimes(3);
      transport.mockReset().mockResolvedValue(reply(500));
      await expect(api('POST', '/profiles', { data: {} })).rejects.toThrow('HTTP 500');
      expect(transport).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); rmSync(directory, { recursive: true }); }
  });
  it('does not echo signing credentials when a subprocess fails', () => {
    try {
      runPrivate(process.execPath, ['-e', 'console.error(process.argv[1]); process.exit(1)', 'private-signing-password']);
      throw new Error('Expected subprocess failure');
    } catch (error) {
      expect((error as Error).message).toContain('failed (exit 1)');
      expect((error as Error).message).not.toContain('private-signing-password');
    }
  });
  it('rejects a different app, marketing version, build, and unfinished or expired builds', () => {
    expect(() => requireReadyBuild(ready(), '1.0', 42, 'wildbots')).not.toThrow();
    for (const change of [
      { marketingVersion: '2.0' }, { relationships: { app: { data: { id: 'steadlog' } } } },
      ...[{ version: '43' }, { processingState: 'PROCESSING' }, { expired: true }].map(attributes => ({ attributes: { ...ready().attributes, ...attributes } })),
    ]) expect(() => requireReadyBuild({ ...ready(), ...change }, '1.0', 42, 'wildbots')).toThrow();
  });

  it('does not forward a bearer token through unexpected pagination links', async () => {
    const api = vi.fn().mockResolvedValue({ data: [], links: { next: 'https://example.com/v1/apps' } });
    await expect(all(api, '/apps')).rejects.toThrow('pagination URL');
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('only emits an announcement after exact group membership and installable state are confirmed', async () => {
    let state = 'MISSING_EXPORT_COMPLIANCE';
    let member = false;
    let hasTesters = false;
    const api = vi.fn(async (method: string, route: string) => {
      if (route.startsWith('/apps?')) return { data: [{ id: 'wildbots', attributes: { bundleId: 'dev.agentinterface.ios' } }] };
      if (route.startsWith('/builds?')) return { data: [ready()], included: [{ id: 'v1', type: 'preReleaseVersions', attributes: { version: '1.0' } }] };
      if (route.includes('/wildbots/betaGroups')) return { data: [{ id: 'household', attributes: { name: 'Household', isInternalGroup: true, hasAccessToAllBuilds: false } }] };
      if (route.includes('/relationships/builds')) { member = true; return {}; }
      if (route.includes('/household/builds')) return { data: member ? [{ id: 'build-42' }] : [] };
      if (route === '/betaTesters?filter[betaGroups]=household&limit=200') return { data: hasTesters ? household.map(email => ({ id: email, attributes: { email } })) : [] };
      if (route.endsWith('/buildBetaDetail')) return { data: { attributes: { internalBuildState: state } } };
      throw new Error(`Unexpected ${method} ${route}`);
    });
    await expect(distribute(api, 42, '1.0', household)).rejects.toThrow('exactly the two');
    hasTesters = true;
    await expect(distribute(api, 42, '1.0', household)).rejects.toThrow('not ready');
    expect(api.mock.calls.every(([method]) => method === 'GET')).toBe(true);
    state = 'IN_BETA_TESTING';
    const receipt = await distribute(api, 42, '1.0', household);
    expect(receipt).toMatchObject({ appId: 'wildbots', buildId: 'build-42', groupId: 'household', announcement: { IOS_APP_LATEST_BUILD: '42' } });
    expect(api.mock.calls.filter(([method, route]) => method === 'POST' && route.includes('relationships/builds'))).toHaveLength(1);
  });

  it('does not create a group when the selected build is still processing', async () => {
    const api = vi.fn(async (_method: string, route: string) => route.startsWith('/apps?') ? { data: [{ id: 'wildbots', attributes: { bundleId: 'dev.agentinterface.ios' } }] } : { data: [] });
    await expect(distribute(api, 42, '1.0', household)).rejects.toThrow('not finished processing');
    expect(api.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });
});
