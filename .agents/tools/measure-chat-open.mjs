#!/usr/bin/env node
// Linux release host, from the deployed release:
//   node --env-file=PRIVATE_APP_ENV --import tsx THIS_FILE [--rounds 3] [--turns 20] [--bot ID]
// Times the read a web chat opens with (GET /api/bots/:id/conversation?turns=20) for each assistant,
// with the server's Server-Timing breakdown and body size. Prints no message content. Uses a
// two-minute app session that it deletes.
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: {
  rounds: { type: 'string', default: '3' }, turns: { type: 'string', default: '20' }, bot: { type: 'string', multiple: true },
} });
const check = (condition, message) => { if (!condition) throw new Error(message); };
const root = resolve(process.cwd());
check(existsSync(join(root, 'dist/client/sw.js')), 'Run from the deployed release');
const { allowedIdentity, loadConfig } = await import(pathToFileURL(join(root, 'src/server/config.ts')).href);
const { hash } = await import(pathToFileURL(join(root, 'src/server/auth.ts')).href);
const config = loadConfig();
check(config.host === '127.0.0.1' && isAbsolute(config.database) && existsSync(config.database), 'Expected a loopback production app');
const db = new DatabaseSync(config.database, { timeout: 2000 });
const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex'), tokenHash = hash(token);
const base = `http://127.0.0.1:${config.port}/api`;
const headers = { cookie: `session=${token}`, origin: config.origin };
const timed = async path => {
  const started = performance.now();
  const response = await fetch(base + path, { headers, redirect: 'error', signal: AbortSignal.timeout(60_000) });
  const body = await response.arrayBuffer();
  return { status: response.status, ms: Math.round(performance.now() - started), bytes: body.byteLength,
    timing: response.headers.get('server-timing') ?? '', body };
};
let created = false;
try {
  const user = db.prepare('SELECT id,email FROM users ORDER BY id').all().find(user => allowedIdentity(config, user));
  check(user, 'No permitted household identity');
  db.prepare('INSERT INTO sessions(hash,user_id,csrf,expires) VALUES(?,?,?,?)').run(tokenHash, user.id, csrf, Date.now() + 120_000);
  created = true;
  const boot = await timed('/bootstrap');
  check(boot.status === 200, `Bootstrap answered ${boot.status}`);
  console.log(JSON.stringify({ path: '/bootstrap', ms: boot.ms, bytes: boot.bytes }));
  const roster = await timed('/bots?roster=lean');
  check(roster.status === 200, `Roster answered ${roster.status}`);
  console.log(JSON.stringify({ path: '/bots?roster=lean', ms: roster.ms, bytes: roster.bytes }));
  const bots = JSON.parse(Buffer.from(roster.body).toString('utf8')).map(bot => bot.id)
    .filter(id => !args.bot?.length || args.bot.includes(id));
  for (let round = 1; round <= Number(args.rounds); round++) {
    for (const id of bots) {
      const result = await timed(`/bots/${encodeURIComponent(id)}/conversation?turns=${Number(args.turns)}`);
      let messages;
      try { messages = JSON.parse(Buffer.from(result.body).toString('utf8')).messages?.length; } catch {}
      console.log(JSON.stringify({ round, bot: id, status: result.status, ms: result.ms, bytes: result.bytes, messages, timing: result.timing }));
    }
  }
} finally {
  try { if (created) db.prepare('DELETE FROM sessions WHERE hash=?').run(tokenHash); }
  finally { db.close(); }
}
console.log(JSON.stringify({ temporarySessionRemoved: created }));
