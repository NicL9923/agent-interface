#!/usr/bin/env node
// An online SQLite backup, including committed WAL content. Keep these private.
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, readdir, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const [source, directory] = process.argv.slice(2);
if (!source || !directory || process.argv.length !== 4) {
  throw new Error('Usage: node .agents/tools/backup-app.mjs APP_DATABASE BACKUP_DIRECTORY');
}
process.umask(0o077);
const destination = resolve(directory);
await mkdir(destination, { recursive: true, mode: 0o700 });
const name = `agent-interface-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.sqlite`;
const completed = join(destination, name);
const temporary = `${completed}.partial`;
const database = new DatabaseSync(resolve(source), { readOnly: true });
try {
  await backup(database, temporary);
  const copy = new DatabaseSync(temporary, { readOnly: true });
  try {
    const result = copy.prepare('PRAGMA quick_check').all();
    if (result.length !== 1 || result[0].quick_check !== 'ok')
      throw new Error('Backup integrity check failed; existing backups were retained.');
  } finally { copy.close(); }
  await rename(temporary, completed);
  // Prune only this tool's completed backups, and only after a verified new copy.
  const previous = (await readdir(destination))
    .filter(file => /^agent-interface-\d{4}-\d{2}-\d{2}T[\d.-]+Z-[a-f0-9-]{36}\.sqlite$/.test(file))
    .sort().reverse();
  for (const old of previous.slice(14)) await unlink(join(destination, old));
  console.log(`Verified application backup: ${name}. Retained up to 14 copies.`);
} finally {
  database.close();
  await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
