import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { contentSecurityPolicy, securityHeaders } from '../lib/security-headers.js';

test('production CSP is same-origin, has no wildcards, and skips unsafe-eval', () => {
  const previousWs = process.env.NEXT_PUBLIC_WS_URL;
  delete process.env.NEXT_PUBLIC_WS_URL;
  try {
    const csp = contentSecurityPolicy('production');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self' 'unsafe-inline'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /img-src 'self' data: https:\/\/play\.pokemonshowdown\.com/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(csp.includes('*'), false);
    assert.equal(csp.includes('unsafe-eval'), false);
    assert.equal(csp.includes('wss:'), false);
    const headers = securityHeaders() as Array<{ key: string; value: string }>;
    const keys = headers.map(header => header.key);
    assert.deepEqual(
      keys.includes('Content-Security-Policy')
        && keys.includes('X-Content-Type-Options')
        && keys.includes('Referrer-Policy')
        && keys.includes('X-Frame-Options'),
      true,
    );
    assert.equal(
      headers.find(header => header.key === 'Cross-Origin-Opener-Policy'),
      undefined,
    );
  } finally {
    if (previousWs === undefined) delete process.env.NEXT_PUBLIC_WS_URL;
    else process.env.NEXT_PUBLIC_WS_URL = previousWs;
  }
});

test('CSP connect-src includes an explicit WebSocket origin when configured', () => {
  const previous = process.env.NEXT_PUBLIC_WS_URL;
  process.env.NEXT_PUBLIC_WS_URL = 'wss://pokearena.example/ws';
  try {
    const csp = contentSecurityPolicy();
    assert.match(csp, /connect-src 'self' wss:\/\/pokearena\.example/);
    assert.equal(csp.includes('*'), false);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_WS_URL;
    else process.env.NEXT_PUBLIC_WS_URL = previous;
  }
});

test('Showdown ships jQuery 3.7.1 instead of 1.11.0', () => {
  const lib = path.join(process.cwd(), 'public', 'showdown', 'js', 'lib');
  const current = readFileSync(path.join(lib, 'jquery-3.7.1.min.js'), 'utf8');
  assert.match(current, /jQuery v3\.7\.1/);
  assert.equal(existsSync(path.join(lib, 'jquery-1.11.0.min.js')), false);
});
