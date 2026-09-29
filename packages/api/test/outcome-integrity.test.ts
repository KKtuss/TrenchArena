import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  AvailableChoice,
  BattleEngine,
  BattleResult,
  BattleTerminal,
  PlayerChoice,
} from '@pokearena/battle-engine';

import { CasualRoomService } from '../src/casual-service';
import { MockEconomics } from '../src/mock-economics';
import { bothConfirmCasual, openFullCasualRoom } from './casual-flow';

const COLLATERAL = 100_000;
const WINNER_PAYOUT = 196_000;

function choiceFor(choice: AvailableChoice): PlayerChoice {
  switch (choice.type) {
    case 'team-preview':
      return { type: 'team-preview' };
    case 'move':
      return { type: 'move', slot: choice.slot };
    case 'switch':
      return { type: 'switch', slot: choice.slot };
    case 'pass':
      return { type: 'pass' };
  }
}

async function openReadyRoom(casual: CasualRoomService) {
  const room = await openFullCasualRoom(casual, 'demo-player-1', 'demo-player-2', COLLATERAL);
  bothConfirmCasual(casual, room.id);
  return casual.getRoom(room.id);
}

async function waitForRoom(
  casual: CasualRoomService,
  roomId: string,
  timeoutMs = 5_000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const room = casual.getRoom(roomId);
    if (room.status === 'completed' || room.status === 'cancelled') return room;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error(`Casual room did not settle: ${roomId}`);
}

async function timeoutCasualPlayer(silentId: 'demo-player-1' | 'demo-player-2') {
  const economics = new MockEconomics();
  const casual = new CasualRoomService({
    economics,
    allowDemoAuth: true,
    matchTimeoutMs: 1_200,
  });
  const room = await openReadyRoom(casual);
  const started = await casual.startBattle(room.id, 'demo-player-1');
  const activeId = silentId === 'demo-player-1' ? 'demo-player-2' : 'demo-player-1';
  const state = casual.getMatchState(started.matchId, activeId);
  const choice = state?.request?.choices[0];
  assert.ok(state?.request && choice);
  await casual.submitChoice({
    matchId: started.matchId,
    battleInstanceId: started.battleInstanceId!,
    playerId: activeId,
    revision: state.request.revision,
    choice: choiceFor(choice),
  });
  const settled = await waitForRoom(casual, room.id);
  return { economics, casual, settled, activeId, silentId };
}

test('player 1 timeout pays player 2 the pot minus the fee once', async () => {
  const { economics, settled, activeId, silentId } = await timeoutCasualPlayer('demo-player-1');
  assert.equal(settled.status, 'completed');
  assert.equal(settled.winnerId, activeId);
  assert.notEqual(settled.winnerId, silentId);
  assert.equal(settled.payout?.amount, WINNER_PAYOUT);
  assert.equal(settled.payout?.protocolFee, 4_000);
  assert.equal(economics.getBalance(activeId), 10_000_000 - COLLATERAL + WINNER_PAYOUT);
  assert.equal(economics.getBalance(silentId), 10_000_000 - COLLATERAL);
  assert.equal(economics.release(`casual:${settled.id}:creator`), 0);
  assert.equal(economics.release(`casual:${settled.id}:opponent`), 0);
  assert.equal(economics.getBalance(activeId), 10_000_000 - COLLATERAL + WINNER_PAYOUT);
});

test('player 2 timeout pays player 1 the pot minus the fee once', async () => {
  const { economics, settled, activeId, silentId } = await timeoutCasualPlayer('demo-player-2');
  assert.equal(settled.status, 'completed');
  assert.equal(settled.winnerId, 'demo-player-1');
  assert.equal(settled.winnerId, activeId);
  assert.notEqual(settled.winnerId, silentId);
  assert.equal(settled.payout?.amount, WINNER_PAYOUT);
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000 - COLLATERAL + WINNER_PAYOUT);
  assert.equal(economics.getBalance('demo-player-2'), 10_000_000 - COLLATERAL);
});

