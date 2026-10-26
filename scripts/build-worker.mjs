import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPopupLibraryIsLazy, precachePlan } from './precache-plan.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'dist/client');
const files = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    // Vite's manifest is build input for the plan below, not something to serve or cache.
    if (entry.isDirectory()) { if (entry.name !== '.vite') await collect(file); }
    else if (entry.name !== 'sw.js' && !entry.name.endsWith('.map')) files.push(file);
  }
}
await collect(output);
files.sort();
const hash = createHash('sha256');
for (const file of files) {
  hash.update(relative(output, file));
  hash.update(await readFile(file));
}
const template = await readFile(join(root, 'scripts/service-worker.js'), 'utf8');
hash.update(template);
const version = hash.digest('hex').slice(0, 16);
const names = files.map((file) => relative(output, file).split('\\').join('/'));
const manifest = JSON.parse(await readFile(join(output, '.vite/manifest.json'), 'utf8'));
assertPopupLibraryIsLazy(manifest, (file) => readFileSync(join(output, file), 'utf8'));
const plan = precachePlan(manifest, names);
// Nothing serves or needs it after this, so it does not ship.
await rm(join(output, '.vite'), { recursive: true });
const slash = (list) => JSON.stringify(list.map((name) => '/' + name));
const worker = template.replace('__BUILD_ID__', version).replace('__PRECACHE__', slash(plan.precache)).replace('__ON_DEMAND__', slash(plan.onDemand));
await writeFile(join(output, 'sw.js'), worker);
console.log(`Built service worker ${version} with ${plan.precache.length} precached files and ${plan.onDemand.length} cached on first use.`);
