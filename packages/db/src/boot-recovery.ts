import type { EconomicsStore, HoldSnapshot } from './economics-store';
import type { DurableTournament, DurableTournamentMatch, TournamentStore } from './tournament-store';

const TOURNAMENT_HOLD = /^tournament:([^:]+):(.+)$/;
const TOURNAMENT_SETTLEMENT_PREFIX = 'tournament:';

export interface RecoveryLogEvent {
  level: 'info' | 'error';
  phase: string;
  message: string;
  tournamentId?: string;
  matchId?: string;
  holdKey?: string;
  playerId?: string;
  roomId?: string;
}

export interface RecoverDurableStateInput {
  economics: EconomicsStore;
  tournaments: TournamentStore;
  logger?: (event: RecoveryLogEvent) => void;
  /** Test hook: invoked after each successful completed-tournament settlement. */
  afterSettleTournament?: (tournamentId: string) => Promise<void> | void;
  /** Test hook: invoked before settling a completed tournament. */
  beforeSettleTournament?: (tournamentId: string) => Promise<void> | void;
}

export interface RecoveryReport {
  settledTournamentIds: string[];
  interruptedMatchIds: string[];
  releasedOrphanHoldKeys: string[];
  cancelledCasualRoomIds: string[];
  abortedCasualRoomIds: string[];
}

export class RecoveryFailedError extends Error {
  readonly phase: string;
  readonly tournamentId?: string;
  readonly matchId?: string;
  readonly holdKey?: string;
  readonly playerId?: string;
  readonly roomId?: string;

  constructor(
    message: string,
    details: {
      phase: string;
      tournamentId?: string;
      matchId?: string;
      holdKey?: string;
      playerId?: string;
      roomId?: string;
    },
  ) {
    super(message);
    this.name = 'RecoveryFailedError';
    this.phase = details.phase;
    if (details.tournamentId) this.tournamentId = details.tournamentId;
    if (details.matchId) this.matchId = details.matchId;
    if (details.holdKey) this.holdKey = details.holdKey;
    if (details.playerId) this.playerId = details.playerId;
    if (details.roomId) this.roomId = details.roomId;
  }

  get publicMessage(): string {
    const parts = [`${this.message} (phase=${this.phase}`];
    if (this.tournamentId) parts.push(` tournament=${this.tournamentId}`);
    if (this.matchId) parts.push(` match=${this.matchId}`);
    if (this.holdKey) parts.push(` hold=${this.holdKey}`);
    if (this.playerId) parts.push(` player=${this.playerId}`);
    if (this.roomId) parts.push(` room=${this.roomId}`);
    return `${parts.join('')})`;
  }
}

let recoveryChain: Promise<void> = Promise.resolve();

/**
 * Deterministic boot recovery. Safe to run more than once. All economic
 * mutations go through EconomicsStore. Live Showdown state is never rebuilt.
 */
export async function recoverDurableState(
  input: RecoverDurableStateInput,
): Promise<RecoveryReport> {
  let release!: () => void;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  const previous = recoveryChain;
  recoveryChain = previous.then(() => current, () => current);
  await previous;
  try {
    return await runRecovery(input);
  } finally {
    release();
  }
}

async function runRecovery(input: RecoverDurableStateInput): Promise<RecoveryReport> {
  const log = input.logger ?? defaultLogger;
  const report: RecoveryReport = {
    settledTournamentIds: [],
    interruptedMatchIds: [],
    releasedOrphanHoldKeys: [],
    cancelledCasualRoomIds: [],
    abortedCasualRoomIds: [],
  };

  try {
    const tournaments = sortById(await input.tournaments.listTournaments());
    const matchesByTournament = new Map<string, DurableTournamentMatch[]>();
    for (const tournament of tournaments) {
      matchesByTournament.set(
        tournament.id,
        sortMatches(await input.tournaments.listMatches(tournament.id)),
      );
    }
    const holds = await input.economics.listHolds();
    const rooms = await input.economics.listCasualRooms();

    await verifyInvariants({
      economics: input.economics,
      tournaments,
      holds,
    });

    await settleCompletedTournaments({
      economics: input.economics,
      tournaments,
      report,
      log,
      beforeSettleTournament: input.beforeSettleTournament,
      afterSettleTournament: input.afterSettleTournament,
    });

    await releaseOrphanReservedHolds({
      economics: input.economics,
      tournaments,
      holds: await input.economics.listHolds(),
      report,
      log,
    });

    await interruptLiveMatches({
      store: input.tournaments,
      matchesByTournament,
      report,
      log,
    });

    await recoverCasualRooms({
      economics: input.economics,
      rooms,
      holds: await input.economics.listHolds(),
      report,
      log,
    });
  } catch (error) {
    const event = toLogEvent(error);
    log(event);
    if (error instanceof RecoveryFailedError) throw error;
    throw new RecoveryFailedError(
      error instanceof Error ? error.message : 'Boot recovery failed.',
      { phase: event.phase },
    );
  }

  log({
    level: 'info',
    phase: 'complete',
    message: 'Boot recovery finished.',
  });
  return report;
}

