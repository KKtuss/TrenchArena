import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = path.join(appRoot, 'lib', 'trainer-sprites.json');
const SOURCE = 'https://play.pokemonshowdown.com/sprites/trainers/';

function displayName(id) {
  return id
    .replace(/-gen(\d+)/g, ' Gen $1')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

const html = await (await fetch(SOURCE)).text();
const entries = [];
const figureRe =
  /<figure[^>]*>[\s\S]*?<figcaption>\s*<a href="([^"]+\.png)">([^<]*)<\/a>(?:<br\s*\/?>(?:\s*)by\s+([^<]+))?/gi;
let match;
while ((match = figureRe.exec(html))) {
  const file = match[1].split('/').pop();
  if (!file?.endsWith('.png')) continue;
  const id = file.replace(/\.png$/i, '');
  entries.push({
    id,
    file,
    name: displayName(id),
    credit: match[3] ? match[3].trim() : null,
    source: `${SOURCE}${file}`,
  });
}
entries.sort((a, b) => a.id.localeCompare(b.id));
await fs.writeFile(catalogPath, `${JSON.stringify(entries, null, 2)}\n`);
const credited = entries.filter(e => e.credit).length;
console.log(`Wrote ${entries.length} trainers (${credited} with credits) to ${catalogPath}`);
