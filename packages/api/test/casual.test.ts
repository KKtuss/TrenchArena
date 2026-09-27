import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CasualNotReadyError,
  CasualRoomService,
  CasualTeamRequiredError,
} from '../src/casual-service';
import { DEMO_TEAM_ONE, DEMO_TEAM_TWO } from '../src/demo-teams';
import { MockEconomics } from '../src/mock-economics';

test('casual rooms support private/open creation, accept, full-room and over-balance rejection', async () => {
  const economics = new MockEconomics();
  const casual = new CasualRoomService({ economics });

  const open = await casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'open',
    battleSize: '1v1',
    collateral: 50_000,
  });
  assert.equal(open.status, 'open');
  assert.equal(casual.listOpenRooms().length, 1);

  const accepted = await casual.acceptRoom(open.id, 'demo-player-2');
  assert.equal(accepted.status, 'full');
  await assert.rejects(() => casual.acceptRoom(open.id, 'demo-player-1'));

  await assert.rejects(() => casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'open',
    battleSize: '1v1',
    collateral: 99_000_000,
  }));

  const privateRoom = await casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'private',
    battleSize: '1v1',
    collateral: 25_000,
    invitedPlayerId: 'demo-player-2',
  });
  await assert.rejects(() => casual.acceptRoom(privateRoom.id, 'demo-player-1'));
});

test('2v2 rooms can be configured but start is unsupported', async () => {
  const casual = new CasualRoomService();
  const room = await casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'open',
    battleSize: '2v2',
    collateral: 10_000,
  });
  await casual.acceptRoom(room.id, 'demo-player-2');
  casual.setReady(room.id, 'demo-player-1', true);
  casual.setReady(room.id, 'demo-player-2', true);
  await assert.rejects(
    () => casual.startBattle(room.id, 'demo-player-1'),
    /2v2 battles are not supported/,
  );
  assert.equal(casual.getRoom(room.id).battleSize, '2v2');
});

test('casual 1v1 starts a real BattleEngine session and settles mock payout', async () => {
  const economics = new MockEconomics();
  const casual = new CasualRoomService({ economics, allowDemoAuth: true });
  const room = await casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'open',
    battleSize: '1v1',
    collateral: 100_000,
  });
  await casual.acceptRoom(room.id, 'demo-player-2');
  casual.setReady(room.id, 'demo-player-1', true);
  casual.setReady(room.id, 'demo-player-2', true);
  const started = await casual.startBattle(room.id, 'demo-player-1');
  assert.equal(started.status, 'battling');
  assert.ok(started.battleInstanceId);

  const state1 = casual.getMatchState(started.matchId, 'demo-player-1');
  const state2 = casual.getMatchState(started.matchId, 'demo-player-2');
  assert.equal(state1?.request?.playerId, 'demo-player-1');
  assert.equal(state2?.request?.playerId, 'demo-player-2');
  assert.ok(casual.getMatchView(started.matchId, 'demo-player-1'));

  for (let step = 0; step < 1000; step += 1) {
    const current = casual.getRoom(room.id);
    if (current.status === 'completed') break;

    let submitted = false;
    for (const playerId of ['demo-player-1', 'demo-player-2'] as const) {
      const state = casual.getMatchState(started.matchId, playerId);
      const choice = state?.request?.choices[0];
      if (!state?.request || !choice) continue;
      await casual.submitChoice({
        matchId: started.matchId,
        battleInstanceId: started.battleInstanceId!,
        playerId,
        revision: state.request.revision,
        choice: choice.type === 'move'
          ? { type: 'move', slot: choice.slot }
          : choice.type === 'switch'
            ? { type: 'switch', slot: choice.slot }
            : { type: choice.type as 'team-preview' | 'pass' },
      });
      submitted = true;
    }
    if (!submitted) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  for (let settle = 0; settle < 50 && casual.getRoom(room.id).status !== 'completed'; settle += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }

  const completed = casual.getRoom(room.id);
  assert.equal(completed.status, 'completed');
  assert.ok(completed.payout?.mocked);
  assert.ok(completed.result);
});

test('forfeiting a live casual fight pays the opponent and ends the match', async () => {
  const economics = new MockEconomics();
  const casual = new CasualRoomService({ economics, allowDemoAuth: true });
  const room = await casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'open',
    battleSize: '1v1',
    collateral: 1_000,
  });
  await casual.acceptRoom(room.id, 'demo-player-2');
  casual.setReady(room.id, 'demo-player-1', true);
  casual.setReady(room.id, 'demo-player-2', true);
  const started = await casual.startBattle(room.id, 'demo-player-1');
  const balanceBefore = economics.getWallet('demo-player-1').balance;

  const settled = await casual.forfeit(room.id, 'demo-player-2');

  assert.equal(settled.status, 'completed');
  assert.equal(settled.winnerId, 'demo-player-1');
  assert.equal(settled.payout?.reason, 'casual-forfeit');
  assert.ok(economics.getWallet('demo-player-1').balance > balanceBefore);
  assert.equal(casual.getRoom(started.id).status, 'completed');
});

