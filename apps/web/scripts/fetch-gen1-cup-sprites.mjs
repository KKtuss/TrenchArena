#!/usr/bin/env node
/**
 * Fetch Gen 1 emblematic sprites and punch black backgrounds to alpha.
 * Usage: node scripts/fetch-gen1-cup-sprites.mjs
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(appRoot, 'public', 'showdown', 'sprites', 'gen1');
const trainerDir = path.join(appRoot, 'public', 'showdown', 'sprites', 'trainers');
const BASE = 'https://play.pokemonshowdown.com/sprites/gen1/';

const SPECIES = [
  'pikachu',
  'charizard',
  'blastoise',
  'venusaur',
  'mewtwo',
  'mew',
  'gyarados',
  'snorlax',
  'eevee',
  'articuno',
  'zapdos',
  'moltres',
  'dragonite',
  'gengar',
  'alakazam',
];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buf) {
  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let palette = null;
  let trans = null;
  const idats = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    offset += 4;
    const type = buf.toString('ascii', offset, offset + 4);
    offset += 4;
    const data = buf.subarray(offset, offset + len);
    offset += len + 4;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trans = data;
    else if (type === 'IDAT') idats.push(data);
  }
  return {
    width,
    height,
    bitDepth,
    colorType,
    palette,
    trans,
    inflated: zlib.inflateSync(Buffer.concat(idats)),
  };
}

function toRgba(png) {
  const {
    width: w,
    height: h,
    bitDepth,
    colorType,
    palette,
    trans,
    inflated,
  } = png;
  const samplesPerPixel = colorType === 3
    ? 1
    : colorType === 2
      ? 3
      : colorType === 6
        ? 4
        : null;
  if (samplesPerPixel == null) throw new Error(`unsupported colorType ${colorType}`);
  const stride = Math.ceil((w * samplesPerPixel * bitDepth) / 8);
  let pos = 0;
  let prev = Buffer.alloc(stride);
  const rows = [];
  for (let y = 0; y < h; y++) {
    const filter = inflated[pos++];
    const raw = Buffer.alloc(stride);
    const bpp = Math.max(1, Math.ceil((samplesPerPixel * bitDepth) / 8));
    for (let i = 0; i < stride; i++) {
      const x = inflated[pos++];
      const left = i >= bpp ? raw[i - bpp] : 0;
      const up = prev[i];
      const upleft = i >= bpp ? prev[i - bpp] : 0;
      let val = x;
      if (filter === 1) val = (x + left) & 255;
      else if (filter === 2) val = (x + up) & 255;
      else if (filter === 3) val = (x + ((left + up) >> 1)) & 255;
      else if (filter === 4) val = (x + paeth(left, up, upleft)) & 255;
      else if (filter !== 0) throw new Error(`filter ${filter}`);
      raw[i] = val;
    }
    rows.push(raw);
    prev = raw;
  }

  const getSample = (row, sampleIndex) => {
    if (bitDepth === 8) return row[sampleIndex];
    if (bitDepth === 4) {
      const byte = row[sampleIndex >> 1];
      return (sampleIndex & 1) ? (byte & 0xf) : (byte >> 4);
    }
    throw new Error(`bitDepth ${bitDepth}`);
  };

  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let r;
      let g;
      let b;
      let a = 255;
      if (colorType === 3) {
        const idx = getSample(rows[y], x);
        r = palette[idx * 3];
        g = palette[idx * 3 + 1];
        b = palette[idx * 3 + 2];
        if (trans && idx < trans.length) a = trans[idx];
      } else if (colorType === 2) {
        const s = x * 3;
        r = rows[y][s];
        g = rows[y][s + 1];
        b = rows[y][s + 2];
      } else {
        const s = x * 4;
        r = rows[y][s];
        g = rows[y][s + 1];
        b = rows[y][s + 2];
        a = rows[y][s + 3];
      }
      if (r < 14 && g < 14 && b < 14) a = 0;
      rgba[i * 4] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = a;
    }
  }
  return { w, h, rgba };
}

function encodeRgbaPng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function writeTransparent(target, sourceBuf) {
  const { w, h, rgba } = toRgba(decodePng(sourceBuf));
  await fs.writeFile(target, encodeRgbaPng(w, h, rgba));
}

await fs.mkdir(outDir, { recursive: true });
let ok = 0;
for (const id of SPECIES) {
  const file = `${id}.png`;
  const target = path.join(outDir, file);
  const response = await fetch(`${BASE}${file}`);
  if (!response.ok) {
    console.error(`fail ${file}: ${response.status}`);
    continue;
  }
  await writeTransparent(target, Buffer.from(await response.arrayBuffer()));
  console.log(`got ${file}`);
  ok += 1;
}

const redTarget = path.join(trainerDir, 'red-gen1.png');
const redRes = await fetch('https://play.pokemonshowdown.com/sprites/trainers/red-gen1.png');
if (redRes.ok) {
  await writeTransparent(redTarget, Buffer.from(await redRes.arrayBuffer()));
  console.log('got red-gen1.png');
}

console.log(`Gen 1 cup sprites ready (${ok}/${SPECIES.length}).`);
