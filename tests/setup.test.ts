import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { checkSetup, effectiveEnv, readPrivateEnv, savePrivateEnv, resolveSetupOrigin, updateEnv, verifyAndSave } from '../scripts/setup.js';

const directories: string[] = [];
async function file() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-interface-setup-'));
  directories.push(directory);
  return path.join(directory, '.env');
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => fs.rm(directory, {recursive: true, force: true}))); });
const configured = { LOCAL_DEV_AUTH: 'true', HERMES_URL: 'http://127.0.0.1:19121', HERMES_TOKEN: 'test-token' };
const original = '# Existing private settings\nLOCAL_DEV_AUTH=true\nHERMES_URL=http://127.0.0.1:19121\nHERMES_TOKEN="old#token"\nOTHER=keep\n';

describe('host-local connection setup', () => {
  it('preserves comments, unrelated multiline assignments and quoted values, replacing duplicate settings', () => {
    const text = '# Keep this\r\nexport OTHER="first\r\nsecond"\r\nHERMES_TOKEN="old\r\ntoken"\r\nHERMES_TOKEN=duplicate\r\nEXTRA=\'hash#value\'\r\n';
    const result = updateEnv(text, {HERMES_TOKEN: 'new#token"quoted', LOCAL_DEV_AUTH: 'false'});
    expect(result).toContain('# Keep this\r\nexport OTHER="first\r\nsecond"\r\n');
    expect(result).toContain("EXTRA='hash#value'\r\n");
    expect(result.match(/HERMES_TOKEN=/g)).toHaveLength(1);
    expect(parseEnv(result)).toMatchObject({OTHER: 'first\nsecond', HERMES_TOKEN: 'new#token"quoted', LOCAL_DEV_AUTH: 'false', EXTRA: 'hash#value'});
  });

  it('refuses settings that could inject another environment entry or change a secret during parsing', () => {
    expect(() => updateEnv('', {HERMES_TOKEN: 'secret\nLOCAL_DEV_AUTH=true'})).toThrow('one line');
    expect(parseEnv(updateEnv('', {HERMES_TOKEN: 'secret\\nvalue'})).HERMES_TOKEN).toBe('secret\\nvalue');
    expect(() => updateEnv('', {HERMES_TOKEN: 'all"three\'quotes`'})).toThrow('quote');
  });

  it('uses exported settings just like server startup without changing process environment', () => {
    const exported = {HERMES_TOKEN: 'exported-token', HOST: '127.0.0.1', UNRELATED: undefined};
    const result = effectiveEnv('HERMES_TOKEN="file#token"\nLOCAL_DEV_AUTH=true\n', exported);
    expect(result.values).toMatchObject({HERMES_TOKEN: 'exported-token', LOCAL_DEV_AUTH: 'true', HOST: '127.0.0.1'});
    expect(result.values).not.toHaveProperty('UNRELATED');
    expect(result.shadowed).toEqual(['HERMES_TOKEN']);
    expect(exported).toEqual({HERMES_TOKEN: 'exported-token', HOST: '127.0.0.1', UNRELATED: undefined});
  });

  it('requires an explicit corrected application origin when the saved value is malformed', async () => {
    const values = {...configured, APP_ORIGIN: '127.0.0.1:3000'};
    const prompt = vi.fn(async () => 'http://127.0.0.1:3000');
    const resolved = await resolveSetupOrigin(values, prompt);
    expect(prompt).toHaveBeenCalledOnce();
    expect(resolved.origin.origin).toBe('http://127.0.0.1:3000');
    expect(resolved.correction).toBe('http://127.0.0.1:3000');
    expect(values.APP_ORIGIN).toBe('127.0.0.1:3000');
    await expect(resolveSetupOrigin(values, async () => '')).rejects.toThrow('APP_ORIGIN');
    await expect(checkSetup(values)).rejects.toThrow('APP_ORIGIN');
  });

  it('keeps public and production authentication constraints after an explicit origin correction', async () => {
    const prompt = vi.fn(async () => 'https://household.example.com');
    const resolved = await resolveSetupOrigin({APP_ORIGIN: 'household.example.com'}, prompt);
    expect(resolved.origin.origin).toBe('https://household.example.com');
    const factory = vi.fn();
    await expect(checkSetup({...configured, APP_ORIGIN: resolved.correction}, factory)).rejects.toThrow('Local development auth');
    await expect(checkSetup({...configured, NODE_ENV: 'production', APP_ORIGIN: 'http://127.0.0.1:3000'}, factory)).rejects.toThrow('Local development auth');
    expect(factory).not.toHaveBeenCalled();
    await expect(resolveSetupOrigin({APP_ORIGIN: 'ftp://localhost'}, async () => 'ftp://localhost')).rejects.toThrow('APP_ORIGIN');
  });

  it('writes atomically with owner-only permissions and refuses a concurrent edit', async () => {
    const filename = await file();
    await fs.writeFile(filename, original, {mode: 0o644});
    const next = updateEnv(original, {HERMES_TOKEN: 'new#token'});
    await savePrivateEnv(filename, original, next);
    expect(await fs.readFile(filename, 'utf8')).toBe(next);
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);
    await expect(savePrivateEnv(filename, original, 'wrong')).rejects.toThrow('changed during setup');
    expect(await fs.readFile(filename, 'utf8')).toBe(next);
    expect(await fs.readdir(path.dirname(filename))).toEqual(['.env']);
  });

  it('creates a new private file and refuses symbolic links', async () => {
    const filename = await file();
    expect(await readPrivateEnv(filename)).toBeUndefined();
    await savePrivateEnv(filename, undefined, original);
    const link = path.join(path.dirname(filename), 'linked.env');
    await fs.symlink(filename, link);
    await expect(readPrivateEnv(link)).rejects.toThrow('symbolic link');
    await expect(savePrivateEnv(link, original, 'wrong')).rejects.toThrow('symbolic link');
    expect(await fs.readFile(filename, 'utf8')).toBe(original);
  });

  it('checks the actual runtime diagnostic and closes it without creating or mutating bots', async () => {
    const status = vi.fn(async () => ({connected: true, code: 'ready' as const}));
    const close = vi.fn(async () => {});
    const factory = vi.fn(() => ({status, close}));
    expect(await checkSetup(configured, factory)).toEqual({connected: true, code: 'ready'});
    expect(factory).toHaveBeenCalledWith({url: configured.HERMES_URL, token: configured.HERMES_TOKEN});
    expect(status).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('requires explicit usable authentication and never downgrades production to local test auth', async () => {
    const factory = vi.fn();
    await expect(checkSetup({...configured, LOCAL_DEV_AUTH: 'false'}, factory)).rejects.toThrow('Configure Google sign-in');
    await expect(checkSetup({...configured, NODE_ENV: 'production'}, factory)).rejects.toThrow('Local development auth');
    await expect(checkSetup({...configured, HOST: '0.0.0.0'}, factory)).rejects.toThrow('Local development auth');
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(['unauthorized', 'unreachable', 'addon_missing', 'incompatible'] as const)('keeps the previous file when the candidate is %s', async code => {
    const filename = await file();
    await fs.writeFile(filename, original);
    const close = vi.fn(async () => {});
    const next = updateEnv(original, {HERMES_TOKEN: 'candidate-token'});
    await expect(verifyAndSave(filename, original, next, {}, () => ({status: async () => ({connected: code === 'addon_missing' || code === 'incompatible', code, detail: 'Safe actionable detail.'}), close}))).rejects.toThrow(`Hermes ${code}`);
    expect(await fs.readFile(filename, 'utf8')).toBe(original);
    expect(close).toHaveBeenCalledOnce();
  });

  it('persists only a verified ready candidate and releases the diagnostic connection', async () => {
    const filename = await file();
    const next = updateEnv('', configured);
    const close = vi.fn(async () => {});
    await verifyAndSave(filename, undefined, next, {}, () => ({status: async () => ({connected: true, code: 'ready'}), close}));
    expect(await fs.readFile(filename, 'utf8')).toBe(next);
    expect(close).toHaveBeenCalledOnce();
  });

  it('releases the connection if diagnostic execution fails', async () => {
    const close = vi.fn(async () => {});
    await expect(checkSetup(configured, () => ({status: async () => { throw new Error('Safe runtime failure'); }, close}))).rejects.toThrow('Safe runtime failure');
    expect(close).toHaveBeenCalledOnce();
  });
});
