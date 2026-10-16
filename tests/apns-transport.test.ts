import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('node:http2', () => ({ connect: mocked.connect }));
import { createApnsSender } from '../src/server/apns.js';

it('times out a Live Activity stream without aborting an in-flight alert', async () => {
  vi.useFakeTimers();
  const directory = mkdtempSync(join(tmpdir(), 'apns-stream-'));
  const keyFile = join(directory, 'key.p8');
  const streams: (EventEmitter & { close: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; setEncoding: ReturnType<typeof vi.fn> })[] = [];
  const session = Object.assign(new EventEmitter(), { closed: false, destroyed: false, destroy: vi.fn(), request: vi.fn(() => {
    const stream = Object.assign(new EventEmitter(), { close: vi.fn(), end: vi.fn(), setEncoding: vi.fn() });
    streams.push(stream);
    return stream;
  }) });
  mocked.connect.mockReturnValue(session);
  writeFileSync(keyFile, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const sender = createApnsSender({ teamId: 'TEAM123456', keyId: 'KEY1234567', topic: 'test.app', environment: 'sandbox', privateKeyFile: keyFile })!;
  const target = { deviceId: 'device', token: 'ab'.repeat(32), environment: 'sandbox' as const };
  try {
    const activity = sender.liveActivity(target, { aps: { event: 'update' } }, 5).catch(error => error);
    await vi.advanceTimersByTimeAsync(5000);
    const alert = sender(target, JSON.stringify({ title: 'Ready', body: 'Done', url: '/', tag: 'test' }));
    await vi.advanceTimersByTimeAsync(10000);
    expect((await activity).message).toContain('timed out');
    expect(streams[0].close).toHaveBeenCalledOnce();
    expect(session.destroy).not.toHaveBeenCalled();
    streams[1].emit('response', { ':status': 200 });
    streams[1].emit('end');
    await expect(alert).resolves.toBeUndefined();
  } finally {
    sender.close();
    vi.useRealTimers();
    rmSync(directory, { recursive: true });
  }
});
