import assert from 'node:assert/strict';
import test from 'node:test';

import { clamp01, easeOutCubic, hpScale, lerp } from '../lib/motion';

test('lerp finishes on the authoritative target', () => {
  assert.equal(lerp(10, 40, 0), 10);
  assert.equal(lerp(10, 40, 1), 40);
  assert.equal(lerp(40, 10, 1), 10);
});

test('ease stays inside the unit interval', () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.ok(easeOutCubic(0.5) > 0.5);
});

test('hp scale clamps the bar without changing a caller percent', () => {
  assert.equal(hpScale(0), 0);
  assert.equal(hpScale(50), 0.5);
  assert.equal(hpScale(100), 1);
  assert.equal(hpScale(140), 1);
  assert.equal(hpScale(Number.NaN), 0);
});
