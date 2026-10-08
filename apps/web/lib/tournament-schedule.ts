import { previewLegacyPokeTournament } from '@pokearena/solana-client/browser';
import { tournamentRotationCapacity } from '@pokearena/tournament/rotation';
import {
  TOURNAMENT_BURN_FEE_POKE,
  TOURNAMENT_FIELD_SIZE,
} from '@pokearena/solana-client/poke-units';

import type { TournamentEconomicsPreview, TournamentSummary } from './protocol';
import { rotationEvent, type FormatPresentation } from './tournament-formats';

export { TOURNAMENT_BURN_FEE_POKE, TOURNAMENT_FIELD_SIZE };

export const GEN1_CUP_TITLE = 'GEN 1 CUP';
export const GEN1_CUP_THEME = 'GENERATION 1 POKÉMON';
/** Legacy display fallback when chain economy is off. */
export const TOURNAMENT_ENTRY_POKE = 50_000;
/** Approximate USD entry when chain economy quotes POKE. */
export const TOURNAMENT_ENTRY_USD = 5;
/** One full casual → cup → OU cycle across generations 1–9. */
export const SCHEDULE_SLOT_COUNT = 27;
/** Opening Gen 1 Casual, Gen 1 Cup, and Gen 9 OU use the smaller field. */
export const OPENING_TOURNAMENT_COUNT = 3;
export const OPENING_TOURNAMENT_CAPACITY = 16;
export const DEFAULT_TOURNAMENT_CAPACITY = 32;
export const ROTATION_SLOT_MS = 30 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

export type ScheduleSlotKind = 'now' | 'next';
export type ScheduleWhen = 'CURRENT' | 'NEXT' | 'LATER';
export type ScheduleTheme = 'gen1' | 'unknown';

export type ScheduleSlot = {
  key: string;
  kind: ScheduleSlotKind;
  when: ScheduleWhen;
  theme: ScheduleTheme;
  rulesetId: string;
  title: string;
  themeLabel: string;
  format: FormatPresentation;
  maxPlayers: 16 | 32;
  startsAt?: number;
  endsAt?: number;
  isLocked: boolean;
  tournament?: TournamentSummary;
};

export type SchedulerState = {
  enabled: boolean;
  nextTournamentStartAt?: number;
  nextRotationIndex: number;
};

export type TournamentScheduleOptions = {
  allAvailable?: boolean;
  scheduler?: SchedulerState | null;
};