async function verifyInvariants(input: {
  economics: EconomicsStore;
  tournaments: DurableTournament[];
  holds: HoldSnapshot[];
}): Promise<void> {
  const tournamentById = new Map(input.tournaments.map(item => [item.id, item]));

  for (const tournament of input.tournaments) {
    const settlementKey = `${TOURNAMENT_SETTLEMENT_PREFIX}${tournament.id}`;
    const settlement = await input.economics.getSettlement(settlementKey);

    if (tournament.status === 'completed' && !tournament.winner) {
      fail('invariants', 'Completed tournament has no winner.', {
        tournamentId: tournament.id,
      });
    }

    if (settlement && tournament.status !== 'completed') {
      fail('invariants', 'Tournament settlement exists without a completed tournament.', {
        tournamentId: tournament.id,
      });
    }

    if (
      settlement
      && tournament.winner
      && settlement.winnerId
      && settlement.winnerId !== tournament.winner
    ) {
      fail('invariants', 'Settlement winner does not match tournament winner.', {
        tournamentId: tournament.id,
      });
    }

    if (tournament.entryFee > 0) {
      for (const player of tournament.players) {
        if (player.status !== 'registered') continue;
        const holdKey = `tournament:${tournament.id}:${player.id}`;
        const hold = await input.economics.getHold(holdKey);
        if (!hold) {
          fail('invariants', 'Registered player is missing an entry hold.', {
            tournamentId: tournament.id,
            playerId: player.id,
            holdKey,
          });
        }
        if (hold.status === 'consumed' && tournament.status !== 'completed') {
          fail('invariants', 'Entry hold is consumed before the tournament completed.', {
            tournamentId: tournament.id,
            playerId: player.id,
            holdKey,
          });
        }
        if (hold.status === 'released' && tournament.status !== 'cancelled') {
          fail('invariants', 'Registered entry hold is released while the tournament is still alive.', {
            tournamentId: tournament.id,
            playerId: player.id,
            holdKey,
          });
        }
        if (hold.amount !== tournament.entryFee) {
          fail('invariants', 'Entry hold amount does not match tournament entry fee.', {
            tournamentId: tournament.id,
            playerId: player.id,
            holdKey,
          });
        }
      }
    }
  }

  for (const hold of input.holds) {
    const parsed = parseTournamentHold(hold);
    if (!parsed) continue;
    const tournament = tournamentById.get(parsed.tournamentId);
    if (!tournament) {
      if (hold.status === 'reserved') continue;
      fail('invariants', 'Terminal tournament hold has no parent tournament.', {
        holdKey: hold.holdKey,
        tournamentId: parsed.tournamentId,
      });
    }
    if (tournament.entryFee === 0) {
      fail('invariants', 'Tournament with no entry fee has an entry hold.', {
        tournamentId: tournament.id,
        holdKey: hold.holdKey,
      });
    }
    const player = tournament.players.find(candidate => candidate.id === hold.playerId);
    if (!player && hold.status === 'consumed') {
      fail('invariants', 'Consumed tournament hold has no matching player row.', {
        tournamentId: tournament.id,
        holdKey: hold.holdKey,
        playerId: hold.playerId,
      });
    }
  }
}

