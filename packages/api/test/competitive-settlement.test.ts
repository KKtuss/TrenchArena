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
import { DEMO_TEAM_ONE, DEMO_TEAM_TWO } from '../src/demo-teams';
import { MockEconomics } from '../src/mock-economics';
import { openFullCasualRoom } from './casual-flow';

const COLLATERAL = 100_000;
const WINNER_PAYOUT = 196_000;
const PLAYERS = ['demo-player-1', 'demo-player-2'] as const;

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

function endedSession(id: string, result: BattleResult | undefined, lifecycle: 'ended' | 'awaiting-choice' | 'failed') {
  return {
    id,
    async start() {},
    getResult: () => result,
    getState: () => ({ id, lifecycle, ...(result ? { result } : {}) }),
    getView: () => ({ sides: [] }),
  };
}

async function readyCompetitiveRoom(casual: CasualRoomService) {
  const room = await openFullCasualRoom(
    casual,
    PLAYERS[0],
    PLAYERS[1],
    COLLATERAL,
    'competitive',
  );
  casual.setReady(room.id, PLAYERS[0], true, DEMO_TEAM_ONE);
  casual.setReady(room.id, PLAYERS[1], true, DEMO_TEAM_TWO);
  return room;
}

test('an active competitive battle cannot settle from a premature or intermediate event', async () => {
  const economics = new MockEconomics();
  const claimed: BattleResult = {
    status: 'win',
    winner: PLAYERS[0],
    score: [0, 1],
    turns: 18,
  };
  let sawFaint = false;
  const casual = new CasualRoomService({
    economics,
    allowDemoAuth: true,
    battleEngine: {
      async createBattle() {
        const session = {
          ...endedSession('live-session', undefined, 'awaiting-choice'),
          subscribe(listener: (terminal: BattleTerminal) => void) {
            listener({ type: 'failed', failure: { code: 'simulator-error', message: 'not over' } });
            listener({ type: 'completed', result: claimed });
            return () => undefined;
          },
          subscribeEvents(listener: (event: { data: string }) => void) {
            sawFaint = true;
            listener({ data: '|faint|p1a: Dragonite' });
            return () => undefined;
          },
        };
        return session;
      },
    } as unknown as BattleEngine,
  });
  const room = await readyCompetitiveRoom(casual);
  const started = await casual.startBattle(room.id, PLAYERS[0]);
  assert.equal(sawFaint, true);
  assert.equal(started.status, 'battling');
  assert.equal(started.winnerId, undefined);
  assert.equal(started.payout, undefined);
  assert.equal(casual.getRoom(room.id).status, 'battling');
  assert.equal(economics.getBalance(PLAYERS[0]), 10_000_000 - COLLATERAL);
  assert.equal(economics.getBalance(PLAYERS[1]), 10_000_000 - COLLATERAL);
});

test('duplicate and out-of-order completion events settle the authoritative winner once', async () => {
  const economics = new MockEconomics();
  const authoritative: BattleResult = {
    status: 'win',
    winner: PLAYERS[0],
    score: [2, 0],
    turns: 22,
  };
  const stale: BattleResult = {
    status: 'win',
    winner: PLAYERS[1],
    score: [0, 2],
    turns: 22,
  };
  const casual = new CasualRoomService({
    economics,
    allowDemoAuth: true,
    battleEngine: {
      async createBattle() {
        return {
          ...endedSession('ended-session', authoritative, 'ended'),
          subscribe(listener: (terminal: BattleTerminal) => void) {
            listener({ type: 'completed', result: stale });
            listener({ type: 'completed', result: authoritative });
            listener({ type: 'completed', result: authoritative });
            return () => undefined;
          },
          subscribeEvents() {
            return () => undefined;
          },
        };
      },
    } as unknown as BattleEngine,
  });
  const room = await readyCompetitiveRoom(casual);
  const settled = await casual.startBattle(room.id, PLAYERS[0]);
  assert.equal(settled.status, 'completed');
  assert.equal(settled.winnerId, PLAYERS[0]);
  assert.notEqual(settled.winnerId, PLAYERS[1]);
  assert.equal(settled.payout?.amount, WINNER_PAYOUT);
  assert.equal(settled.payout?.reason, 'casual-win');
  assert.equal(economics.getBalance(PLAYERS[0]), 10_000_000 - COLLATERAL + WINNER_PAYOUT);
  assert.equal(economics.getBalance(PLAYERS[1]), 10_000_000 - COLLATERAL);
  assert.equal(economics.getBalance(PLAYERS[0]), 10_000_000 - COLLATERAL + WINNER_PAYOUT);
});

