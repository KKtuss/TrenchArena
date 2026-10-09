import type { CasualPreviewMon } from './protocol';
import { formatById } from './tournament-formats';
import {
  previewTreasuryPrize,
  roundLabel,
  TOURNAMENT_FIELD_SIZE,
} from './tournament-schedule';

export type BracketMatch = {
  id: string;
  round: number;
  bracketPosition: number;
  role?: 'elimination' | 'third-place';
  player1?: string;
  player2?: string;
  status: string;
  winner?: string;
  startedAt?: number;
  completedAt?: number;
  placeholder?: boolean;
  result?: {
    kind?: string;
    reason?: string;
    battleResult?: {
      score?: number[];
      turns?: number;
      endedBy?: string;
      winner?: string;
    };
  };
};

export type TournamentPlayer = {
  id: string;
  status: string;
  displayName?: string;
  team?: string;
  teamLocked?: boolean;
  burnFeePaid?: boolean;
};

export type TournamentDetail = {
  id: string;
  title: string;
  format: string;
  ruleset?: string;
  preset?: {
    id: string;
    name: string;
    pokemon: CasualPreviewMon[];
  };
  status: string;
  maxPlayers: number;
  players?: TournamentPlayer[];
  bracket?: BracketMatch[];
  entryFee?: number;
  hostId?: string;
  finalizesAt?: number;
  paymentEndsAt?: number;
  paymentPlayerId?: string;
  entryAtoms?: number;
  burnFeeAtoms?: number;
  matchTimeoutMs?: number;
  prizeLamports?: number;
  prizeCardsRaw?: number;
  rail?: string;
  economics?: {
    prizePool: number;
    entryFee: number;
    playerCount: number;
    treasuryShare: number;
  };
  winner?: string;
  payout?: unknown;
};

export type HubStatus = 'LIVE' | 'UPCOMING' | 'COMPLETED' | 'CANCELLED';
export type ProgressionState = 'done' | 'current' | 'upcoming';

export type ProgressionStep = {
  round: number;
  label: string;
  state: ProgressionState;
};

export type MatchTone = 'live' | 'ready' | 'done' | 'future' | 'waiting';

const LIVE_MATCH_STATUSES = new Set(['active', 'battle-created']);
const PLAYABLE_MATCH_STATUSES = new Set(['ready', 'active', 'battle-created']);
const SETTLED_MATCH_STATUSES = new Set(['completed', 'forfeited', 'tied']);
const LIVE_TOURNAMENT_STATUSES = new Set(['in-progress', 'active']);
const UPCOMING_TOURNAMENT_STATUSES = new Set(['draft', 'registration', 'ready']);

export function registeredPlayers(tournament?: TournamentDetail | null): TournamentPlayer[] {
  return (tournament?.players ?? []).filter(player => player.status === 'registered');
}

export function displayHubStatus(
  tournament: {
    status?: string;
    payout?: unknown;
    rail?: string;
    prizeLamports?: number;
    prizeCardsRaw?: number;
    economics?: { prizePool?: number };
  } | null | undefined,
  matches: BracketMatch[],
): HubStatus {
  const status = tournament?.status;
  if (status === 'cancelled') return hubStatus(status);
  const finalRound = matches.reduce((max, match) => Math.max(max, match.round), 0);
  const third = matches.find(match => (
    match.role === 'third-place'
    || (finalRound > 1 && match.round === finalRound && match.bracketPosition === 1
      && matches.some(item => item.round === finalRound && item.bracketPosition === 0))
  ));
  if (
    (status === 'in-progress' || status === 'completed')
    && third
    && !third.winner
  ) {
    return 'LIVE';
  }
  const prize = tournament?.rail === 'sol_chain'
    ? (tournament.prizeCardsRaw ?? tournament.prizeLamports ?? 0)
    : (tournament?.economics?.prizePool ?? 0);
  if (status === 'completed' && prize > 0 && !tournament?.payout) return 'LIVE';
  return hubStatus(status);
}