test('a locked Gen 9 OU paste is the team that enters the casual battle', async () => {
  const casual = new CasualRoomService({ allowDemoAuth: true });
  const room = await casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'open',
    battleSize: '1v1',
    collateral: 10_000,
  });
  await casual.acceptRoom(room.id, 'demo-player-2');
  assert.throws(
    () => casual.setReady(room.id, 'demo-player-1', true, 'Pikachu\nAbility: Static\n- Splash'),
    /valid Pokémon sets/,
  );
  casual.setReady(room.id, 'demo-player-1', true, DEMO_TEAM_TWO);
  casual.setReady(room.id, 'demo-player-2', true);
  const started = await casual.startBattle(room.id, 'demo-player-1');
  const events = casual.getMatchEvents(started.matchId, 'demo-player-1');
  const text = JSON.stringify(events);
  assert.match(text, /Samurott/);
  assert.doesNotMatch(text, /Great Tusk/);
});

async function openCasualRoom(casual: CasualRoomService, creatorId = 'demo-player-1', opponentId = 'demo-player-2') {
  const room = await casual.createRoom({
    creatorId,
    roomType: 'open',
    battleSize: '1v1',
    collateral: 1_000,
  });
  await casual.acceptRoom(room.id, opponentId);
  return room;
}

test('a full casual room cannot start until both players are ready', async () => {
  const economics = new MockEconomics();
  const casual = new CasualRoomService({ economics });
  const room = await openCasualRoom(casual);
  const before = economics.getBalance('demo-player-1');

  await assert.rejects(() => casual.startBattle(room.id, 'demo-player-1'), CasualNotReadyError);
  assert.equal(casual.getRoom(room.id).status, 'full');
  assert.equal(economics.getBalance('demo-player-1'), before);

  casual.setReady(room.id, 'demo-player-1', true, DEMO_TEAM_ONE);
  await assert.rejects(() => casual.startBattle(room.id, 'demo-player-1'), CasualNotReadyError);
  assert.equal(casual.getRoom(room.id).status, 'full');

  casual.setReady(room.id, 'demo-player-1', false);
  casual.setReady(room.id, 'demo-player-2', true, DEMO_TEAM_TWO);
  await assert.rejects(() => casual.startBattle(room.id, 'demo-player-2'), CasualNotReadyError);
  assert.equal(casual.getRoom(room.id).status, 'full');
  assert.equal(economics.getBalance('demo-player-2'), before);
});

test('both players must lock a valid team before a casual battle starts', async () => {
  const economics = new MockEconomics();
  const casual = new CasualRoomService({ economics });
  const room = await openCasualRoom(casual);

  casual.setReady(room.id, 'demo-player-1', true, DEMO_TEAM_ONE);
  casual.setReady(room.id, 'demo-player-2', true);
  assert.equal(casual.getRoom(room.id).status, 'ready');
  const before = economics.getBalance('demo-player-1');
  await assert.rejects(() => casual.startBattle(room.id, 'demo-player-1'), CasualTeamRequiredError);
  assert.equal(casual.getRoom(room.id).status, 'ready');
  assert.equal(economics.getBalance('demo-player-1'), before);
  assert.equal(economics.getBalance('demo-player-2'), before);

  const missingCreator = await openCasualRoom(casual);
  casual.setReady(missingCreator.id, 'demo-player-1', true);
  casual.setReady(missingCreator.id, 'demo-player-2', true, DEMO_TEAM_TWO);
  await assert.rejects(() => casual.startBattle(missingCreator.id, 'demo-player-2'), CasualTeamRequiredError);
  assert.notEqual(casual.getRoom(missingCreator.id).status, 'battling');
});

test('both ready players with locked teams can start a casual battle', async () => {
  const casual = new CasualRoomService();
  const room = await openCasualRoom(casual);
  casual.setReady(room.id, 'demo-player-1', true, DEMO_TEAM_ONE);
  casual.setReady(room.id, 'demo-player-2', true, DEMO_TEAM_TWO);
  const started = await casual.startBattle(room.id, 'demo-player-1');
  assert.equal(started.status, 'battling');
  assert.ok(started.battleInstanceId);
});

test('a wallet player never receives an implicit demo team', async () => {
  const economics = new MockEconomics({ devFaucet: true });
  const creatorId = 'WalletCreator111111111111111111111111';
  const opponentId = 'WalletOpponent11111111111111111111111';
  economics.ensureWallet(creatorId);
  economics.ensureWallet(opponentId);
  const casual = new CasualRoomService({ economics, allowDemoAuth: true });
  const room = await openCasualRoom(casual, creatorId, opponentId);
  casual.setReady(room.id, creatorId, true);
  casual.setReady(room.id, opponentId, true);
  const before = economics.getBalance(creatorId);
  await assert.rejects(() => casual.startBattle(room.id, creatorId), CasualTeamRequiredError);
  assert.equal(casual.getRoom(room.id).status, 'ready');
  assert.equal(economics.getBalance(creatorId), before);
  assert.equal(economics.getBalance(opponentId), before);
});
