import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BattleEngine,
  CASUAL_SHOWDOWN_FORMAT_ID,
  CASUAL_TEAM_SIZE,
  InvalidChoiceError,
  InvalidLifecycleTransitionError,
  StaleChoiceError,
  TeamValidationError,
  UnsupportedFormatError,
  UnknownPlayerError,
  WrongBattleError,
  sliceTeamText,
  type AvailableChoice,
  type BattleSession,
  type PlayerChoice,
} from '../src';
import { TEAM_ONE, TEAM_TWO } from './fixtures';

const PLAYER_ONE = 'player-one';
const PLAYER_TWO = 'player-two';

function createInput(seed = '1,2,3,4', timeoutMs = 15_000) {
  return {
    format: 'gen9ou' as const,
    players: [
      { id: PLAYER_ONE, name: 'Alice' },
      { id: PLAYER_TWO, name: 'Bob' },
    ] as const,
    teams: [TEAM_ONE, TEAM_TWO] as const,
    seed,
    timeoutMs,
  };
}

async function createStartedBattle(
  engine: BattleEngine,
  seed = '1,2,3,4',
  timeoutMs = 15_000,
): Promise<BattleSession> {
  const battle = await engine.createBattle(createInput(seed, timeoutMs));
  await battle.start();
  return battle;
}

async function playBattle(battle: BattleSession): Promise<void> {
  for (let step = 0; step < 1000 && !battle.getResult(); step += 1) {
    let submitted = false;

    for (const playerId of [PLAYER_ONE, PLAYER_TWO]) {
      const request = battle.getState(playerId).request;
      if (!request || !request.choices.length) continue;

      await battle.submitChoice({
        battleId: battle.id,
        playerId,
        revision: request.revision,
        choice: choiceFor(request.choices[0]),
      });
      submitted = true;
    }

    if (!submitted && !battle.getResult()) await tick();
  }

  assert.ok(battle.getResult(), 'battle did not finish within the test safety limit');
}

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

