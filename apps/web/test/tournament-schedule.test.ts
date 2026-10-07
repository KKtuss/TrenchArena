import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rotationEvent } from '../lib/tournament-formats';
import { SHOWDOWN_SPRITE_CDN, showdownSpriteSrc } from '../lib/showdown-visuals';
import {
  ROTATION_SLOT_MS,
  SCHEDULE_SLOT_COUNT,
  buildTournamentSchedule,
  displayedFieldSize,
  formatCountdown,
  scheduleCountdown,
  scheduleStatusLabel,
  scheduledCapacity,
  scheduledSlotJoinCanCreate,
} from '../lib/tournament-schedule';

test('the cycle is Casual Gen X, that Gen cup, then Gen 9 OU through Gen 9', () => {
  const cycle = Array.from({ length: 27 }, (_, index) => rotationEvent(index).id);
  assert.deepEqual(cycle.slice(0, 6), [
    'gen1casual',
    'gen1cup',
    'gen9ou',
    'gen2casual',
    'gen2cup',
    'gen9ou',
  ]);
  assert.equal(cycle.filter(id => id === 'gen9ou').length, 9);
  assert.equal(cycle[24], 'gen9casual');
  assert.equal(cycle[25], 'gen9cup');
  assert.equal(cycle[26], 'gen9ou');
  assert.equal(rotationEvent(27).id, 'gen1casual');
  assert.equal(rotationEvent(0).teamMode, 'preset-6-choose-3');
  assert.equal(rotationEvent(1).restriction, 'GEN 1 ONLY');
  assert.equal(rotationEvent(0).pokemon[0], 'Venusaur');
  assert.equal(rotationEvent(3).id, 'gen2casual');
  assert.equal(rotationEvent(3).pokemon[0], 'Typhlosion');
  assert.notEqual(rotationEvent(25).restriction, rotationEvent(26).restriction);
});

test('the canonical rotation starts with three 16-player events, then 32', () => {
  assert.equal(rotationEvent(0).title, 'GEN 1 CASUAL');
  assert.equal(rotationEvent(1).title, 'GEN 1 CUP');
  assert.equal(rotationEvent(2).title, 'GEN 9 OU');
  assert.deepEqual([0, 1, 2].map(scheduledCapacity), [16, 16, 16]);
  assert.equal(scheduledCapacity(3), 32);
  assert.equal(scheduledCapacity(5), 32);
  assert.equal(scheduledCapacity(27), 16);
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const slots = buildTournamentSchedule([], now, { scheduler: { enabled: false, nextRotationIndex: 99 } });
  assert.deepEqual(slots.slice(0, 3).map(slot => slot.title), ['GEN 1 CASUAL', 'GEN 1 CUP', 'GEN 9 OU']);
  assert.deepEqual(slots.slice(0, 3).map(slot => slot.maxPlayers), [16, 16, 16]);
  assert.equal(slots[3]?.maxPlayers, 32);
  assert.ok(slots.every(slot => slot.startsAt === undefined && slot.isLocked));
  const casualSlot = slots.find(slot => slot.rulesetId === 'gen1casual');
  assert.ok(casualSlot);
  assert.equal(displayedFieldSize(casualSlot), casualSlot.maxPlayers);
  const persisted = {
    ...casualSlot,
    tournament: {
      id: 'persisted-16',
      title: casualSlot.title,
      format: 'gen9ou',
      ruleset: casualSlot.rulesetId,
      status: 'registration',
      maxPlayers: casualSlot.maxPlayers,
      playerCount: 12,
      entryFee: 0,
      economics: {
        symbol: 'POKE' as const,
        entryFee: 0,
        playerCount: 12,
        totalEntries: 0,
        treasuryShare: 0,
        treasuryBps: 0,
        devOpsShare: 0,
        devOpsBps: 0,
        prizePool: 0,
      },
    },
  };
  assert.equal(displayedFieldSize(persisted), casualSlot.maxPlayers);
  assert.equal(displayedFieldSize({ ...casualSlot, maxPlayers: 32, tournament: { ...persisted.tournament, maxPlayers: 16 } }), 16);
});

