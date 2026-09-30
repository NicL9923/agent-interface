import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'dist/client');
const files = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await collect(file);
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
const paths = files.map((file) => '/' + relative(output, file).split('\\').join('/'));
const worker = template.replace('__BUILD_ID__', version).replace('__PRECACHE__', JSON.stringify(paths));
await writeFile(join(output, 'sw.js'), worker);
console.log(`Built service worker ${version} with ${paths.length} static files.`);
