import type { TournamentEconomicsPreview, TournamentSummary } from './protocol';
import { rotationEvent, type FormatPresentation } from './tournament-formats';

export const GEN1_CUP_TITLE = 'GEN 1 CUP';
export const GEN1_CUP_THEME = 'GENERATION 1 POKÉMON';
/** Legacy display fallback when chain economy is off. */
export const TOURNAMENT_ENTRY_POKE = 50_000;
/** Fixed chain burn fee per tournament player. */
export const TOURNAMENT_BURN_FEE_POKE = 10_000;
/** Approximate USD entry when chain economy quotes POKE. */
export const TOURNAMENT_ENTRY_USD = 5;
export const TOURNAMENT_FIELD_SIZE = 32;
/** One full casual → cup → OU cycle across generations 1–9. */
export const SCHEDULE_SLOT_COUNT = 27;
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
  startsAt: number;
  endsAt: number;
  tournament?: TournamentSummary;
};

export type TournamentScheduleOptions = {
  allAvailable?: boolean;
};

export function hourFloor(now = Date.now()): number {
  const date = new Date(now);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

export function slotStart(now = Date.now()): number {
  return Math.floor(now / ROTATION_SLOT_MS) * ROTATION_SLOT_MS;
}

export function buildTournamentSchedule(
  tournaments: TournamentSummary[],
  now = Date.now(),
  options: TournamentScheduleOptions = {},
): ScheduleSlot[] {
  const anchor = slotStart(now);
  const origin = Math.floor(anchor / ROTATION_SLOT_MS);
  const slots: ScheduleSlot[] = [];

  for (let index = 0; index < SCHEDULE_SLOT_COUNT; index += 1) {
    const startsAt = anchor + index * ROTATION_SLOT_MS;
    const endsAt = startsAt + ROTATION_SLOT_MS;
    const format = rotationEvent(origin + index);
    const tournament = tournamentForSlot(tournaments, format.id, startsAt, endsAt);
    slots.push({
      key: tournament?.id ?? `${format.id}-${startsAt}`,
      kind: index === 0 ? 'now' : 'next',
      when: index === 0 ? 'CURRENT' : index === 1 ? 'NEXT' : 'LATER',
      theme: format.id === 'gen1cup' ? 'gen1' : 'unknown',
      rulesetId: format.id,
      title: format.title,
      themeLabel: `${format.region} · ${format.restriction}`,
      format,
      startsAt,
      endsAt,
      tournament,
      ...(options.allAvailable ? { when: 'CURRENT' as const } : {}),
    });
  }

  return slots;
}

function tournamentForSlot(
  tournaments: TournamentSummary[],
  rulesetId: string,
  startsAt: number,
  endsAt: number,
): TournamentSummary | undefined {
  const rank = (status: string) => {
    if (status === 'registration' || status === 'draft') return 0;
    if (status === 'ready' || status === 'in-progress' || status === 'active') return 1;
    return 2;
  };
  const matches = tournaments.filter(tournament => {
    if ((tournament.ruleset ?? 'gen9ou') !== rulesetId) return false;
    if (tournament.status === 'cancelled') return false;
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

export function scheduleStatusLabel(slot: ScheduleSlot): string {
  const status = slot.tournament?.status;
  if (status === 'registration' && slot.tournament?.finalizesAt) return 'FINALIZING';
  if (!status) return slot.when === 'CURRENT' ? 'REGISTERING' : 'SCHEDULED';
  if (status === 'registration' || status === 'draft') return 'REGISTERING';
  if (status === 'ready') return 'FULL';
  if (status === 'in-progress' || status === 'active') return 'LIVE';
  if (status === 'completed') return 'COMPLETED';
  return status.toUpperCase();
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
  const totalEntries = entryFee * playerCount;
  const treasuryShare = Math.floor((totalEntries * 9000) / 10_000);
  return {
    symbol: 'POKE',
    entryFee,
    playerCount,
    totalEntries,
    treasuryShare,
    treasuryBps: 9000,
    devOpsShare: totalEntries - treasuryShare,
    devOpsBps: 1000,
    prizePool: treasuryShare,
  };
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

export function shortenPlayer(id?: string): string {
  if (!id) return 'TBD';
  if (id.length <= 12) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}
