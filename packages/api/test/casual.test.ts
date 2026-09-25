import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CasualRoomService } from '../src/casual-service';
import { MockEconomics } from '../src/mock-economics';

test('casual rooms support private/open creation, accept, full-room and over-balance rejection', () => {
  const economics = new MockEconomics();
  const casual = new CasualRoomService({ economics });

  const open = casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'open',
    battleSize: '1v1',
    collateral: 50_000,
  });
  assert.equal(open.status, 'open');
  assert.equal(casual.listOpenRooms().length, 1);

  const accepted = casual.acceptRoom(open.id, 'demo-player-2');
  assert.equal(accepted.status, 'full');
  assert.throws(() => casual.acceptRoom(open.id, 'demo-player-1'));

  assert.throws(() => casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'open',
    battleSize: '1v1',
    collateral: 99_000_000,
  }));

  const privateRoom = casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'private',
    battleSize: '1v1',
    collateral: 25_000,
    invitedPlayerId: 'demo-player-2',
  });
  assert.throws(() => casual.acceptRoom(privateRoom.id, 'demo-player-1'));
});

test('2v2 rooms can be configured but start is unsupported', async () => {
  const casual = new CasualRoomService();
  const room = casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'open',
    battleSize: '2v2',
    collateral: 10_000,
  });
  casual.acceptRoom(room.id, 'demo-player-2');
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
  const casual = new CasualRoomService({ economics });
  const room = casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'open',
    battleSize: '1v1',
    collateral: 100_000,
  });
  casual.acceptRoom(room.id, 'demo-player-2');
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
