#!/usr/bin/env node
// Linux release host: node --env-file=PRIVATE_APP_ENV --import tsx THIS_FILE BUILD PRIVATE_RECEIPT
// Run from the deployed release.
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [buildText, receiptPath] = process.argv.slice(2);
const check = (condition, message) => { if (!condition) throw new Error(message); };
check(process.platform === 'linux' && process.argv.length === 4, 'Run on the Linux release host with BUILD and RECEIPT_PATH');
check(/^[1-9][0-9]{0,8}$/.test(buildText ?? ''), 'Supply a positive build number');
check(isAbsolute(receiptPath ?? '') && !existsSync(receiptPath), 'Receipt must be a new absolute path');
const parent = lstatSync(dirname(receiptPath));
check(parent.isDirectory() && parent.uid === process.getuid() && (parent.mode & 0o077) === 0, 'Receipt directory must be owner-private');
const root = resolve(process.cwd());
check(existsSync(join(root, 'dist/client/sw.js')), 'Run from the deployed release');
const { allowedIdentity, loadConfig } = await import(pathToFileURL(join(root, 'src/server/config.ts')).href);
const { hash } = await import(pathToFileURL(join(root, 'src/server/auth.ts')).href);
const config = loadConfig();
check(config.host === '127.0.0.1' && isAbsolute(config.database) && existsSync(config.database), 'Expected a loopback production app');
const db = new DatabaseSync(config.database, { timeout: 2000 });
const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex'), tokenHash = hash(token);
let created = false, receipt;
try {
  const user = db.prepare('SELECT id,email FROM users ORDER BY id').all().find(user => allowedIdentity(config, user));
  check(user, 'No permitted household identity');
  db.prepare('INSERT INTO sessions(hash,user_id,csrf,expires) VALUES(?,?,?,?)').run(tokenHash, user.id, csrf, Date.now() + 120_000);
  created = true;
  const response = await fetch(`http://127.0.0.1:${config.port}/api/bootstrap`, {
    headers: { cookie: `session=${token}`, origin: config.origin }, redirect: 'error', signal: AbortSignal.timeout(60_000),
  });
  check(response.ok, 'Authenticated bootstrap failed');
  const bootstrap = await response.json();
  check(bootstrap.user?.id === user.id && bootstrap.csrfToken === csrf, 'Bootstrap identity mismatch');
  check(bootstrap.connection?.connected === true, 'Hermes is disconnected');
  check(bootstrap.nativeApp?.latestBuild === Number(buildText), 'Announced iOS build differs');
  check(bootstrap.nativeApp?.updateUrl === config.nativeApp?.updateUrl, 'Update link differs');
  const url = new URL(bootstrap.nativeApp.updateUrl);
  check(url.protocol === 'https:' && url.hostname === 'testflight.apple.com', 'Expected the existing TestFlight link');
  const workerResponse = await fetch(`http://127.0.0.1:${config.port}/sw.js`, {
    redirect: 'error', signal: AbortSignal.timeout(60_000),
  });
  check(workerResponse.ok, 'Service worker fetch failed');
  const worker = await workerResponse.text();
  check(worker === readFileSync(join(root, 'dist/client/sw.js'), 'utf8'), 'Server differs from the selected release');
  const webBuild = worker.match(/const CACHE = 'agent-interface-([0-9a-f]{16})'/)?.[1];
  check(webBuild, 'Service worker build is missing');
  receipt = { checkedAt: new Date().toISOString(), authenticatedBootstrap: true, nativeConnected: true,
    latestBuild: Number(buildText), updateUrl: url.href, release: root, webBuild };
} finally {
  try { if (created) db.prepare('DELETE FROM sessions WHERE hash=?').run(tokenHash); }
  finally { db.close(); }
}
writeFileSync(receiptPath, JSON.stringify({ ...receipt, temporarySessionRemoved: true }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ authenticatedBootstrap: true, nativeConnected: true, latestBuild: Number(buildText), temporarySessionRemoved: true }));
