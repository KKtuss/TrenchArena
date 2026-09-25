import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertSameTerminalResult,
  replayBattle,
  runBattle,
} from '../src/battle';
import {
  ChoiceController,
  MalformedChoiceError,
  StaleChoiceError,
} from '../src/driver';
import {
  FORMAT_ID,
  TEAM_ONE,
  validateAndPackTeam,
} from '../src/teams';

test('validates and packs the fixture team with Showdown', () => {
  const packed = validateAndPackTeam(TEAM_ONE);
  assert.ok(packed.includes('Great Tusk'));
  assert.ok(packed.includes('Gholdengo'));
});

test('rejects an invalid team before a battle starts', () => {
  const invalidTeam = TEAM_ONE.replace('Headlong Rush', 'DefinitelyNotAMove');
  assert.throws(
    () => validateAndPackTeam(invalidTeam),
    /invalid for gen9ou/i,
  );
});

test('rejects malformed and stale choices', () => {
  const controller = new ChoiceController();
  const request = {
    active: [{ moves: [{ disabled: false }] }],
    side: {
      pokemon: [
        { active: true, condition: '100/100' },
        { active: false, condition: '100/100' },
      ],
    },
  };

  const firstRevision = controller.accept(request);
  assert.throws(
    () => controller.submit(firstRevision, 'eval process.exit()'),
    MalformedChoiceError,
  );
  assert.equal(controller.submit(firstRevision, 'move 1'), 'move 1');

  const secondRevision = controller.accept(request);
  assert.notEqual(secondRevision, firstRevision);
  assert.throws(
    () => controller.submit(firstRevision, 'move 1'),
    StaleChoiceError,
  );
});

test('runs a real battle, detects the terminal result, and reproduces it', async () => {
  const result = await runBattle();
  const replay = await replayBattle(result.inputLog);

  assert.equal(result.formatId, FORMAT_ID);
  assert.ok(result.inputLog.length > 0);
  assert.ok(result.eventLog.raw.some(event => event.startsWith('end\n')));
  assert.ok(result.players.p1.choices.length > 0);
  assert.ok(result.players.p2.choices.length > 0);
  assert.ok(result.eventLog.p1.some(event => event.includes('|request|')));
  assert.ok(result.eventLog.p2.some(event => event.includes('|request|')));
  assert.ok(!result.eventLog.spectator.some(event => event.includes('|request|')));
  assert.ok(!result.eventLog.spectator.some(event => event.includes('|split|')));

  assertSameTerminalResult(result.terminal, replay);
});

test('keeps the deterministic player policy reproducible across a seed matrix', async () => {
  for (let index = 0; index < 25; index += 1) {
    const seed = `${index + 10},${index + 20},${index + 30},${index + 40}`;
    const result = await runBattle(seed, 1000);
    const replay = await replayBattle(result.inputLog);
    assertSameTerminalResult(result.terminal, replay);
  }
});