export function hubStatus(status?: string): HubStatus {
  if (status === 'completed') return 'COMPLETED';
  if (status === 'cancelled') return 'CANCELLED';
  if (status && LIVE_TOURNAMENT_STATUSES.has(status)) return 'LIVE';
  return 'UPCOMING';
}

export function formatName(format?: string): string {
  const card = formatById(format);
  if (card && card.id !== 'gen9ou') return card.title;
  if (!format || format === 'gen9ou') return 'Gen 9 OU';
  return format.toUpperCase();
}

export function totalRounds(maxPlayers: number): number {
  const field = Math.max(2, maxPlayers || TOURNAMENT_FIELD_SIZE);
  return Math.round(Math.log2(field));
}

/** Size of the bracket that was actually generated. The cup cap can stay 32 after a 2-player start. */
export function bracketFieldSize(matches: BracketMatch[], maxPlayers: number): number {
  const round1 = matches.filter(match => match.round === 1).length;
  if (round1 > 0 && (round1 & (round1 - 1)) === 0) return round1 * 2;
  return Math.max(2, maxPlayers || TOURNAMENT_FIELD_SIZE);
}

export function roundTitles(maxPlayers: number): string[] {
  const rounds = totalRounds(maxPlayers);
  return Array.from({ length: rounds }, (_, index) => roundLabel(index + 1, maxPlayers));
}

export function isLiveMatch(status: string): boolean {
  return LIVE_MATCH_STATUSES.has(status);
}

export function isPlayableMatch(status: string): boolean {
  return PLAYABLE_MATCH_STATUSES.has(status);
}

export function isSettledMatch(status: string): boolean {
  return SETTLED_MATCH_STATUSES.has(status);
}

export function matchTone(status: string): MatchTone {
  if (isLiveMatch(status)) return 'live';
  if (status === 'ready') return 'ready';
  if (isSettledMatch(status)) return 'done';
  if (status === 'interrupted') return 'waiting';
  return 'future';
}

export function matchStatusLabel(status: string): string {
  if (isLiveMatch(status)) return 'LIVE';
  if (status === 'ready') return 'READY';
  if (status === 'pending') return 'WAITING';
  if (status === 'completed') return 'FINAL';
  if (status === 'forfeited') return 'FORFEIT';
  if (status === 'tied') return 'TIE';
  if (status === 'interrupted') return 'PAUSED';
  return status.replace(/-/g, ' ').toUpperCase();
}

export function currentRound(matches: BracketMatch[], status?: string): number {
  const rounds = matches.reduce((max, match) => Math.max(max, match.round), 1);
  if (status === 'completed') return rounds;
  if (!matches.length || (status && UPCOMING_TOURNAMENT_STATUSES.has(status))) return 1;
  const open = matches.filter(match => !isSettledMatch(match.status));
  if (!open.length) return rounds;
  return Math.min(...open.map(match => match.round));
}

export function progressionSteps(
  maxPlayers: number,
  round: number,
  status?: string,
): ProgressionStep[] {
  const completed = status === 'completed';
  return roundTitles(maxPlayers).map((label, index) => {
    const stepRound = index + 1;
    if (completed || stepRound < round) return { round: stepRound, label, state: 'done' };
    if (stepRound === round) return { round: stepRound, label, state: 'current' };
    return { round: stepRound, label, state: 'upcoming' };
  });
}

export function sortRound(matches: BracketMatch[], round: number): BracketMatch[] {
  return matches
    .filter(match => match.round === round)
    .sort((a, b) => a.bracketPosition - b.bracketPosition);
}