export function hourFloor(now = Date.now()): number {
  const date = new Date(now);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

export function slotStart(now = Date.now()): number {
  return Math.floor(now / ROTATION_SLOT_MS) * ROTATION_SLOT_MS;
}

/** Capacity for a rotation index. Positions 0–2 are 16; every later position is 32. */
export function scheduledCapacity(slotIndex: number): 16 | 32 {
  return tournamentRotationCapacity(slotIndex);
}

export function buildTournamentSchedule(
  tournaments: TournamentSummary[],
  now = Date.now(),
  options: TournamentScheduleOptions = {},
): ScheduleSlot[] {
  const scheduler = options.scheduler;
  const schedulerOn = scheduler?.enabled === true;
  const origin = schedulerOn ? scheduler.nextRotationIndex : 0;
  const anchor = schedulerOn ? scheduler.nextTournamentStartAt : undefined;
  const slots: ScheduleSlot[] = [];

  for (let index = 0; index < SCHEDULE_SLOT_COUNT; index += 1) {
    const startsAt = anchor === undefined ? undefined : anchor + index * ROTATION_SLOT_MS;
    const endsAt = startsAt === undefined ? undefined : startsAt + ROTATION_SLOT_MS;
    const slotIndex = (origin ?? 0) + index;
    const format = rotationEvent(slotIndex);
    const tournament = tournamentForSlot(tournaments, format.id, startsAt, endsAt);
    const isLocked = options.allAvailable
      ? false
      : !schedulerOn
        || !tournament
        || (startsAt !== undefined && startsAt > now);
    const firstSlotLocked = index === 0 ? isLocked : slots[0]?.isLocked === true;
    slots.push({
      key: tournament?.id ?? `${format.id}-${startsAt ?? `preview-${index}`}`,
      kind: index === 0 ? 'now' : 'next',
      when: firstSlotLocked
        ? index === 0 ? 'NEXT' : 'LATER'
        : index === 0 ? 'CURRENT' : index === 1 ? 'NEXT' : 'LATER',
      theme: format.id === 'gen1cup' ? 'gen1' : 'unknown',
      rulesetId: format.id,
      title: format.title,
      themeLabel: `${format.region} · ${format.restriction}`,
      format,
      maxPlayers: scheduledCapacity(slotIndex),
      startsAt,
      endsAt,
      isLocked,
      tournament,
      ...(options.allAvailable ? { when: 'CURRENT' as const } : {}),
    });
  }

  return slots;
}

function tournamentForSlot(
  tournaments: TournamentSummary[],
  rulesetId: string,
  startsAt?: number,
  endsAt?: number,
): TournamentSummary | undefined {
  const rank = (status: string) => {
    if (status === 'registration' || status === 'draft') return 0;
    if (status === 'ready' || status === 'in-progress' || status === 'active') return 1;
    return 2;
  };
  const matches = tournaments.filter(tournament => {
    if ((tournament.ruleset ?? 'gen9ou') !== rulesetId) return false;
    if (tournament.status === 'cancelled') return false;
    if (startsAt === undefined || endsAt === undefined) return true;
    const created = tournament.createdAt ?? 0;
    return created >= startsAt && created < endsAt;
  });
  matches.sort((left, right) => (
    rank(left.status) - rank(right.status)
    || (right.createdAt ?? 0) - (left.createdAt ?? 0)
  ));
  return matches[0];
}

export function formatCountdown(targetMs: number, now = Date.now()): string {
  const remaining = Math.max(0, targetMs - now);
  const totalSeconds = Math.floor(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':');
}

export function displayedFieldSize(slot: ScheduleSlot): number {
  return slot.tournament?.maxPlayers ?? slot.maxPlayers;
}

export function scheduleStatusLabel(
  slot: ScheduleSlot,
  scheduler?: SchedulerState | null,
): string {
  const status = slot.tournament?.status;
  if (status === 'registration' && slot.tournament?.finalizesAt) return 'FINALIZING';
  if (!status) {
    if (
      scheduler?.enabled === true
      && slot.startsAt !== undefined
    ) {
      return 'SCHEDULED';
    }
    return 'ROTATION PREVIEW';
  }
  if (status === 'registration' || status === 'draft') return 'REGISTERING';
  if (status === 'ready') return 'FULL';
  if (status === 'in-progress' || status === 'active') return 'LIVE';
  if (status === 'completed') return 'COMPLETED';
  return status.toUpperCase();
}

export function scheduleCountdown(
  slot: ScheduleSlot,
  scheduler: SchedulerState | null | undefined,
  now = Date.now(),
): { label: string; target: number } | null {
  const finalizesAt = slot.tournament?.finalizesAt;
  if (finalizesAt !== undefined && slot.when === 'CURRENT' && !slot.isLocked) {
    return {
      label: now < finalizesAt ? 'Locks in' : 'Window',
      target: finalizesAt,
    };
  }
  if (
    scheduler?.enabled === true
    && slot.startsAt !== undefined
    && slot.isLocked
  ) {
    return { label: 'Starts in', target: slot.startsAt };
  }
  return null;
}

export function scheduleCtaLabel(slot: ScheduleSlot): string {
  const status = slot.tournament?.status;
  if (!status) return 'JOIN TOURNAMENT';
  if (status === 'registration' || status === 'draft') return 'JOIN TOURNAMENT';
  if (status === 'ready') return 'VIEW TOURNAMENT';
  if (status === 'in-progress' || status === 'active') return 'WATCH LIVE';
  if (status === 'completed') return 'VIEW RESULTS';
  return 'VIEW TOURNAMENT';
}

export function previewTreasuryPrize(
  entryFee = TOURNAMENT_ENTRY_POKE,
  playerCount = TOURNAMENT_FIELD_SIZE,
): TournamentEconomicsPreview {
  return previewLegacyPokeTournament(entryFee, playerCount);
}

export function roundLabel(round: number, maxPlayers: number): string {
  const field = maxPlayers || TOURNAMENT_FIELD_SIZE;
  const playersInRound = field / (2 ** (round - 1));
  if (playersInRound >= 32) return 'ROUND OF 32';
  if (playersInRound >= 16) return 'ROUND OF 16';
  if (playersInRound >= 8) return 'QUARTERFINALS';
  if (playersInRound >= 4) return 'SEMIFINALS';
  if (playersInRound >= 2) return 'FINAL';
  return `ROUND ${round}`;
}

/**
 * An empty schedule slot creates a tournament only while automatic scheduling is on.
 * Scheduling off keeps active cups and still allows an explicit server-side create.
 */
export function scheduledSlotJoinCanCreate(
  scheduler: { enabled?: boolean } | null | undefined,
): boolean {
  return scheduler?.enabled === true;
}

export function shortenPlayer(id?: string): string {
  if (!id) return 'TBD';
  if (id.length <= 12) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}