test('rotation preview rosters resolve to valid shared sprite URLs', () => {
  assert.deepEqual(rotationEvent(0).pokemon, ['Venusaur', 'Charizard', 'Blastoise', 'Hypno']);
  assert.deepEqual(rotationEvent(1).pokemon, ['Charizard', 'Venusaur', 'Blastoise', 'Pikachu']);
  assert.deepEqual(rotationEvent(2).pokemon, ['Great Tusk', 'Kingambit', 'Gholdengo', 'Dragapult']);
  assert.deepEqual(rotationEvent(3).pokemon, ['Typhlosion', 'Feraligatr', 'Meganium', 'Scizor']);

  for (const pokemon of [0, 1, 2, 3, 4, 5].flatMap(index => rotationEvent(index).pokemon)) {
    const src = showdownSpriteSrc(pokemon);
    assert.ok(src?.startsWith(`${SHOWDOWN_SPRITE_CDN}/sprites/gen5/`), pokemon);
    assert.ok(src?.endsWith('.png'), pokemon);
  }
});

test('the enabled timeline uses the persisted anchor and rotation index', () => {
  const nextTournamentStartAt = Date.UTC(2026, 9, 7, 15, 30, 0);
  const scheduler = { enabled: true, nextRotationIndex: 0, nextTournamentStartAt };
  const slots = buildTournamentSchedule([], Date.UTC(2026, 9, 7, 15, 0, 0), { scheduler });
  assert.equal(slots.length, SCHEDULE_SLOT_COUNT);
  assert.equal(slots[1]!.startsAt! - slots[0]!.startsAt!, ROTATION_SLOT_MS);
  assert.deepEqual(slots.slice(0, 4).map(slot => slot.title), [
    'GEN 1 CASUAL',
    'GEN 1 CUP',
    'GEN 9 OU',
    'GEN 2 CASUAL',
  ]);
  assert.deepEqual(slots.slice(0, 4).map(slot => slot.startsAt), [
    Date.UTC(2026, 9, 7, 15, 30, 0),
    Date.UTC(2026, 9, 7, 16, 0, 0),
    Date.UTC(2026, 9, 7, 16, 30, 0),
    Date.UTC(2026, 9, 7, 17, 0, 0),
  ]);
  assert.equal(slots[0]!.kind, 'now');
  assert.equal(slots[0]!.when, 'NEXT');
  assert.equal(slots[1]!.when, 'LATER');
  assert.equal(slots[2]!.when, 'LATER');
  assert.equal(slots[1]!.kind, 'next');
  assert.notEqual(slots[0]!.rulesetId, 'unknown');
  const ids = slots.map(slot => slot.rulesetId);
  assert.equal(new Set(ids).size, 19);
  assert.ok(ids.includes('gen1cup'));
  assert.ok(ids.includes('gen9casual'));
  assert.ok(ids.includes('gen9ou'));
});

test('joining an empty slot cannot create a tournament while scheduling is off', () => {
  assert.equal(scheduledSlotJoinCanCreate(undefined), false);
  assert.equal(scheduledSlotJoinCanCreate({ enabled: false }), false);
  assert.equal(scheduledSlotJoinCanCreate({ enabled: true }), true);
});

