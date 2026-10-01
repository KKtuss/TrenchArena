import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rotationEvent } from '../lib/tournament-formats';
import {
  ROTATION_SLOT_MS,
  SCHEDULE_SLOT_COUNT,
  buildTournamentSchedule,
} from '../lib/tournament-schedule';

test('the cycle is Casual Gen X, that Gen cup, then Gen 9 OU through Gen 9', () => {
  const cycle = Array.from({ length: 27 }, (_, index) => rotationEvent(index).id);
  assert.deepEqual(cycle.slice(0, 6), [
    'gen1casual',
    'gen1cup',
    'gen9ou',
    'gen2casual',
    'gen2cup',
    'gen9ou',
  ]);
  assert.equal(cycle.filter(id => id === 'gen9ou').length, 9);
  assert.equal(cycle[24], 'gen9casual');
  assert.equal(cycle[25], 'gen9cup');
  assert.equal(cycle[26], 'gen9ou');
  assert.equal(rotationEvent(27).id, 'gen1casual');
  assert.equal(rotationEvent(0).teamMode, 'preset-6-choose-3');
  assert.equal(rotationEvent(1).restriction, 'GEN 1 ONLY');
  assert.equal(rotationEvent(0).pokemon[0], 'Venusaur');
  assert.equal(rotationEvent(3).id, 'gen2casual');
  assert.equal(rotationEvent(3).pokemon[0], 'Typhlosion');
  assert.notEqual(rotationEvent(25).restriction, rotationEvent(26).restriction);
});

test('upcoming tournaments are a 30-minute rotation, not a single generic cup', () => {
  const now = Date.UTC(2026, 0, 1, 0, 7, 0);
  const slots = buildTournamentSchedule([], now);
  assert.equal(slots.length, SCHEDULE_SLOT_COUNT);
  assert.equal(slots[1]!.startsAt - slots[0]!.startsAt, ROTATION_SLOT_MS);
  assert.equal(slots[0]!.kind, 'now');
  assert.equal(slots[0]!.when, 'CURRENT');
  assert.equal(slots[1]!.when, 'NEXT');
  assert.equal(slots[2]!.when, 'LATER');
  assert.equal(slots[1]!.kind, 'next');
  assert.notEqual(slots[0]!.rulesetId, 'unknown');
  const ids = slots.map(slot => slot.rulesetId);
  assert.equal(new Set(ids).size, 19);
  assert.ok(ids.includes('gen1cup'));
  assert.ok(ids.includes('gen9casual'));
  assert.ok(ids.includes('gen9ou'));
});