export function emptyBracket(maxPlayers: number, tournamentId = 'preview'): BracketMatch[] {
  const field = maxPlayers || TOURNAMENT_FIELD_SIZE;
  const rounds = totalRounds(field);
  const matches: BracketMatch[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    const count = field / (2 ** round);
    for (let bracketPosition = 0; bracketPosition < count; bracketPosition += 1) {
      matches.push({
        id: `pending-${tournamentId}-r${round}-p${bracketPosition}`,
        round,
        bracketPosition,
        role: 'elimination',
        status: 'pending',
        placeholder: true,
      });
    }
  }
  if (field >= 4) {
    matches.push({
      id: `pending-${tournamentId}-third`,
      round: rounds,
      bracketPosition: 1,
      role: 'third-place',
      status: 'pending',
      placeholder: true,
    });
  }
  return matches;
}

export function visibleBracket(tournament: TournamentDetail): BracketMatch[] {
  const maxPlayers = tournament.maxPlayers || TOURNAMENT_FIELD_SIZE;
  if (tournament.bracket?.length) return tournament.bracket;
  return emptyBracket(maxPlayers, tournament.id);
}

export function groupedRounds(matches: BracketMatch[], maxPlayers: number): Array<{
  round: number;
  label: string;
  matches: BracketMatch[];
}> {
  const rounds = totalRounds(maxPlayers);
  return Array.from({ length: rounds }, (_, index) => {
    const round = index + 1;
    return {
      round,
      label: roundLabel(round, maxPlayers),
      matches: sortRound(matches, round),
    };
  }).filter(group => group.matches.length > 0);
}

export function playerScore(match: BracketMatch, playerId?: string): number | null {
  if (!playerId || !isSettledMatch(match.status)) return null;
  const score = match.result?.battleResult?.score;
  if (score && score.length >= 2) {
    if (playerId === match.player1 && score[0] !== undefined) return score[0];
    if (playerId === match.player2 && score[1] !== undefined) return score[1];
  }
  if (match.status === 'tied') return 0;
  if (!match.winner) return null;
  return match.winner === playerId ? 1 : 0;
}

export function matchDurationMs(match: BracketMatch): number | null {
  if (!match.startedAt || !match.completedAt || match.completedAt < match.startedAt) return null;
  return match.completedAt - match.startedAt;
}

export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function formatTimeout(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return '5:00';
  return formatClock(ms);
}

export function userMatchIds(matches: BracketMatch[], playerId?: string | null): Set<string> {
  const ids = new Set<string>();
  if (!playerId) return ids;
  for (const match of matches) {
    if (match.player1 === playerId || match.player2 === playerId) ids.add(match.id);
  }
  return ids;
}

export function findLiveMatch(matches: BracketMatch[]): BracketMatch | undefined {
  return matches.find(match => isLiveMatch(match.status));
}

export function findPlayerMatch(
  matches: BracketMatch[],
  playerId?: string | null,
): BracketMatch | undefined {
  if (!playerId) return undefined;
  const mine = matches.filter(match => match.player1 === playerId || match.player2 === playerId);
  return mine.find(match => isPlayableMatch(match.status))
    ?? mine.find(match => match.status === 'interrupted')
    ?? mine.find(match => !isSettledMatch(match.status))
    ?? [...mine].reverse()[0];
}

export function opponentId(match: BracketMatch, playerId: string): string | undefined {
  if (match.player1 === playerId) return match.player2;
  if (match.player2 === playerId) return match.player1;
  return undefined;
}

export function eliminatedIn(
  matches: BracketMatch[],
  playerId: string,
): BracketMatch | undefined {
  return matches.find(match => (
    isSettledMatch(match.status)
    && (match.player1 === playerId || match.player2 === playerId)
    && match.winner
    && match.winner !== playerId
  ));
}

export type PlayerHubKind =
  | 'connect'
  | 'champion'
  | 'complete'
  | 'watching-final'
  | 'live'
  | 'next'
  | 'eliminated'
  | 'registered-locked'
  | 'registered-waiting'
  | 'register'
  | 'waiting-next'
  | 'watching';

