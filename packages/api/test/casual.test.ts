import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BattleTerminal } from '@pokearena/battle-engine';

import {
  CasualCustomTeamRejectedError,
  CasualNotReadyError,
  CasualRoomService,
  CasualSelectionError,
  CasualTeamRequiredError,
} from '../src/casual-service';
import { DEMO_TEAM_ONE, DEMO_TEAM_TWO } from '../src/demo-teams';
import { MockEconomics } from '../src/mock-economics';
import { bothConfirmCasual, bothReadyCasual, confirmCasualPicks, openFullCasualRoom } from './casual-flow';

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
  assert.equal(open.ruleset, 'casual');
  assert.equal(open.teamPreview, undefined);
  assert.equal(casual.listOpenRooms().length, 1);
  assert.equal(casual.listOpenRooms('demo-player-1')[0]?.teamPreview, undefined);

  const accepted = await casual.acceptRoom(open.id, 'demo-player-2');
  assert.equal(accepted.status, 'full');
  assert.equal(accepted.teamPreview, undefined);
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
  const casual = new CasualRoomService({ economics });
  const room = await openFullCasualRoom(casual, 'demo-player-1', 'demo-player-2', 100_000);
  bothConfirmCasual(casual, room.id);
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
  const casual = new CasualRoomService({ economics });
  const room = await openFullCasualRoom(casual);
  bothConfirmCasual(casual, room.id);
  const started = await casual.startBattle(room.id, 'demo-player-1');
  const balanceBefore = economics.getWallet('demo-player-1').balance;

  const settled = await casual.forfeit(room.id, 'demo-player-2');

  assert.equal(settled.status, 'completed');
  assert.equal(settled.winnerId, 'demo-player-1');
  assert.equal(settled.payout?.reason, 'casual-forfeit');
  assert.ok(economics.getWallet('demo-player-1').balance > balanceBefore);
  assert.equal(casual.getRoom(started.id).status, 'completed');
});

test('the confirmed three Pokémon are the team that enters the casual battle', async () => {
  const casual = new CasualRoomService();
  const room = await openFullCasualRoom(casual);
  bothReadyCasual(casual, room.id);
  const creatorView = casual.getRoom(room.id, 'demo-player-1');
  const selected = [0, 2, 5] as const;
  const kept = selected.map(slot => creatorView.teamPreview?.[0]?.pokemon[slot]?.species);
  const benched = (creatorView.teamPreview?.[0]?.pokemon ?? [])
    .filter(mon => !selected.includes(mon.slot as 0 | 2 | 5))
    .map(mon => mon.species);
  confirmCasualPicks(casual, room.id, 'demo-player-1', selected);
  confirmCasualPicks(casual, room.id, 'demo-player-2', [0, 1, 2]);
  const started = await casual.startBattle(room.id, 'demo-player-1');
  const view = casual.getMatchView(started.matchId, 'demo-player-1');
  const creatorSide = view?.sides.find(side => side.playerId === 'demo-player-1');
  assert.deepEqual(creatorSide?.party.map(mon => mon.species), kept);
  assert.equal(creatorSide?.party.length, 3);
  for (const species of benched) {
    assert.equal(creatorSide?.party.some(mon => mon.species === species), false);
  }
});

async function openCasualRoom(casual: CasualRoomService, creatorId = 'demo-player-1', opponentId = 'demo-player-2') {
  return openFullCasualRoom(casual, creatorId, opponentId);
}

test('a full casual room cannot start until both players are ready', async () => {
  const economics = new MockEconomics();
  const casual = new CasualRoomService({ economics });
  const room = await openCasualRoom(casual);
  const before = economics.getBalance('demo-player-1');

  await assert.rejects(() => casual.startBattle(room.id, 'demo-player-1'), CasualNotReadyError);
  assert.equal(casual.getRoom(room.id).status, 'full');
  assert.equal(economics.getBalance('demo-player-1'), before);

  assert.throws(() => casual.selectTeam(room.id, 'demo-player-1', [0, 1, 2], true), CasualSelectionError);
  casual.setReady(room.id, 'demo-player-1', true);
  await assert.rejects(() => casual.startBattle(room.id, 'demo-player-1'), CasualNotReadyError);
  assert.equal(casual.getRoom(room.id).status, 'full');

  casual.setReady(room.id, 'demo-player-2', true);
  assert.equal(casual.getRoom(room.id).status, 'drafting');
  const drafting = await casual.startBattle(room.id, 'demo-player-2');
  assert.equal(drafting.status, 'drafting');
  assert.equal(economics.getBalance('demo-player-2'), before);
});

