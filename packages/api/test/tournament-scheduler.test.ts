import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  InMemoryTournamentSchedulerStore,
  TOURNAMENT_SCHEDULE_INTERVAL_MS,
} from '@pokearena/db';
import {
  InMemoryAsyncTournamentRepository,
  TournamentService,
  tournamentRotationEvent,
} from '@pokearena/tournament';

import { TournamentScheduler } from '../src/tournament-scheduler';

async function createScheduler(
  store: InMemoryTournamentSchedulerStore,
  now: () => number,
) {
  const tournaments = new TournamentService({
    repository: new InMemoryAsyncTournamentRepository(),
    now,
  });
  const scheduler = new TournamentScheduler({
    store,
    tournaments,
    now,
    createTournament: async (definition, scheduledKey) => {
      const tournament = await tournaments.createTournament({
        title: definition.title,
        format: 'gen9ou',
        ruleset: definition.id,
        maxPlayers: definition.maxPlayers,
        hostId: 'scheduler',
        entryFee: 0,
        scheduledKey,
      });
      await tournaments.openRegistration(tournament.id);
    },
  });
  return { scheduler, tournaments };
}

test('fresh state is off, activation persists one exact 30-minute deadline', async () => {
  const store = new InMemoryTournamentSchedulerStore();
  const first = await store.getState();
  assert.deepEqual(first, { enabled: false, nextRotationIndex: 0 });

  const activated = await store.activate(1_000);
  assert.equal(activated.enabled, true);
  assert.equal(activated.nextTournamentStartAt, 1_000 + TOURNAMENT_SCHEDULE_INTERVAL_MS);

  const repeated = await store.activate(2_000);
  assert.deepEqual(repeated, activated);
  assert.deepEqual(await store.getState(), activated);
});

test('due start is one-shot, restart-safe, and uses the persisted rotation event', async () => {
  const store = new InMemoryTournamentSchedulerStore();
  const now = () => 1_000;
  const first = await createScheduler(store, now);
  await first.scheduler.activate();
  const deadline = (await first.scheduler.state()).nextTournamentStartAt!;

  assert.equal(await first.scheduler.tick(deadline - 1), false);
  assert.equal(await first.scheduler.tick(deadline), true);
  assert.equal((await first.tournaments.listTournaments()).length, 1);
  assert.equal((await first.tournaments.listTournaments())[0]?.maxPlayers, 16);
  assert.equal((await first.tournaments.listTournaments())[0]?.scheduledKey?.includes(':0'), true);

  const restarted = await createScheduler(store, now);
  assert.equal(await restarted.scheduler.tick(deadline + 1), false);
  assert.equal((await restarted.tournaments.listTournaments()).length, 0);
  assert.equal((await store.getState()).nextTournamentStartAt, undefined);
});

test('two workers at the same deadline create exactly one tournament', async () => {
  const store = new InMemoryTournamentSchedulerStore();
  let now = 5_000;
  const first = await createScheduler(store, () => now);
  const second = await createScheduler(store, () => now);
  await first.scheduler.activate(now);
  const deadline = (await first.scheduler.state()).nextTournamentStartAt!;

  const [createdA, createdB] = await Promise.all([
    first.scheduler.tick(deadline),
    second.scheduler.tick(deadline),
  ]);
  assert.equal(Number(createdA) + Number(createdB), 1);
  assert.equal((await first.tournaments.listTournaments()).length, 1);
  assert.equal((await store.getState()).nextTournamentStartAt, undefined);
});

test('disable cancels a countdown and re-enable resets the rotation to Gen 1', async () => {
  const store = new InMemoryTournamentSchedulerStore();
  const now = () => 10_000;
  const { scheduler, tournaments } = await createScheduler(store, now);
  await scheduler.activate();
  const oldDeadline = (await scheduler.state()).nextTournamentStartAt!;
  await scheduler.tick(oldDeadline);
  assert.equal((await scheduler.state()).nextRotationIndex, 1);
  await scheduler.disable();
  assert.equal((await scheduler.state()).enabled, false);
  assert.equal((await scheduler.state()).nextTournamentStartAt, undefined);
  assert.equal((await scheduler.state()).nextRotationIndex, 1);
  assert.equal(await scheduler.tick(oldDeadline + 1), false);
  assert.equal((await tournaments.listTournaments()).length, 1);

  const reenabled = await scheduler.activate(20_000);
  assert.equal(reenabled.nextTournamentStartAt, 20_000 + TOURNAMENT_SCHEDULE_INTERVAL_MS);
  assert.equal(reenabled.nextRotationIndex, 0);
  assert.notEqual(reenabled.nextTournamentStartAt, oldDeadline);
});

test('rotation definitions retain the existing 16/32 capacity ordering', () => {
  assert.equal(tournamentRotationEvent(0).maxPlayers, 16);
  assert.equal(tournamentRotationEvent(1).maxPlayers, 16);
  assert.equal(tournamentRotationEvent(2).maxPlayers, 16);
  assert.equal(tournamentRotationEvent(3).maxPlayers, 32);
  assert.equal(tournamentRotationEvent(5).maxPlayers, 32);
  assert.equal(tournamentRotationEvent(27).id, tournamentRotationEvent(0).id);
});