export type PlayerHubStatus = {
  kind: PlayerHubKind;
  match?: BracketMatch;
  opponentId?: string;
  roundLabel?: string;
};

export function playerHubStatus(
  tournament: TournamentDetail,
  matches: BracketMatch[],
  playerId?: string | null,
): PlayerHubStatus {
  const status = hubStatus(tournament.status);
  const registered = registeredPlayers(tournament).some(player => player.id === playerId);
  if (!playerId) return { kind: 'connect' };
  if (tournament.winner === playerId) return { kind: 'champion' };
  if (status === 'COMPLETED') {
    return { kind: registered ? 'complete' : 'watching-final' };
  }
  const next = findPlayerMatch(matches, playerId);
  if (next && isLiveMatch(next.status)) {
    return { kind: 'live', match: next, opponentId: opponentId(next, playerId) };
  }
  if (next && next.status === 'ready') {
    return { kind: 'next', match: next, opponentId: opponentId(next, playerId) };
  }
  const lost = eliminatedIn(matches, playerId);
  if (lost) {
    return {
      kind: 'eliminated',
      match: lost,
      roundLabel: roundLabel(lost.round, tournament.maxPlayers),
    };
  }
  if (registered && status === 'UPCOMING') {
    return { kind: tournament.status === 'ready' ? 'registered-locked' : 'registered-waiting' };
  }
  if (!registered && (tournament.status === 'registration' || tournament.status === 'draft')) {
    return { kind: 'register' };
  }
  if (registered) return { kind: 'waiting-next' };
  return { kind: 'watching' };
}

/** The viewer's ready or live cup fight, if the bracket has one. */
export function ownPlayableMatch(
  tournament: { bracket?: BracketMatch[] } | null | undefined,
  playerId?: string | null,
): BracketMatch | undefined {
  if (!playerId || !tournament?.bracket) return undefined;
  const match = findPlayerMatch(
    tournament.bracket.filter(item => !item.placeholder),
    playerId,
  );
  if (!match || !isPlayableMatch(match.status)) return undefined;
  return match;
}

export function matchActionLabel(
  match: BracketMatch,
  playerId?: string | null,
): string | null {
  if (match.placeholder) return null;
  const mine = Boolean(playerId && (match.player1 === playerId || match.player2 === playerId));
  if (isPlayableMatch(match.status)) return mine ? 'Enter battle' : 'View match';
  if (isSettledMatch(match.status) || match.status === 'interrupted') return 'View match';
  return null;
}

export function canOpenMatch(match: BracketMatch): boolean {
  return !match.placeholder && match.status !== 'pending';
}

export type TournamentPodium = {
  final?: BracketMatch;
  thirdPlace?: BracketMatch;
  first?: string;
  second?: string;
  third?: string;
};

/** Places come from settled matches only. The 3rd-place match is the second match of the last round. */
export function tournamentPodium(matches: BracketMatch[], winner?: string): TournamentPodium {
  const real = matches.filter(match => !match.placeholder);
  const lastRound = real.reduce((max, match) => Math.max(max, match.round), 0);
  const final = real.find(match => (
    match.round === lastRound && match.bracketPosition === 0 && match.role !== 'third-place'
  ));
  const thirdPlace = real.find(match => (
    match.role === 'third-place' || (lastRound > 1 && match.round === lastRound && match.bracketPosition === 1)
  ));
  const finalWinner = final && isSettledMatch(final.status) ? final.winner : undefined;
  const first = winner ?? finalWinner;
  const second = first && final && (final.player1 === first || final.player2 === first)
    ? opponentId(final, first)
    : undefined;
  const third = thirdPlace && isSettledMatch(thirdPlace.status) ? thirdPlace.winner : undefined;
  return { final, thirdPlace, first, second, third };
}

export type MockBracketOptions = {
  id?: string;
  title?: string;
  maxPlayers?: 4 | 8 | 16 | 32;
  status?: TournamentDetail['status'];
  viewerId?: string;
  currentRound?: number;
  champion?: boolean;
};