test('both players must confirm three Pokémon before a casual battle starts', async () => {
  const economics = new MockEconomics();
  const casual = new CasualRoomService({ economics });
  const room = await openCasualRoom(casual);
  bothReadyCasual(casual, room.id);

  casual.selectTeam(room.id, 'demo-player-1', [0, 1, 2], true);
  casual.selectTeam(room.id, 'demo-player-2', [0, 1], false);
  assert.equal(casual.getRoom(room.id).status, 'drafting');
  const before = economics.getBalance('demo-player-1');
  const waiting = await casual.startBattle(room.id, 'demo-player-1');
  assert.equal(waiting.status, 'drafting');
  assert.equal(economics.getBalance('demo-player-1'), before);
  assert.equal(economics.getBalance('demo-player-2'), before);

  const missingCreator = await openCasualRoom(casual);
  bothReadyCasual(casual, missingCreator.id);
  casual.selectTeam(missingCreator.id, 'demo-player-2', [0, 1, 2], true);
  const stillDrafting = await casual.startBattle(missingCreator.id, 'demo-player-2');
  assert.equal(stillDrafting.status, 'drafting');
  assert.notEqual(casual.getRoom(missingCreator.id).status, 'battling');
});

test('both confirmed players can start a casual battle', async () => {
  const casual = new CasualRoomService();
  const room = await openCasualRoom(casual);
  bothConfirmCasual(casual, room.id);
  const started = await casual.startBattle(room.id, 'demo-player-1');
  assert.equal(started.status, 'battling');
  assert.ok(started.battleInstanceId);
});

test('a custom team paste is rejected for Casual', async () => {
  const economics = new MockEconomics({ devFaucet: true });
  const creatorId = 'WalletCreator111111111111111111111111';
  const opponentId = 'WalletOpponent11111111111111111111111';
  economics.ensureWallet(creatorId);
  economics.ensureWallet(opponentId);
  const casual = new CasualRoomService({ economics, allowDemoAuth: true });
  const room = await openCasualRoom(casual, creatorId, opponentId);
  assert.throws(
    () => casual.setReady(room.id, creatorId, true, 'Pikachu @ Light Ball\nAbility: Static\n- Thunderbolt'),
    CasualCustomTeamRejectedError,
  );
  const before = economics.getBalance(creatorId);
  await assert.rejects(() => casual.startBattle(room.id, creatorId), CasualNotReadyError);
  assert.equal(casual.getRoom(room.id).status, 'full');
  assert.equal(economics.getBalance(creatorId), before);
  assert.equal(economics.getBalance(opponentId), before);
});

test('chain-backed casual completion waits for verified chain settlement', async () => {
  const win: BattleTerminal = {
    type: 'completed',
    result: {
      status: 'win',
      winner: 'demo-player-1',
      score: [1, 0],
      turns: 1,
    },
  };
  let chainSettled = false;
  const casual = new CasualRoomService({
    economics: new MockEconomics(),
    battleEngine: {
      async createBattle() {
        return {
          id: 'chain-settlement-session',
          async start() {},
          getResult: () => win.result,
          getView: () => ({ sides: [] }),
          subscribe(listener: (terminal: BattleTerminal) => void) {
            listener(win);
            return () => undefined;
          },
          subscribeEvents() {
            return () => undefined;
          },
        };
      },
    } as never,
    chainSettlement: {
      async settle(input) {
        chainSettled = true;
        assert.equal(input.roomId.length > 0, true);
        return {
          symbol: 'SOL',
          rail: 'sol_chain',
          winnerId: input.winnerId,
          amount: 1_000,
          settlementKey: 'chain-settlement',
          settlementKeyHex: 'chain-settlement',
        };
      },
      async refund() {
        throw new Error('not used');
      },
    },
  });
  const created = await casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'open',
    battleSize: '1v1',
    collateral: 500_000_000,
    rail: 'sol_chain',
  });
  await casual.acceptRoom(created.id, 'demo-player-2');
  bothConfirmCasual(casual, created.id);
  const started = await casual.startBattle(created.id, 'demo-player-1');
  assert.equal(started.status, 'completed');
  assert.equal(chainSettled, true);
  assert.equal('rail' in (started.payout ?? {}), true);
});

test('competitive rooms lock custom Gen 9 OU sixes and start a six-on-six battle', async () => {
  const casual = new CasualRoomService();
  const created = await casual.createRoom({
    creatorId: 'demo-player-1',
    roomType: 'open',
    battleSize: '1v1',
    collateral: 1_000,
    ruleset: 'competitive',
  });
  assert.equal(created.ruleset, 'competitive');
  assert.equal(created.teamPreview, undefined);
  const room = await casual.acceptRoom(created.id, 'demo-player-2');
  assert.equal(room.teamPreview, undefined);
  assert.throws(
    () => casual.selectTeam(room.id, 'demo-player-1', [0, 1, 2], true),
    CasualSelectionError,
  );
  assert.throws(
    () => casual.setReady(room.id, 'demo-player-1', true),
    CasualTeamRequiredError,
  );

  casual.setReady(room.id, 'demo-player-1', true, DEMO_TEAM_ONE);
  casual.setReady(room.id, 'demo-player-2', true, DEMO_TEAM_TWO);
  const started = await casual.startBattle(room.id, 'demo-player-1');
  assert.equal(started.status, 'battling');
  const view = casual.getMatchView(started.matchId, 'demo-player-1');
  assert.equal(view?.sides.find(side => side.playerId === 'demo-player-1')?.party.length, 6);
  assert.equal(view?.sides.find(side => side.playerId === 'demo-player-2')?.party.length, 6);
});
