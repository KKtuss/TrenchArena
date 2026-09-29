import type { TournamentEconomicsPreview, TournamentSummary } from './protocol';

export const GEN1_CUP_TITLE = 'GEN 1 CUP';
export const GEN1_CUP_THEME = 'GENERATION 1 POKÉMON';
/** Legacy display fallback when chain economy is off. */
export const TOURNAMENT_ENTRY_POKE = 50_000;
/** Approximate USD entry when chain economy quotes POKE. */
export const TOURNAMENT_ENTRY_USD = 5;
export const TOURNAMENT_FIELD_SIZE = 32;
export const SCHEDULE_SLOT_COUNT = 4;
export const HOUR_MS = 60 * 60 * 1000;

export type ScheduleSlotKind = 'now' | 'next';
export type ScheduleTheme = 'gen1' | 'unknown';

export type ScheduleSlot = {
  key: string;
  kind: ScheduleSlotKind;
  theme: ScheduleTheme;
  title: string;
  themeLabel: string;
  startsAt: number;
  endsAt: number;
  tournament?: TournamentSummary;
};

export function hourFloor(now = Date.now()): number {
  const date = new Date(now);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

export function buildTournamentSchedule(
  tournaments: TournamentSummary[],
  now = Date.now(),
): ScheduleSlot[] {
  const anchor = hourFloor(now);
  const active = pickActiveTournament(tournaments);
  const slots: ScheduleSlot[] = [];

  for (let index = 0; index < SCHEDULE_SLOT_COUNT; index += 1) {
    const startsAt = anchor + index * HOUR_MS;
    const endsAt = startsAt + HOUR_MS;
    if (index === 0) {
      slots.push({
        key: active?.id ?? `slot-${startsAt}`,
        kind: 'now',
        theme: 'gen1',
        title: active?.title?.toUpperCase().includes('GEN 1')
          ? active.title.toUpperCase()
          : GEN1_CUP_TITLE,
        themeLabel: GEN1_CUP_THEME,
        startsAt,
        endsAt,
        tournament: active,
      });
      continue;
    }
    slots.push({
      key: `unknown-${startsAt}`,
      kind: 'next',
      theme: 'unknown',
      title: 'UNKNOWN',
      themeLabel: 'THEME TBA',
      startsAt,
      endsAt,
    });
  }

  return slots;
}

function pickActiveTournament(tournaments: TournamentSummary[]): TournamentSummary | undefined {
  const live = tournaments.find(item => (
    ['registration', 'ready', 'in-progress', 'active', 'draft'].includes(item.status)
  ));
  if (live) return live;
  return tournaments.find(item => item.status !== 'completed' && item.status !== 'cancelled');
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
  if (slot.theme === 'unknown') return 'SCHEDULED';
  const status = slot.tournament?.status;
  if (!status) return 'REGISTERING';
  if (status === 'registration' || status === 'draft') return 'REGISTERING';
  if (status === 'ready') return 'FULL';
  if (status === 'in-progress' || status === 'active') return 'LIVE';
  if (status === 'completed') return 'COMPLETED';
  return status.toUpperCase();
}

export function scheduleCtaLabel(slot: ScheduleSlot): string {
  if (slot.theme === 'unknown') return 'LOCKED';
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