function fakeEngine(terminal: BattleTerminal, extra?: BattleTerminal): BattleEngine {
  const result = terminal.type === 'completed' ? terminal.result : undefined;
  return {
    async createBattle() {
      return {
        id: 'outcome-session',
        async start() {},
        getResult: () => result,
        subscribe(listener: (value: BattleTerminal) => void) {
          listener(terminal);
          if (extra) listener(extra);
          listener(terminal);
          return () => undefined;
        },
        subscribeEvents() {
          return () => undefined;
        },
      };
    },
  } as unknown as BattleEngine;
}

test('a timeout win cannot also refund the reserved stakes', async () => {
  const win: BattleTerminal = {
    type: 'completed',
    result: {
      status: 'win',
      winner: 'demo-player-2',
      score: [0, 1],
      turns: 0,
      endedBy: 'timeout',
    },
  };
  const economics = new MockEconomics();
  const casual = new CasualRoomService({
    economics,
    allowDemoAuth: true,
    battleEngine: fakeEngine(win),
  });
  const room = await openReadyRoom(casual);
  const settled = await casual.startBattle(room.id, 'demo-player-1');
  assert.equal(settled.status, 'completed');
  assert.equal(settled.winnerId, 'demo-player-2');
  assert.equal(settled.payout?.reason, 'casual-forfeit');
  assert.equal(settled.payout?.amount, WINNER_PAYOUT);
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000 - COLLATERAL);
  assert.equal(economics.getBalance('demo-player-2'), 10_000_000 - COLLATERAL + WINNER_PAYOUT);
});

test('repeated timeout terminals settle the pot once', async () => {
  const win: BattleResult = {
    status: 'win',
    winner: 'demo-player-1',
    score: [1, 0],
    turns: 0,
    endedBy: 'timeout',
  };
  const terminal: BattleTerminal = { type: 'completed', result: win };
  const economics = new MockEconomics();
  const casual = new CasualRoomService({
    economics,
    allowDemoAuth: true,
    battleEngine: fakeEngine(terminal, terminal),
  });
  const room = await openReadyRoom(casual);
  const settled = await casual.startBattle(room.id, 'demo-player-1');
  assert.equal(settled.status, 'completed');
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000 - COLLATERAL + WINNER_PAYOUT);
  assert.equal(economics.getBalance('demo-player-2'), 10_000_000 - COLLATERAL);
});

test('a tie refunds both stakes and does not name player 1 the winner', async () => {
  const tie: BattleTerminal = {
    type: 'completed',
    result: { status: 'tie', score: [0, 0], turns: 12 },
  };
  const economics = new MockEconomics();
  const casual = new CasualRoomService({
    economics,
    allowDemoAuth: true,
    battleEngine: fakeEngine(tie, tie),
  });
  const room = await openReadyRoom(casual);
  const settled = await casual.startBattle(room.id, 'demo-player-1');
  assert.equal(settled.status, 'completed');
  assert.equal(settled.winnerId, undefined);
  assert.notEqual(settled.winnerId, 'demo-player-1');
  assert.equal(settled.payout?.reason, 'casual-tie');
  assert.equal(settled.payout?.amount, COLLATERAL);
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000);
  assert.equal(economics.getBalance('demo-player-2'), 10_000_000);
});

test('a genuine pre-live failure still refunds both reserved stakes once', async () => {
  const economics = new MockEconomics();
  const casual = new CasualRoomService({
    economics,
    allowDemoAuth: true,
    battleEngine: {
      async createBattle() {
        throw new Error('sim down');
      },
    } as unknown as BattleEngine,
  });
  const room = await openReadyRoom(casual);
  await assert.rejects(() => casual.startBattle(room.id, 'demo-player-1'), /sim down/);
  assert.equal(casual.getRoom(room.id).status, 'cancelled');
  assert.equal(economics.getBalance('demo-player-1'), 10_000_000);
  assert.equal(economics.getBalance('demo-player-2'), 10_000_000);
  assert.equal(economics.release(`casual:${room.id}:creator`), 0);
});