test('scheduler off renders empty rotation slots as previews without countdowns', () => {
  const scheduler = { enabled: false, nextRotationIndex: 23, nextTournamentStartAt: Date.UTC(2026, 9, 7, 15, 30, 0) };
  const first = buildTournamentSchedule([], Date.UTC(2026, 0, 1, 0, 7, 0), { scheduler });
  const second = buildTournamentSchedule([], Date.UTC(2026, 6, 1, 0, 7, 0), { scheduler });

  assert.deepEqual(first.slice(0, 3).map(slot => slot.title), ['GEN 1 CASUAL', 'GEN 1 CUP', 'GEN 9 OU']);
  assert.deepEqual(second.slice(0, 3).map(slot => slot.title), ['GEN 1 CASUAL', 'GEN 1 CUP', 'GEN 9 OU']);
  assert.ok(first.every(slot => slot.isLocked && slot.startsAt === undefined));
  assert.deepEqual(first.slice(0, 3).map(slot => slot.when), ['NEXT', 'LATER', 'LATER']);
  assert.equal(scheduleStatusLabel(first[0]!, scheduler), 'ROTATION PREVIEW');
  assert.equal(scheduleStatusLabel(first[1]!, scheduler), 'ROTATION PREVIEW');
  assert.equal(scheduleCountdown(first[0]!, scheduler), null);
  assert.equal(scheduleCountdown(first[1]!, scheduler), null);
});

test('scheduler on derives every countdown from the persisted next start', () => {
  const now = Date.UTC(2026, 9, 7, 15, 0, 0);
  const nextTournamentStartAt = Date.UTC(2026, 9, 7, 15, 30, 0);
  const scheduler = { enabled: true, nextRotationIndex: 0, nextTournamentStartAt };
  const slots = buildTournamentSchedule([], now, { scheduler });

  assert.equal(slots[0]!.when, 'NEXT');
  assert.equal(slots[1]!.when, 'LATER');
  assert.equal(scheduleStatusLabel(slots[0]!, scheduler), 'SCHEDULED');
  assert.equal(scheduleStatusLabel(slots[2]!, scheduler), 'SCHEDULED');
  assert.deepEqual(scheduleCountdown(slots[0]!, scheduler, now), {
    label: 'Starts in',
    target: nextTournamentStartAt,
  });
  assert.deepEqual(scheduleCountdown(slots[1]!, scheduler, now), {
    label: 'Starts in',
    target: nextTournamentStartAt + ROTATION_SLOT_MS,
  });
  assert.deepEqual(scheduleCountdown(slots[2]!, scheduler, now), {
    label: 'Starts in',
    target: nextTournamentStartAt + ROTATION_SLOT_MS * 2,
  });
  assert.equal(
    formatCountdown(scheduleCountdown(slots[0]!, scheduler, now)!.target, now),
    '00:30:00',
  );
  assert.deepEqual(
    scheduleCountdown(slots[0]!, scheduler, now + 11 * 60 * 1000),
    { label: 'Starts in', target: nextTournamentStartAt },
  );
});

test('a fresh enabled state starts from rotation zero after a prior schedule', () => {
  const oldScheduler = {
    enabled: true,
    nextRotationIndex: 8,
    nextTournamentStartAt: Date.UTC(2026, 9, 7, 14, 0, 0),
  };
  const freshScheduler = {
    enabled: true,
    nextRotationIndex: 0,
    nextTournamentStartAt: Date.UTC(2026, 9, 7, 15, 30, 0),
  };
  const oldSlots = buildTournamentSchedule([], Date.UTC(2026, 9, 7, 13, 0, 0), { scheduler: oldScheduler });
  const freshSlots = buildTournamentSchedule([], Date.UTC(2026, 9, 7, 15, 0, 0), { scheduler: freshScheduler });
  assert.equal(oldSlots[0]!.title, 'GEN 9 OU');
  assert.equal(freshSlots[0]!.title, 'GEN 1 CASUAL');
  assert.equal(freshSlots[0]!.startsAt, freshScheduler.nextTournamentStartAt);
});

test('local test mode makes every scheduled tournament immediately available', () => {
  const slots = buildTournamentSchedule([], Date.UTC(2026, 0, 1, 0, 7, 0), { allAvailable: true });
  assert.equal(slots.length, SCHEDULE_SLOT_COUNT);
  assert.ok(slots.every(slot => slot.when === 'CURRENT'));
});
