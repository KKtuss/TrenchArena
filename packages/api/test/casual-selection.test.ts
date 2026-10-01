import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CASUAL_SHOWDOWN_FORMAT_ID,
  CASUAL_TEAM_SIZE,
  sliceTeamText,
  validateAndPackTeam,
} from '@pokearena/battle-engine';

import { CASUAL_PRESETS } from '../src/casual-presets';
import {
  CASUAL_START_COUNTDOWN_MS,
  CasualCustomTeamRejectedError,
  CasualRoomService,
  CasualSelectionError,
} from '../src/casual-service';
import { DEMO_TEAM_ONE, DEMO_TEAM_TWO } from '../src/demo-teams';
import { MockEconomics } from '../src/mock-economics';
import { bothReadyCasual, confirmCasualPicks, openFullCasualRoom } from './casual-flow';

test('curated Casual presets pack as legal Gen 9 OU sixes and sliced threes', () => {
  assert.equal(CASUAL_PRESETS.length, 4);
  for (const preset of CASUAL_PRESETS) {
    assert.equal(preset.pokemon.length, 6);
    assert.ok(preset.paste.includes(preset.pokemon[0]!.species));
    assert.ok(validateAndPackTeam(preset.paste, 'gen9ou'));
    assert.ok(validateAndPackTeam(sliceTeamText(preset.paste, [0, 2, 4]), 'gen9ou', {
      size: CASUAL_TEAM_SIZE,
      showdownFormatId: CASUAL_SHOWDOWN_FORMAT_ID,
    }));
  }
});

test('a match deals one shared six and does not regenerate it', async () => {
  const casual = new CasualRoomService();
  const room = await openFullCasualRoom(casual);
  assert.equal(casual.getRoom(room.id, 'demo-player-1').teamPreview, undefined);
  bothReadyCasual(casual, room.id);
  const creatorView = casual.getRoom(room.id, 'demo-player-1');
  const opponentView = casual.getRoom(room.id, 'demo-player-2');
  const creatorPool = creatorView.teamPreview?.find(item => item.playerId === 'demo-player-1');
  const opponentPool = opponentView.teamPreview?.find(item => item.playerId === 'demo-player-2');
  assert.equal(creatorView.status, 'drafting');
  assert.ok(creatorPool?.presetId);
  assert.equal(creatorPool?.presetId, opponentPool?.presetId);
  assert.equal(
    creatorView.teamPreview?.find(item => item.playerId === 'demo-player-2')?.presetId,
    creatorPool?.presetId,
  );
  assert.deepEqual(
    creatorPool?.pokemon.map(mon => mon.species),
    opponentPool?.pokemon.map(mon => mon.species),
  );
  assert.equal(creatorPool?.pokemon.length, 6);

  casual.selectTeam(room.id, 'demo-player-1', [1, 3], false);
  casual.selectTeam(room.id, 'demo-player-2', [0, 4], false);
  casual.advanceReadyCountdown(room.id, 'demo-player-1');
  const again = casual.getRoom(room.id, 'demo-player-1');
  const refreshed = casual.getRoom(room.id, 'demo-player-2');
  assert.equal(again.teamPreview?.find(item => item.playerId === 'demo-player-1')?.presetId, creatorPool?.presetId);
  assert.equal(refreshed.teamPreview?.find(item => item.playerId === 'demo-player-2')?.presetId, creatorPool?.presetId);
  assert.deepEqual(
    again.teamPreview?.find(item => item.playerId === 'demo-player-1')?.pokemon.map(mon => mon.species),
    creatorPool?.pokemon.map(mon => mon.species),
  );
  assert.deepEqual(again.teamPreview?.find(item => item.playerId === 'demo-player-1')?.selectedSlots, [1, 3]);
  assert.equal(again.teamPreview?.find(item => item.playerId === 'demo-player-2')?.selectedSlots, undefined);
  assert.deepEqual(refreshed.teamPreview?.find(item => item.playerId === 'demo-player-2')?.selectedSlots, [0, 4]);
  assert.equal(refreshed.teamPreview?.find(item => item.playerId === 'demo-player-1')?.selectedSlots, undefined);
});

