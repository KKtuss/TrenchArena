/**
 * Run corruption campaign outside node:test to avoid LiteSVM teardown aborts.
 * Usage: POKEARENA_CORRUPT_IMPL=anchor POKEARENA_CORRUPT_KIND=Config node scripts/_run_corrupt_impl.mjs
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dirname, '../package.json'));

// Execute compiled test body by registering then invoking campaign via child that exits hard.
const impl = process.env.POKEARENA_CORRUPT_IMPL || 'pinocchio';
const kind = process.env.POKEARENA_CORRUPT_KIND || '';
const cases = process.env.POKEARENA_CORRUPT_CASES || '80';
const seed = process.env.POKEARENA_HARDENING_SEED || '1347373893';

const runner = `
const assert = require('assert/strict');
process.env.POKEARENA_CORRUPT_IMPL = ${JSON.stringify(impl)};
process.env.POKEARENA_CORRUPT_KIND = ${JSON.stringify(kind)};
process.env.POKEARENA_CORRUPT_CASES = ${JSON.stringify(cases)};
process.env.POKEARENA_HARDENING_SEED = ${JSON.stringify(seed)};
// Load compiled module; pull runCampaign by evaluating after patching test harness.
const Module = require('module');
const orig = Module.prototype.require;
let campaignFn = null;
Module.prototype.require = function(id) {
  const m = orig.apply(this, arguments);
  return m;
};
// Intercept node:test to capture the test callback
const testMod = require('node:test');
const realTest = testMod;
require.cache[require.resolve('node:test')].exports = function(name, fn) {
  const cb = typeof name === 'function' ? name : fn;
  // run immediately
  Promise.resolve(cb({ skip: () => {} })).then(() => process.exit(0)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
};
require.cache[require.resolve('node:test')].exports.skip = () => {};
require('../dist/test/hardening-corrupt-fuzz.js');
`;

const r = spawnSync(process.execPath, ['-e', runner], {
  cwd: join(__dirname, '..'),
  env: process.env,
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