test('a mismatched terminal does not settle when the session result differs', async () => {
  const economics = new MockEconomics();
  const authoritative: BattleResult = {
    status: 'win',
    winner: PLAYERS[0],
    score: [1, 0],
    turns: 6,
  };
  const casual = new CasualRoomService({
    economics,
    allowDemoAuth: true,
    battleEngine: {
      async createBattle() {
        return {
          ...endedSession('ended-session', authoritative, 'ended'),
          subscribe(listener: (terminal: BattleTerminal) => void) {
            listener({
              type: 'completed',
              result: { status: 'win', winner: PLAYERS[1], score: [0, 1], turns: 6 },
            });
            return () => undefined;
          },
          subscribeEvents() {
            return () => undefined;
          },
        };
      },
    } as unknown as BattleEngine,
  });
  const room = await readyCompetitiveRoom(casual);
  const started = await casual.startBattle(room.id, PLAYERS[0]);
  assert.equal(started.status, 'battling');
  assert.equal(started.payout, undefined);
  assert.equal(economics.getBalance(PLAYERS[0]), 10_000_000 - COLLATERAL);
  assert.equal(economics.getBalance(PLAYERS[1]), 10_000_000 - COLLATERAL);
});

test('a competitive fight that keeps being played is not settled by the battle-start clock, then settles on a real result', async () => {
  const timeoutMs = 250;
  const economics = new MockEconomics();
  const casual = new CasualRoomService({
    economics,
    allowDemoAuth: true,
    matchTimeoutMs: timeoutMs,
  });
  const room = await readyCompetitiveRoom(casual);
  const started = await casual.startBattle(room.id, PLAYERS[0]);
  assert.equal(started.status, 'battling');
  const startedAt = Date.now();
  let phases = 0;

  while (phases < 4 && casual.getRoom(room.id).status === 'battling') {
    await new Promise(resolve => setTimeout(resolve, 90));
    if (casual.getRoom(room.id).status !== 'battling') break;
    const view = casual.getMatchView(started.matchId, 'spectator');
    if (view?.sides.some(side => side.party.some(mon => mon.fainted))) {
      assert.equal(casual.getRoom(room.id).status, 'battling');
      assert.equal(casual.getRoom(room.id).payout, undefined);
    }
    let submitted = false;
    for (const playerId of PLAYERS) {
      const state = casual.getMatchState(started.matchId, playerId);
      const choice = state?.request?.choices[0];
      if (!state?.request || !choice || !started.battleInstanceId) continue;
      await casual.submitChoice({
        matchId: started.matchId,
        battleInstanceId: started.battleInstanceId,
        playerId,
        revision: state.request.revision,
        choice: choiceFor(choice),
      });
      submitted = true;
    }
    if (submitted) phases += 1;
    else await new Promise(resolve => setImmediate(resolve));
  }

  assert.equal(phases, 4);
  assert.ok(Date.now() - startedAt >= timeoutMs);
  assert.equal(casual.getRoom(room.id).result?.endedBy, undefined);
  const midway = casual.getRoom(room.id);
  if (midway.status === 'completed') {
    assert.notEqual(midway.result?.endedBy, 'timeout');
  } else {
    assert.equal(midway.status, 'battling');
    assert.equal(midway.payout, undefined);
  }

  for (let step = 0; step < 1000 && casual.getRoom(room.id).status === 'battling'; step += 1) {
    let submitted = false;
    for (const playerId of PLAYERS) {
      const state = casual.getMatchState(started.matchId, playerId);
      const choice = state?.request?.choices[0];
      if (!state?.request || !choice || !started.battleInstanceId) continue;
      await casual.submitChoice({
        matchId: started.matchId,
        battleInstanceId: started.battleInstanceId,
        playerId,
        revision: state.request.revision,
        choice: choiceFor(choice),
      });
      submitted = true;
    }
    if (!submitted) await new Promise(resolve => setImmediate(resolve));
  }

  const settled = casual.getRoom(room.id);
  assert.equal(settled.status, 'completed');
  assert.notEqual(settled.result?.endedBy, 'timeout');
  assert.ok(settled.payout);
  if (settled.result?.status === 'win') {
    assert.equal(settled.payout?.reason, 'casual-win');
    assert.ok(settled.winnerId === PLAYERS[0] || settled.winnerId === PLAYERS[1]);
    const winner = settled.winnerId!;
    const loser = winner === PLAYERS[0] ? PLAYERS[1] : PLAYERS[0];
    assert.equal(economics.getBalance(winner), 10_000_000 - COLLATERAL + WINNER_PAYOUT);
    assert.equal(economics.getBalance(loser), 10_000_000 - COLLATERAL);
  } else {
    assert.equal(settled.winnerId, undefined);
    assert.equal(settled.payout?.reason, 'casual-tie');
    assert.equal(economics.getBalance(PLAYERS[0]), 10_000_000);
    assert.equal(economics.getBalance(PLAYERS[1]), 10_000_000);
  }
  assert.equal(settled.result?.status === 'win' || settled.result?.status === 'tie', true);
});