test('opponent picks stay hidden until both players confirm', async () => {
  const casual = new CasualRoomService();
  const room = await openFullCasualRoom(casual);
  bothReadyCasual(casual, room.id);
  casual.selectTeam(room.id, 'demo-player-1', [0, 2, 4], true);

  const creatorView = casual.getRoom(room.id, 'demo-player-1');
  const opponentView = casual.getRoom(room.id, 'demo-player-2');
  const listed = casual.listOpenRooms('demo-player-2');

  assert.deepEqual(
    creatorView.teamPreview?.find(item => item.playerId === 'demo-player-1')?.selectedSlots,
    [0, 2, 4],
  );
  assert.equal(
    creatorView.teamPreview?.find(item => item.playerId === 'demo-player-2')?.selectedSlots,
    undefined,
  );
  assert.equal(
    opponentView.teamPreview?.find(item => item.playerId === 'demo-player-1')?.selectedSlots,
    undefined,
  );
  assert.equal(opponentView.teamPreview?.find(item => item.playerId === 'demo-player-1')?.confirmed, true);
  assert.equal(listed.find(item => item.id === room.id), undefined);

  confirmCasualPicks(casual, room.id, 'demo-player-2', [1, 3, 5]);
  const bothLocked = casual.getRoom(room.id, 'demo-player-2');
  assert.equal(bothLocked.status, 'drafting');
  assert.equal(
    bothLocked.teamPreview?.find(item => item.playerId === 'demo-player-1')?.selectedSlots,
    undefined,
  );
  const started = await casual.startBattle(room.id, 'demo-player-1');
  assert.deepEqual(
    started.teamPreview?.find(item => item.playerId === 'demo-player-1')?.selectedSlots,
    [0, 2, 4],
  );
  assert.deepEqual(
    started.teamPreview?.find(item => item.playerId === 'demo-player-2')?.selectedSlots,
    [1, 3, 5],
  );
});

test('invalid, duplicate, and premature Casual selections are rejected', async () => {
  const casual = new CasualRoomService();
  const created = await casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'open',
    battleSize: '1v1',
    collateral: 1_000,
  });
  assert.throws(
    () => casual.selectTeam(created.id, 'demo-player-1', [0, 1, 2], true),
    CasualSelectionError,
  );

  const room = await openFullCasualRoom(casual);
  assert.throws(() => casual.selectTeam(room.id, 'demo-player-1', [0, 1, 2], true), /countdown before team selection/);
  assert.throws(
    () => casual.setReady(room.id, 'demo-player-1', true, 'Charizard\nAbility: Blaze\n- Flamethrower'),
    CasualCustomTeamRejectedError,
  );
  bothReadyCasual(casual, room.id);
  assert.throws(() => casual.selectTeam(room.id, 'demo-player-1', [0, 0, 1], true), /unique/);
  assert.throws(() => casual.selectTeam(room.id, 'demo-player-1', [0, 1, 9], true), /between 0 and 5/);
  assert.throws(() => casual.selectTeam(room.id, 'demo-player-1', [0, 1], true), /exactly three/);

  casual.selectTeam(room.id, 'demo-player-1', [0, 1, 2], true);
  assert.throws(
    () => casual.selectTeam(room.id, 'demo-player-1', [0, 1, 3], true),
    /Selection is locked/,
  );
  const same = casual.selectTeam(room.id, 'demo-player-1', [0, 1, 2], true);
  assert.deepEqual(
    same.teamPreview?.find(item => item.playerId === 'demo-player-1')?.selectedSlots,
    [0, 1, 2],
  );
});

test('the Showdown battle starts with exactly the selected three Pokémon', async () => {
  const casual = new CasualRoomService();
  const room = await openFullCasualRoom(casual);
  const creatorSlots = [0, 2, 5] as const;
  const opponentSlots = [1, 3, 4] as const;
  bothReadyCasual(casual, room.id);
  const before = casual.getRoom(room.id, 'demo-player-1');
  const shared = before.teamPreview?.find(item => item.playerId === 'demo-player-1')?.pokemon.map(mon => mon.species);
  assert.deepEqual(
    shared,
    before.teamPreview?.find(item => item.playerId === 'demo-player-2')?.pokemon.map(mon => mon.species),
  );
  const creatorKept = creatorSlots.map(slot => shared?.[slot]);
  const opponentKept = opponentSlots.map(slot => shared?.[slot]);
  confirmCasualPicks(casual, room.id, 'demo-player-1', creatorSlots);
  confirmCasualPicks(casual, room.id, 'demo-player-2', opponentSlots);
  const started = await casual.startBattle(room.id, 'demo-player-1');
  const view = casual.getMatchView(started.matchId, 'demo-player-1');
  const creatorSide = view?.sides.find(side => side.playerId === 'demo-player-1');
  const opponentSide = view?.sides.find(side => side.playerId === 'demo-player-2');
  assert.deepEqual(creatorSide?.party.map(mon => mon.species), creatorKept);
  assert.deepEqual(opponentSide?.party.map(mon => mon.species), opponentKept);
  assert.equal(creatorSide?.party.length, 3);
  assert.equal(opponentSide?.party.length, 3);
});

test('Casual presets stay hidden until the ready countdown deals them', async () => {
  const casual = new CasualRoomService();
  const created = await casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'open',
    battleSize: '1v1',
    collateral: 1_000,
  });
  assert.equal(created.teamPreview, undefined);
  assert.equal(casual.getRoom(created.id, 'demo-player-1').teamPreview, undefined);

  const accepted = await casual.acceptRoom(created.id, 'demo-player-2');
  const creatorView = casual.getRoom(created.id, 'demo-player-1');
  const listed = casual.listOpenRooms('spectator');
  assert.equal(accepted.teamPreview, undefined);
  assert.equal(creatorView.teamPreview, undefined);
  assert.equal(listed.find(item => item.id === created.id)?.teamPreview, undefined);

  bothReadyCasual(casual, created.id);
  const dealt = casual.getRoom(created.id, 'demo-player-1');
  assert.ok(dealt.teamPreview?.find(item => item.playerId === 'demo-player-1'));
  assert.equal(
    casual.getRoom(created.id, 'demo-player-1').teamPreview?.find(item => item.playerId === 'demo-player-1')?.presetId,
    dealt.teamPreview?.find(item => item.playerId === 'demo-player-1')?.presetId,
  );
});

