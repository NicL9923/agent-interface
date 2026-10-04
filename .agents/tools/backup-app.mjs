#!/usr/bin/env node
// An online SQLite backup, including committed WAL content. Keep these private.
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const [source, directory] = process.argv.slice(2);
if (!source || !directory || process.argv.length !== 4) {
  throw new Error('Usage: node .agents/tools/backup-app.mjs APP_DATABASE BACKUP_DIRECTORY');
}
// The app's readiness check (src/server/health.ts) matches the same completed-copy names.
const completedName = /^agent-interface-\d{4}-\d{2}-\d{2}T[\d.-]+Z-[a-f0-9-]{36}\.sqlite$/;
const partialName = /^agent-interface-\d{4}-\d{2}-\d{2}T[\d.-]+Z-[a-f0-9-]{36}\.sqlite\.partial(?:-shm|-wal)?$/;
const removeIfPresent = path => unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
process.umask(0o077);
const destination = resolve(directory);
await mkdir(destination, { recursive: true, mode: 0o700 });
// Earlier runs left verification sidecars behind. An hour's age leaves any concurrent run alone.
for (const file of (await readdir(destination)).filter(file => partialName.test(file))) {
  const path = join(destination, file);
  if ((await stat(path)).mtimeMs < Date.now() - 3600_000) await removeIfPresent(path);
}
const name = `agent-interface-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.sqlite`;
const completed = join(destination, name);
const temporary = `${completed}.partial`;
const database = new DatabaseSync(resolve(source), { readOnly: true });
try {
  await backup(database, temporary);
  // Opening the WAL-mode copy creates -shm and -wal sidecars; the finally block removes them.
  const copy = new DatabaseSync(temporary, { readOnly: true });
  try {
    const result = copy.prepare('PRAGMA quick_check').all();
    if (result.length !== 1 || result[0].quick_check !== 'ok')
      throw new Error('Backup integrity check failed; existing backups were retained.');
  } finally { copy.close(); }
  await rename(temporary, completed);
  // Prune only this tool's completed backups, and only after a verified new copy.
  const previous = (await readdir(destination))
    .filter(file => completedName.test(file))
    .sort().reverse();
  for (const old of previous.slice(14)) await unlink(join(destination, old));
  console.log(`Verified application backup: ${name}. Retained up to 14 copies.`);
} finally {
  database.close();
  for (const suffix of ['', '-shm', '-wal']) await removeIfPresent(`${temporary}${suffix}`);
}
