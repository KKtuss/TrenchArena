import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CasualRoomService } from '../src/casual-service';
import { ApiServer } from '../src/server';
import { bothReadyCasual, confirmCasualPicks, openFullCasualRoom } from './casual-flow';

test('a pinned pair is dealt instead of a random pair', async () => {
  const casual = new CasualRoomService({ allowDemoAuth: true, countdownMs: 0 });
  const room = await openFullCasualRoom(casual);
  const pinned = casual.pinPlaytestPresets(room.id, 'classic', 'kanto');
  assert.deepEqual(pinned, {
    roomId: room.id,
    creatorPresetId: 'classic-balance',
    opponentPresetId: 'kanto-johto-classics',
  });
  bothReadyCasual(casual, room.id);
  const dealt = casual.getRoom(room.id, 'demo-player-1');
  assert.equal(dealt.teamPreview?.find(item => item.playerId === 'demo-player-1')?.presetId, 'classic-balance');
  assert.equal(dealt.teamPreview?.find(item => item.playerId === 'demo-player-2')?.presetId, 'kanto-johto-classics');
});

test('a pin is refused after the draft is dealt and when demo auth is off', async () => {
  const casual = new CasualRoomService({ allowDemoAuth: true, countdownMs: 0 });
  const room = await openFullCasualRoom(casual);
  bothReadyCasual(casual, room.id);
  assert.throws(
    () => casual.pinPlaytestPresets(room.id, 'modern', 'rival'),
    /before both players ready/,
  );

  const locked = new CasualRoomService({ allowDemoAuth: false, countdownMs: 0 });
  const other = await openFullCasualRoom(locked);
  assert.throws(
    () => locked.pinPlaytestPresets(other.id, 'modern', 'rival'),
    /development server/,
  );
});

test('the playtest log keeps the locked trio, click order, and whether it changed', async () => {
  let clock = 1_000;
  const casual = new CasualRoomService({
    allowDemoAuth: true,
    countdownMs: 0,
    now: () => clock,
  });
  const room = await openFullCasualRoom(casual);
  casual.pinPlaytestPresets(room.id, 'modern', 'rival');
  bothReadyCasual(casual, room.id);

  clock = 2_000;
  casual.selectTeam(room.id, 'demo-player-1', [0, 2, 5], false);
  clock = 5_000;
  casual.selectTeam(room.id, 'demo-player-1', [0, 2, 4], true);
  casual.selectTeam(room.id, 'demo-player-2', [2, 4, 0], true);
  casual.notePlaytestReasons(room.id, 'demo-player-2', 'speed,guess');

  const match = casual.playtestReport().matches[0];
  assert.ok(match);
  assert.equal(match.status, 'selecting');
  assert.deepEqual(match.playerA.species, ['Dragonite', 'Azumarill', 'Lycanroc']);
  assert.equal(match.playerA.confirmedWithoutChange, false);
  assert.equal(match.playerA.previewToLockMs, 4_000);
  assert.deepEqual(match.playerB.species, ['Greninja', 'Jolteon', 'Dragonite']);
  assert.deepEqual(match.playerB.slots, [2, 4, 0]);
  assert.equal(match.playerB.confirmedWithoutChange, true);
  assert.deepEqual(match.playerB.reasons, ['speed', 'guessed opponent choice']);
  assert.match(casual.playtestReport().text, /MATCHUP modern-classics vs rivals-team/);
  assert.match(casual.playtestReport().text, /PLAYER B TRIO Greninja, Jolteon, Dragonite/);
});

test('a finished casual battle records the winner, forfeit, and duration', async () => {
  const casual = new CasualRoomService({ allowDemoAuth: true, countdownMs: 0 });
  const room = await openFullCasualRoom(casual);
  casual.pinPlaytestPresets(room.id, 'classic', 'modern');
  bothReadyCasual(casual, room.id);
  confirmCasualPicks(casual, room.id, 'demo-player-1', [3, 2, 4]);
  confirmCasualPicks(casual, room.id, 'demo-player-2', [0, 5, 2]);
  await casual.startBattle(room.id, 'demo-player-1');
  await casual.forfeit(room.id, 'demo-player-1');

  const match = casual.playtestReport().matches[0];
  assert.ok(match);
  assert.equal(match.status, 'completed');
  assert.equal(match.playerA.presetId, 'classic-balance');
  assert.deepEqual(match.playerA.species, ['Lucario', 'Gengar', 'Mamoswine']);
  assert.equal(match.playerB.presetId, 'modern-classics');
  assert.deepEqual(match.playerB.species, ['Dragonite', 'Arcanine', 'Azumarill']);
  assert.equal(match.winnerId, 'demo-player-2');
  assert.equal(match.loserId, 'demo-player-1');
  assert.equal(match.endReason, 'forfeit');
  assert.equal(match.result, 'win');
  assert.equal(typeof match.durationMs, 'number');
  assert.ok((match.durationMs ?? -1) >= 0);
});

test('dev playtest routes pin a room and stay closed without demo auth', async () => {
  const server = new ApiServer({ allowDemoAuth: true, countdownMs: 0 });
  const closed = new ApiServer({ allowDemoAuth: false, countdownMs: 0 });
  const port = await server.listen(0);
  const closedPort = await closed.listen(0);
  try {
    const room = await openFullCasualRoom(server.casual);
    const pinned = await fetch(`http://127.0.0.1:${port}/dev/playtest/pair?roomId=${room.id}&a=kanto&b=rival`);
    assert.equal(pinned.status, 200);
    const pinBody = await pinned.json() as { creatorPresetId: string; opponentPresetId: string };
    assert.equal(pinBody.creatorPresetId, 'kanto-johto-classics');
    assert.equal(pinBody.opponentPresetId, 'rivals-team');

    bothReadyCasual(server.casual, room.id);
    const report = await fetch(`http://127.0.0.1:${port}/dev/playtest`);
    assert.equal(report.status, 200);
    const body = await report.json() as { text: string };
    assert.match(body.text, /MATCHUP kanto-johto-classics vs rivals-team/);

    const hidden = await fetch(`http://127.0.0.1:${closedPort}/dev/playtest`);
    assert.equal(hidden.status, 404);
  } finally {
    await server.close();
    await closed.close();
  }
});