async function settleCompletedTournaments(input: {
  economics: EconomicsStore;
  tournaments: DurableTournament[];
  report: RecoveryReport;
  log: (event: RecoveryLogEvent) => void;
  beforeSettleTournament?: RecoverDurableStateInput['beforeSettleTournament'];
  afterSettleTournament?: RecoverDurableStateInput['afterSettleTournament'];
}): Promise<void> {
  for (const tournament of input.tournaments) {
    if (tournament.status === 'cancelled') continue;
    if (tournament.status !== 'completed' || !tournament.winner) continue;
    const settlementKey = `${TOURNAMENT_SETTLEMENT_PREFIX}${tournament.id}`;
    const alreadySettled = Boolean(await input.economics.getSettlement(settlementKey));
    const registered = tournament.players.filter(player => player.status === 'registered');
    const holdKeys = registered.map(player => `tournament:${tournament.id}:${player.id}`);
    if (input.beforeSettleTournament && !alreadySettled) {
      await input.beforeSettleTournament(tournament.id);
    }
    try {
      await input.economics.completeTournamentWin({
        winnerId: tournament.winner,
        entryFee: tournament.entryFee,
        playerCount: registered.length,
        settlementKey,
        holdKeys,
      });
    } catch (error) {
      if (error instanceof RecoveryFailedError) throw error;
      fail('settle', error instanceof Error ? error.message : 'Tournament settlement failed.', {
        tournamentId: tournament.id,
      });
    }
    if (alreadySettled) continue;
    input.report.settledTournamentIds.push(tournament.id);
    input.log({
      level: 'info',
      phase: 'settle',
      message: 'Completed tournament settlement is present.',
      tournamentId: tournament.id,
    });
    if (input.afterSettleTournament) await input.afterSettleTournament(tournament.id);
  }
}

async function releaseOrphanReservedHolds(input: {
  economics: EconomicsStore;
  tournaments: DurableTournament[];
  holds: HoldSnapshot[];
  report: RecoveryReport;
  log: (event: RecoveryLogEvent) => void;
}): Promise<void> {
  const tournamentById = new Map(input.tournaments.map(item => [item.id, item]));
  for (const hold of input.holds) {
    if (hold.status !== 'reserved') continue;
    const parsed = parseTournamentHold(hold);
    if (!parsed) continue;
    const tournament = tournamentById.get(parsed.tournamentId);
    if (tournament) {
      const player = tournament.players.find(candidate => candidate.id === hold.playerId);
      if (player) continue;
    }
    await input.economics.release(hold.holdKey);
    input.report.releasedOrphanHoldKeys.push(hold.holdKey);
    input.log({
      level: 'info',
      phase: 'orphan-hold',
      message: 'Released reserved tournament hold with no matching player row.',
      tournamentId: parsed.tournamentId,
      holdKey: hold.holdKey,
      playerId: hold.playerId,
    });
  }
}

async function interruptLiveMatches(input: {
  store: TournamentStore;
  matchesByTournament: Map<string, DurableTournamentMatch[]>;
  report: RecoveryReport;
  log: (event: RecoveryLogEvent) => void;
}): Promise<void> {
  const matches = [...input.matchesByTournament.values()].flat().sort((left, right) => (
    left.id.localeCompare(right.id)
  ));
  for (const match of matches) {
    if (match.status !== 'battle-created' && match.status !== 'active') continue;
    const interrupted = await input.store.interruptMatch(match.id);
    if (interrupted.winner) {
      fail('interrupt', 'Interrupted match recovery must not invent a winner.', {
        tournamentId: match.tournamentId,
        matchId: match.id,
      });
    }
    input.report.interruptedMatchIds.push(match.id);
    input.log({
      level: 'info',
      phase: 'interrupt',
      message: 'Live Showdown match marked interrupted; no winner was assigned.',
      tournamentId: match.tournamentId,
      matchId: match.id,
    });
  }
}

