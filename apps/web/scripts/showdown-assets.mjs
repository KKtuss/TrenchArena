import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetRoot = path.join(appRoot, 'public', 'showdown');
const manifestPath = path.join(assetRoot, 'assets.sha256.json');
const ignored = new Set(['assets.sha256.json']);

async function filesUnder(directory, prefix = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await filesUnder(absolute, relative));
    } else if (!ignored.has(relative.replaceAll('\\', '/'))) {
      files.push(relative.replaceAll('\\', '/'));
    }
  }
  return files;
}

async function hashFile(relative) {
  const content = await fs.readFile(path.join(assetRoot, relative));
  return createHash('sha256').update(content).digest('hex');
}

const files = (await filesUnder(assetRoot)).sort();
const manifest = Object.fromEntries(
  await Promise.all(files.map(async relative => [relative, await hashFile(relative)])),
);

if (process.argv.includes('--write')) {
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${files.length} Showdown asset hashes.`);
  process.exit(0);
}

const expected = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const expectedNames = Object.keys(expected).sort();
if (expectedNames.join('\n') !== files.join('\n')) {
  throw new Error('Showdown asset manifest file list differs; run this script with --write intentionally.');
}
for (const relative of files) {
  if (manifest[relative] !== expected[relative]) {
    throw new Error(`Showdown asset hash mismatch: ${relative}`);
  }
}
console.log(`Verified ${files.length} local Showdown assets.`);
