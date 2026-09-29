#!/usr/bin/env node
/**
 * Fetch Pokémon Showdown trainer sprites + credits into the local web bundle.
 * Usage: node scripts/fetch-trainers.mjs
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const trainersDir = path.join(appRoot, 'public', 'showdown', 'sprites', 'trainers');
const catalogPath = path.join(appRoot, 'lib', 'trainer-sprites.json');
const SOURCE = 'https://play.pokemonshowdown.com/sprites/trainers/';
const INDEX = SOURCE;

function displayName(id) {
  return id
    .replace(/-gen(\d+)/g, ' Gen $1')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function parseIndex(html) {
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
  if (entries.length < 50) {
    const plain = [...html.matchAll(/href="((?:[^"]+\/)?([a-z0-9-]+)\.png)"/gi)];
    const seen = new Set(entries.map(e => e.id));
    for (const item of plain) {
      const id = item[2];
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push({
        id,
        file: `${id}.png`,
        name: displayName(id),
        credit: null,
        source: `${SOURCE}${id}.png`,
      });
    }
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

async function download(entry) {
  const target = path.join(trainersDir, entry.file);
  try {
    await fs.access(target);
    return 'exists';
  } catch {
    // continue
  }
  const response = await fetch(entry.source);
  if (!response.ok) throw new Error(`Failed ${entry.source}: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(target, buffer);
  return 'downloaded';
}

await fs.mkdir(trainersDir, { recursive: true });
const indexHtml = await (await fetch(INDEX)).text();
let entries = parseIndex(indexHtml);

// Showdown sometimes serves a JS-built page; scrape text nodes as backup.
if (entries.length < 100) {
  const textEntries = [];
  for (const line of indexHtml.split(/\n|<br\s*\/?>/i)) {
    const clean = line.replace(/<[^>]+>/g, '').trim();
    if (!clean) continue;
    const creditMatch = clean.match(/^([a-z0-9-]+)(?:\s+by\s+(.+))?$/i);
    if (!creditMatch) continue;
    const id = creditMatch[1].toLowerCase();
    textEntries.push({
      id,
      file: `${id}.png`,
      name: displayName(id),
      credit: creditMatch[2]?.trim() ?? null,
      source: `${SOURCE}${id}.png`,
    });
  }
  if (textEntries.length > entries.length) entries = textEntries;
}

console.log(`Catalogued ${entries.length} trainer sprites.`);
let downloaded = 0;
let skipped = 0;
let failed = 0;
const concurrency = 12;
for (let i = 0; i < entries.length; i += concurrency) {
  const batch = entries.slice(i, i + concurrency);
  const results = await Promise.allSettled(batch.map(download));
  for (const result of results) {
    if (result.status === 'fulfilled') {
      if (result.value === 'downloaded') downloaded += 1;
      else skipped += 1;
    } else {
      failed += 1;
      console.error(result.reason);
    }
  }
  process.stdout.write(`\rFetched ${Math.min(i + concurrency, entries.length)}/${entries.length}`);
}
console.log(`\nDone. downloaded=${downloaded} skipped=${skipped} failed=${failed}`);

await fs.writeFile(catalogPath, `${JSON.stringify(entries, null, 2)}\n`);
console.log(`Wrote catalog ${catalogPath}`);