function tick(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

test('supports the created → started → awaiting-choice → ended lifecycle', async () => {
  const engine = new BattleEngine();
  const battle = await engine.createBattle(createInput());

  assert.equal(battle.getState().lifecycle, 'created');
  await battle.start();
  assert.equal(battle.getState().lifecycle, 'awaiting-choice');
  await playBattle(battle);
  assert.equal(battle.getState().lifecycle, 'ended');
});

test('starts a 3-mon Casual format battle without changing gen9ou 6-mon battles', async () => {
  const engine = new BattleEngine();
  const battle = await engine.createBattle({
    format: 'gen9ou',
    showdownFormatId: CASUAL_SHOWDOWN_FORMAT_ID,
    teamSize: CASUAL_TEAM_SIZE,
    players: [
      { id: PLAYER_ONE, name: 'Alice' },
      { id: PLAYER_TWO, name: 'Bob' },
    ],
    teams: [sliceTeamText(TEAM_ONE, [0, 1, 2]), sliceTeamText(TEAM_TWO, [0, 1, 2])],
    seed: '1,2,3,4',
    timeoutMs: 15_000,
  });
  await battle.start();
  const request = battle.getState(PLAYER_ONE).request;
  assert.ok(request);
  assert.notEqual(request.kind, 'wait');
  const view = battle.getView(PLAYER_ONE);
  assert.equal(view.sides[0].party.length, 3);
  assert.equal(view.sides[1].party.length, 3);
  await playBattle(battle);
  assert.equal(battle.getState().lifecycle, 'ended');
});

test('validates the supported format and teams before creating a session', async () => {
  const engine = new BattleEngine();

  await assert.rejects(
    () => engine.createBattle({
      ...createInput(),
      format: 'gen9doublesou' as 'gen9ou',
    }),
    UnsupportedFormatError,
  );
  await assert.rejects(
    () => engine.createBattle({
      ...createInput(),
      teams: [TEAM_ONE.replace('Headlong Rush', 'DefinitelyNotAMove'), TEAM_TWO],
    }),
    TeamValidationError,
  );
});

test('rejects invalid lifecycle transitions', async () => {
  const engine = new BattleEngine();
  const battle = await engine.createBattle(createInput());

  await assert.rejects(
    () => battle.submitChoice({
      battleId: battle.id,
      playerId: PLAYER_ONE,
      revision: 1,
      choice: { type: 'move', slot: 1 },
    }),
    InvalidLifecycleTransitionError,
  );

  await battle.start();
  await assert.rejects(() => battle.start(), InvalidLifecycleTransitionError);
  await playBattle(battle);
  await assert.rejects(() => battle.start(), InvalidLifecycleTransitionError);
  await assert.rejects(
    () => battle.submitChoice({
      battleId: battle.id,
      playerId: PLAYER_ONE,
      revision: 1,
      choice: { type: 'move', slot: 1 },
    }),
    InvalidLifecycleTransitionError,
  );
});

test('isolates player requests from the spectator stream', async () => {
  const engine = new BattleEngine();
  const battle = await createStartedBattle(engine);

  const spectatorEvents = battle.getEvents('spectator');
  const playerOneEvents = battle.getEvents(PLAYER_ONE);
  const playerTwoEvents = battle.getEvents(PLAYER_TWO);

  assert.equal(battle.getState('spectator').request, undefined);
  assert.ok(battle.getState(PLAYER_ONE).request);
  assert.ok(battle.getState(PLAYER_TWO).request);
  assert.ok(playerOneEvents.some(event => event.scope === 'private'));
  assert.ok(playerTwoEvents.some(event => event.scope === 'private'));
  assert.ok(!spectatorEvents.some(event => event.scope === 'private'));
  assert.ok(!spectatorEvents.some(event => event.data.includes('|request|')));
  assert.ok(!playerOneEvents.some(event => event.playerId === PLAYER_TWO));
  assert.ok(!playerTwoEvents.some(event => event.playerId === PLAYER_ONE));

  const spectatorView = battle.getView('spectator');
  const playerOneView = battle.getView(PLAYER_ONE);
  assert.equal(spectatorView.request, undefined);
  assert.equal(playerOneView.request?.playerId, PLAYER_ONE);
  assert.ok(playerOneView.sides.length === 2);
});

test('rejects wrong-battle, unknown-player, raw, and unavailable choices', async () => {
  const engine = new BattleEngine();
  const battle = await createStartedBattle(engine);
  const request = battle.getState(PLAYER_ONE).request!;

  await assert.rejects(
    () => battle.submitChoice({
      battleId: 'different-battle',
      playerId: PLAYER_ONE,
      revision: request.revision,
      choice: { type: 'move', slot: 1 },
    }),
    WrongBattleError,
  );
  assert.throws(
    () => battle.getState('unknown-player'),
    UnknownPlayerError,
  );
  await assert.rejects(
    () => battle.submitChoice({
      battleId: battle.id,
      playerId: PLAYER_ONE,
      revision: request.revision,
      choice: ' >eval process.exit()' as unknown as PlayerChoice,
    }),
    InvalidChoiceError,
  );
  await assert.rejects(
    () => battle.submitChoice({
      battleId: battle.id,
      playerId: PLAYER_ONE,
      revision: request.revision,
      choice: { type: 'move', slot: 99 },
    }),
    InvalidChoiceError,
  );
});

test('rejects stale request revisions', async () => {
  const engine = new BattleEngine();
  const battle = await createStartedBattle(engine);
  const firstRequest = battle.getState(PLAYER_ONE).request!;

  await battle.submitChoice({
    battleId: battle.id,
    playerId: PLAYER_ONE,
    revision: firstRequest.revision,
    choice: choiceFor(firstRequest.choices[0]),
  });
  const secondRequest = battle.getState(PLAYER_TWO).request!;
  await battle.submitChoice({
    battleId: battle.id,
    playerId: PLAYER_TWO,
    revision: secondRequest.revision,
    choice: choiceFor(secondRequest.choices[0]),
  });
  await tick();

  const nextRequest = battle.getState(PLAYER_ONE).request!;
  assert.notEqual(nextRequest.revision, firstRequest.revision);
  await assert.rejects(
    () => battle.submitChoice({
      battleId: battle.id,
      playerId: PLAYER_ONE,
      revision: firstRequest.revision,
      choice: choiceFor(nextRequest.choices[0]),
    }),
    StaleChoiceError,
  );
});

test('finalization is idempotent', async () => {
  const engine = new BattleEngine();
  const battle = await createStartedBattle(engine);
  await playBattle(battle);

  const first = battle.finalize();
  const second = battle.finalize();
  assert.deepEqual(second, first);
  assert.deepEqual(battle.getResult(), first);
});

test('a timeout never stays unresolved and never invents a player-one winner', async () => {
  const engine = new BattleEngine();
  const battle = await engine.createBattle(createInput('1,2,3,4', 5));

  try {
    await battle.start();
  } catch {
    // The deadline can fire before start() finishes routing the first requests.
  }
  await new Promise(resolve => setTimeout(resolve, 25));

  const result = battle.getResult();
  const failure = battle.getState().failure;
  assert.ok(result || failure, 'timeout must fail pre-live or settle from pending decisions');
  if (failure) {
    assert.equal(failure.code, 'timeout');
    assert.equal(result, undefined);
    assert.equal(battle.getState().lifecycle, 'failed');
    return;
  }

  assert.equal(battle.getState().lifecycle, 'ended');
  assert.equal(result?.endedBy, 'timeout');
  if (result?.status === 'win') {
    assert.ok(result.winner === PLAYER_ONE || result.winner === PLAYER_TWO);
  } else {
    assert.equal(result?.status, 'tie');
    assert.equal(result?.winner, undefined);
  }
});

async function waitForBattleEnd(battle: BattleSession, timeoutMs = 2_000): Promise<void> {
  if (battle.getResult() || battle.getState().failure) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Battle did not end before the test deadline.')), timeoutMs);
    battle.subscribe(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function timeoutSilentPlayer(silentPlayerId: string, winnerId: string): Promise<BattleSession> {
  const engine = new BattleEngine();
  const battle = await engine.createBattle(createInput('1,2,3,4', 400));
  await battle.start();
  const activeId = silentPlayerId === PLAYER_ONE ? PLAYER_TWO : PLAYER_ONE;
  const request = battle.getState(activeId).request;
  assert.ok(request?.choices.length);
  await battle.submitChoice({
    battleId: battle.id,
    playerId: activeId,
    revision: request.revision,
    choice: choiceFor(request.choices[0]),
  });
  await waitForBattleEnd(battle);
  const result = battle.getResult();
  assert.ok(result);
  assert.equal(result.status, 'win');
  assert.equal(result.winner, winnerId);
  assert.equal(result.endedBy, 'timeout');
  assert.equal(battle.getState().lifecycle, 'ended');
  assert.equal(battle.actionablePendingPlayerIds().length, 0);
  return battle;
}

test('player one loses when they fail to make the pending decision', async () => {
  await timeoutSilentPlayer(PLAYER_ONE, PLAYER_TWO);
});

test('player two loses when they fail to make the pending decision', async () => {
  await timeoutSilentPlayer(PLAYER_TWO, PLAYER_ONE);
});

test('a finished battle is not rewritten as a timeout', async () => {
  const engine = new BattleEngine();
  const battle = await createStartedBattle(engine);
  await playBattle(battle);
  const result = battle.getResult();
  assert.ok(result);
  assert.notEqual(result.endedBy, 'timeout');
  assert.equal(battle.getState().lifecycle, 'ended');
  assert.equal(battle.getState().failure, undefined);
});

test('players who keep deciding are not settled by the battle-start clock', async () => {
  const timeoutMs = 200;
  const engine = new BattleEngine();
  const battle = await createStartedBattle(engine, '1,2,3,4', timeoutMs);
  const startedAt = Date.now();
  let phases = 0;

  while (phases < 4 && !battle.getResult()) {
    await new Promise(resolve => setTimeout(resolve, 80));
    if (battle.getResult()) break;
    let submitted = false;
    for (const playerId of [PLAYER_ONE, PLAYER_TWO]) {
      const request = battle.getState(playerId).request;
      if (!request?.choices.length) continue;
      await battle.submitChoice({
        battleId: battle.id,
        playerId,
        revision: request.revision,
        choice: choiceFor(request.choices[0]),
      });
      submitted = true;
    }
    if (submitted) phases += 1;
    else await tick();
  }

  assert.equal(phases, 4);
  assert.ok(Date.now() - startedAt >= timeoutMs);
  assert.equal(battle.getResult(), undefined);
  assert.equal(battle.getState().lifecycle, 'awaiting-choice');
});

test('a live timeout settles once even if observers subscribe twice', async () => {
  const battle = await timeoutSilentPlayer(PLAYER_ONE, PLAYER_TWO);
  const first = battle.getResult();
  const seen: unknown[] = [];
  battle.subscribe(terminal => seen.push(terminal));
  battle.subscribe(terminal => seen.push(terminal));
  await tick();
  assert.equal(seen.length, 2);
  assert.deepEqual(battle.finalize(), first);
  assert.deepEqual(battle.getResult(), first);
});

test('replays a completed battle and verifies its terminal result', async () => {
  const engine = new BattleEngine();
  const battle = await createStartedBattle(engine);
  await playBattle(battle);

  const replay = battle.getReplay();
  assert.equal(replay.showdownVersion, '0.11.11');
  assert.equal(replay.format, 'gen9ou');
  assert.ok(replay.acceptedInputs.length > 0);
  assert.ok(replay.events.length > 0);

  const replayed = await engine.replay(replay);
  assert.deepEqual(replayed, battle.getResult());
});

test('runs multiple battles independently in one process', async () => {
  const engine = new BattleEngine();
  const [first, second] = await Promise.all([
    createStartedBattle(engine, '10,20,30,40'),
    createStartedBattle(engine, '11,21,31,41'),
  ]);

  assert.notEqual(first.id, second.id);
  await Promise.all([playBattle(first), playBattle(second)]);
  assert.equal(first.getState().lifecycle, 'ended');
  assert.equal(second.getState().lifecycle, 'ended');
});

test('replays 25 deterministic seeds', async () => {
  const engine = new BattleEngine();

  for (let index = 0; index < 25; index += 1) {
    const seed = `${index + 10},${index + 20},${index + 30},${index + 40}`;
    const battle = await createStartedBattle(engine, seed);
    await playBattle(battle);
    const replayed = await engine.replay(battle.getReplay());
    assert.deepEqual(replayed, battle.getResult());
  }
});