/**
 * Realistic in-memory bracket for UI work when a live tournament payload
 * is not available. Replace by passing a subscribed `TournamentDetail`.
 */
export function buildMockTournament(options: MockBracketOptions = {}): TournamentDetail {
  const maxPlayers = options.maxPlayers ?? 16;
  const id = options.id ?? 'mock-cup-01';
  const viewerId = options.viewerId ?? 'you';
  const players = Array.from({ length: maxPlayers }, (_, index) => ({
    id: index === 0 ? viewerId : `trainer-${String(index + 1).padStart(2, '0')}`,
    status: 'registered',
    displayName: index === 0 ? 'You' : `Trainer ${index + 1}`,
  }));
  const throughRound = options.champion
    ? totalRounds(maxPlayers)
    : Math.min(options.currentRound ?? 2, totalRounds(maxPlayers));
  const status = options.status
    ?? (options.champion ? 'completed' : throughRound > 1 ? 'in-progress' : 'registration');
  const matches = emptyBracket(maxPlayers, id).map(match => ({ ...match, placeholder: false }));

  const winnersByRound = new Map<string, string>();
  for (const match of matches) {
    if (match.role === 'third-place') {
      const semiRound = match.round - 1;
      const loserOf = (position: number) => {
        const semi = matches.find(item => item.round === semiRound && item.bracketPosition === position && item.role !== 'third-place');
        if (!semi?.winner || !semi.player1 || !semi.player2) return undefined;
        return semi.winner === semi.player1 ? semi.player2 : semi.player1;
      };
      const left = loserOf(0);
      const right = loserOf(1);
      if (left) match.player1 = left;
      if (right) match.player2 = right;
    } else if (match.round === 1) {
      match.player1 = players[match.bracketPosition * 2]?.id;
      match.player2 = players[match.bracketPosition * 2 + 1]?.id;
    } else {
      const left = winnersByRound.get(`${match.round - 1}:${match.bracketPosition * 2}`);
      const right = winnersByRound.get(`${match.round - 1}:${match.bracketPosition * 2 + 1}`);
      if (left) match.player1 = left;
      if (right) match.player2 = right;
    }

    if (match.round < throughRound && match.player1 && match.player2) {
      match.status = 'completed';
      match.winner = match.bracketPosition % 2 === 0 ? match.player1 : match.player2;
      const p1Won = match.winner === match.player1;
      match.result = { kind: 'battle', battleResult: { score: p1Won ? [1, 0] : [0, 1], turns: 8 } };
      match.startedAt = 1;
      match.completedAt = 96_000;
    } else if (match.round === throughRound && match.player1 && match.player2 && status !== 'registration') {
      if (options.champion) {
        match.status = 'completed';
        match.winner = match.player1;
        match.result = { kind: 'battle', battleResult: { score: [1, 0], turns: 12 } };
      } else if (match.bracketPosition === 0) {
        match.status = 'active';
      } else {
        match.status = 'ready';
      }
    } else if (match.player1 || match.player2) {
      match.status = match.player1 && match.player2 ? 'ready' : 'pending';
    }
    if (match.winner) winnersByRound.set(`${match.round}:${match.bracketPosition}`, match.winner);
  }

  const winner = options.champion
    ? matches.find(match => (
      match.round === totalRounds(maxPlayers)
      && match.bracketPosition === 0
      && match.role !== 'third-place'
    ))?.winner
    : undefined;

  const economics = previewTreasuryPrize(50_000, maxPlayers);
  return {
    id,
    title: options.title ?? 'PokeArena Cup #01',
    format: 'gen9ou',
    status,
    maxPlayers,
    players,
    bracket: matches,
    entryFee: 50_000,
    matchTimeoutMs: 300_000,
    economics,
    ...(winner ? { winner } : {}),
  };
}