async function recoverCasualRooms(input: {
  economics: EconomicsStore;
  rooms: Awaited<ReturnType<EconomicsStore['listCasualRooms']>>;
  holds: HoldSnapshot[];
  report: RecoveryReport;
  log: (event: RecoveryLogEvent) => void;
}): Promise<void> {
  const roomById = new Map(input.rooms.map(room => [room.id, room]));
  for (const hold of input.holds) {
    if (hold.status !== 'reserved') continue;
    const roomId = hold.roomId ?? casualRoomIdFromKey(hold.holdKey);
    if (!roomId) continue;
    if (roomById.has(roomId)) continue;
    await input.economics.release(hold.holdKey);
    input.report.releasedOrphanHoldKeys.push(hold.holdKey);
    input.log({
      level: 'info',
      phase: 'orphan-hold',
      message: 'Released reserved casual hold with no matching room.',
      holdKey: hold.holdKey,
      roomId,
    });
  }

  for (const room of [...input.rooms].sort((left, right) => left.id.localeCompare(right.id))) {
    if (room.status === 'completed' || room.status === 'cancelled') continue;
    if (room.status === 'starting' || room.status === 'battling') {
      await input.economics.abortCasualRoom(room.id);
      input.report.abortedCasualRoomIds.push(room.id);
      input.log({
        level: 'info',
        phase: 'casual',
        message: 'Aborted in-flight casual room after process restart.',
        roomId: room.id,
      });
      continue;
    }
    await input.economics.cancelCasualRoom(room.id);
    input.report.cancelledCasualRoomIds.push(room.id);
    input.log({
      level: 'info',
      phase: 'casual',
      message: 'Cancelled pre-battle casual room after process restart.',
      roomId: room.id,
    });
  }
}

function parseTournamentHold(hold: HoldSnapshot): { tournamentId: string; playerId: string } | undefined {
  if (hold.purpose && hold.purpose !== 'tournament_entry') return undefined;
  const tournamentId = hold.tournamentId ?? TOURNAMENT_HOLD.exec(hold.holdKey)?.[1];
  const playerId = hold.playerId ?? TOURNAMENT_HOLD.exec(hold.holdKey)?.[2];
  if (!tournamentId || !playerId) return undefined;
  if (hold.purpose !== 'tournament_entry' && !hold.holdKey.startsWith('tournament:')) return undefined;
  return { tournamentId, playerId };
}

function casualRoomIdFromKey(holdKey: string): string | undefined {
  const match = /^casual:([^:]+):(creator|opponent)$/.exec(holdKey);
  return match?.[1];
}

function sortById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.id.localeCompare(right.id));
}

function sortMatches(matches: DurableTournamentMatch[]): DurableTournamentMatch[] {
  return [...matches].sort((left, right) => left.id.localeCompare(right.id));
}

function fail(
  phase: string,
  message: string,
  details: Omit<ConstructorParameters<typeof RecoveryFailedError>[1], 'phase'> = {},
): never {
  throw new RecoveryFailedError(message, { phase, ...details });
}

function toLogEvent(error: unknown): RecoveryLogEvent {
  if (error instanceof RecoveryFailedError) {
    return {
      level: 'error',
      phase: error.phase,
      message: error.publicMessage,
      ...(error.tournamentId ? { tournamentId: error.tournamentId } : {}),
      ...(error.matchId ? { matchId: error.matchId } : {}),
      ...(error.holdKey ? { holdKey: error.holdKey } : {}),
      ...(error.playerId ? { playerId: error.playerId } : {}),
      ...(error.roomId ? { roomId: error.roomId } : {}),
    };
  }
  return {
    level: 'error',
    phase: 'unexpected',
    message: error instanceof Error ? error.message : 'Boot recovery failed.',
  };
}

function defaultLogger(event: RecoveryLogEvent): void {
  const payload = {
    phase: event.phase,
    message: event.message,
    ...(event.tournamentId ? { tournamentId: event.tournamentId } : {}),
    ...(event.matchId ? { matchId: event.matchId } : {}),
    ...(event.holdKey ? { holdKey: event.holdKey } : {}),
    ...(event.playerId ? { playerId: event.playerId } : {}),
    ...(event.roomId ? { roomId: event.roomId } : {}),
  };
  if (event.level === 'error') console.error('[pokearena-recovery]', payload);
  else console.info('[pokearena-recovery]', payload);
}