test('both ready start a five-second countdown that unready can abort', async () => {
  let now = 1_700_000_000_000;
  const casual = new CasualRoomService({ now: () => now, countdownMs: CASUAL_START_COUNTDOWN_MS });
  const room = await openFullCasualRoom(casual);
  bothReadyCasual(casual, room.id);
  const locked = casual.getRoom(room.id, 'demo-player-1');
  assert.equal(locked.status, 'ready');
  assert.equal(locked.teamPreview, undefined);
  assert.equal(locked.countdownEndsAt, now + CASUAL_START_COUNTDOWN_MS);

  casual.setReady(room.id, 'demo-player-1', false);
  const aborted = casual.getRoom(room.id, 'demo-player-1');
  assert.equal(aborted.status, 'full');
  assert.equal(aborted.countdownEndsAt, undefined);
  assert.equal(aborted.teamPreview, undefined);

  bothReadyCasual(casual, room.id);
  now += CASUAL_START_COUNTDOWN_MS;
  const dealt = casual.advanceReadyCountdown(room.id, 'demo-player-1');
  assert.equal(dealt.status, 'drafting');
  assert.ok(dealt.teamPreview?.length);
  assert.equal(dealt.countdownEndsAt, undefined);

  confirmCasualPicks(casual, room.id, 'demo-player-1');
  confirmCasualPicks(casual, room.id, 'demo-player-2');
  const started = await casual.startBattle(room.id, 'demo-player-1');
  assert.equal(started.status, 'battling');
  assert.equal(started.countdownEndsAt, undefined);
});

test('a shared-pool casual forfeit still pays the existing wager', async () => {
  const economics = new MockEconomics();
  const casual = new CasualRoomService({ economics, allowDemoAuth: true, countdownMs: 0 });
  const room = await openFullCasualRoom(casual, 'demo-player-1', 'demo-player-2', 100_000);
  bothReadyCasual(casual, room.id);
  confirmCasualPicks(casual, room.id, 'demo-player-1', [0, 1, 2]);
  confirmCasualPicks(casual, room.id, 'demo-player-2', [3, 4, 5]);
  await casual.startBattle(room.id, 'demo-player-1');
  const settled = await casual.forfeit(room.id, 'demo-player-2');
  assert.equal(settled.status, 'completed');
  assert.equal(settled.winnerId, 'demo-player-1');
  assert.equal(settled.payout?.amount, 196_000);
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000 - 100_000 + 196_000);
  assert.equal(economics.getBalance('demo-player-2'), 10_000_000 - 100_000);
});

test('competitive rooms do not use the casual shared pool', async () => {
  const casual = new CasualRoomService({ allowDemoAuth: true, countdownMs: 0 });
  const room = await openFullCasualRoom(casual, 'demo-player-1', 'demo-player-2', 1_000, 'competitive');
  casual.setReady(room.id, 'demo-player-1', true, DEMO_TEAM_ONE);
  casual.setReady(room.id, 'demo-player-2', true, DEMO_TEAM_TWO);
  const ready = casual.getRoom(room.id, 'demo-player-1');
  const rival = casual.getRoom(room.id, 'demo-player-2');
  assert.equal(ready.ruleset, 'competitive');
  assert.equal(ready.teamPreview, undefined);
  assert.equal(rival.teamPreview, undefined);
  assert.notEqual(ready.status, 'drafting');
});

test('a selection timeout locks unfinished trios without revealing them', async () => {
  let now = 1_700_000_000_000;
  const casual = new CasualRoomService({
    now: () => now,
    countdownMs: 0,
    selectionMs: 90_000,
  });
  const room = await openFullCasualRoom(casual);
  bothReadyCasual(casual, room.id);
  casual.selectTeam(room.id, 'demo-player-1', [5], false);
  const open = casual.getRoom(room.id, 'demo-player-2');
  assert.equal(open.selectionEndsAt, now + 90_000);
  assert.equal(open.teamPreview?.find(item => item.playerId === 'demo-player-1')?.selectedSlots, undefined);
  assert.throws(() => casual.sealSelection(room.id), /still running/);
  now += 90_000;
  const sealed = casual.sealSelection(room.id, 'demo-player-1');
  const yours = sealed.teamPreview?.find(item => item.playerId === 'demo-player-1');
  const rival = casual.getRoom(room.id, 'demo-player-2').teamPreview?.find(item => item.playerId === 'demo-player-1');
  assert.equal(yours?.confirmed, true);
  assert.deepEqual(yours?.selectedSlots, [5, 0, 1]);
  assert.equal(rival?.confirmed, true);
  assert.equal(rival?.selectedSlots, undefined);
});
