const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const appRoot = path.join(__dirname, '..');
const stagingRoot = path.join(os.tmpdir(), 'pokearena-web-build');

function removeDirectory(directory) {
  fs.rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 250,
  });
}

function run(command, args, cwd, { allowRobocopy = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  const code = result.status ?? 1;
  if (allowRobocopy) {
    // robocopy uses 0-7 for success-with-info, >=8 for failure.
    if (code >= 8) process.exit(code);
    return;
  }
  if (code !== 0) process.exit(code);
}

removeDirectory(stagingRoot);
fs.mkdirSync(stagingRoot, { recursive: true });

run('robocopy', [
  appRoot,
  stagingRoot,
  '/E',
  '/XD',
  'node_modules',
  '.next',
  '/NFL',
  '/NDL',
  '/NJH',
  '/NJS',
  '/R:1',
  '/W:1',
], appRoot, { allowRobocopy: true });

run('robocopy', [
  path.join(appRoot, 'node_modules'),
  path.join(stagingRoot, 'node_modules'),
  '/E',
  '/NFL',
  '/NDL',
  '/NJH',
  '/NJS',
  '/R:1',
  '/W:1',
], appRoot, { allowRobocopy: true });

run('node', [path.join(stagingRoot, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'], stagingRoot);

const nextOut = path.join(appRoot, '.next');
try {
  removeDirectory(nextOut);
} catch (error) {
  if (process.platform !== 'win32') throw error;
  console.warn('Could not fully clear .next on Windows; overlaying the staged build.');
}
run('robocopy', [
  path.join(stagingRoot, '.next'),
  nextOut,
  '/E',
  '/NFL',
  '/NDL',
  '/NJH',
  '/NJS',
  '/XF',
  'trace',
  '/R:1',
  '/W:1',
], appRoot, { allowRobocopy: true });

console.log('Next.js build completed via NTFS staging (Windows volume readlink workaround).');
