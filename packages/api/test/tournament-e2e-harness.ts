import { randomUUID } from 'node:crypto';

import type {
  BattleEngine,
  BattleResult,
  BattleSession,
  BattleTerminal,
  CreateBattleInput,
} from '@pokearena/battle-engine';
import {
  createTournamentPlayerId,
  InMemoryAsyncTournamentRepository,
  TournamentService,
  type Tournament,
  type TournamentMatch,
  type TournamentPlayerId,
} from '@pokearena/tournament';

import { DEMO_TEAM_ONE, DEMO_TEAM_TWO } from '../src/demo-teams';
import { InMemoryEconomicsStore } from '../src/memory-economics-store';
import {
  DEFAULT_TOURNAMENT_ENTRY_POKE,
  MockEconomics,
  type MockPayoutResult,
} from '../src/mock-economics';

export const BRACKET_SEED = 'tournament-e2e-seed-v1';
export const ENTRY_FEE = DEFAULT_TOURNAMENT_ENTRY_POKE;
export const PLAYER_COUNT = 32;

export type StageStatus = 'PASS' | 'FAIL' | 'INFO' | 'SKIP';

export interface StageLine {
  status: StageStatus;
  stage: string;
  detail: string;
  expected?: string;
  actual?: string;
}

export class StageReport {
  readonly lines: StageLine[] = [];
  private failures = 0;

  pass(stage: string, detail: string, expected?: string, actual?: string): void {
    this.lines.push({ status: 'PASS', stage, detail, expected, actual });
  }

  fail(stage: string, detail: string, expected?: string, actual?: string): void {
    this.failures += 1;
    this.lines.push({ status: 'FAIL', stage, detail, expected, actual });
  }

  info(stage: string, detail: string): void {
    this.lines.push({ status: 'INFO', stage, detail });
  }

  skip(stage: string, detail: string): void {
    this.lines.push({ status: 'SKIP', stage, detail });
  }

  check(
    stage: string,
    detail: string,
    ok: boolean,
    expected?: unknown,
    actual?: unknown,
  ): void {
    const expectedText = expected === undefined ? undefined : stringify(expected);
    const actualText = actual === undefined ? undefined : stringify(actual);
    if (ok) this.pass(stage, detail, expectedText, actualText);
    else this.fail(stage, detail, expectedText, actualText);
  }

  get failed(): boolean {
    return this.failures > 0;
  }

  get failureCount(): number {
    return this.failures;
  }

  print(title: string): void {
    const border = '='.repeat(72);
    console.log(`\n${border}`);
    console.log(title);
    console.log(border);
    for (const line of this.lines) {
      const suffix = line.expected !== undefined || line.actual !== undefined
        ? ` | expected=${line.expected ?? '-'} actual=${line.actual ?? '-'}`
        : '';
      console.log(`[${line.status}] ${line.stage}: ${line.detail}${suffix}`);
    }
    console.log(border);
    console.log(
      this.failed
        ? `RESULT: FAIL (${this.failures} assertion(s) failed)`
        : 'RESULT: PASS',
    );
    console.log(`${border}\n`);
  }

  assertAllPassed(title: string): void {
    this.print(title);
    if (this.failed) {
      throw new Error(`${title}: ${this.failures} assertion(s) failed.`);
    }
  }
}

export interface SyntheticPlayer {
  id: TournamentPlayerId;
  displayName: string;
  team: string;
  wallet: string;
}

export function makeSyntheticPlayers(count = PLAYER_COUNT): SyntheticPlayer[] {
  return Array.from({ length: count }, (_, index) => {
    const n = String(index + 1).padStart(2, '0');
    // MockEconomics treats IDs of length >= 32 as wallet-like identities.
    const wallet = `TestWallet${n}${'X'.repeat(34)}`;
    return {
      id: createTournamentPlayerId(wallet),
      displayName: `Test Trainer ${n}`,
      team: index % 2 === 0 ? DEMO_TEAM_ONE : DEMO_TEAM_TWO,
      wallet,
    };
  });
}

/**
 * Mirrors packages/tournament/src/bracket.ts deterministicOrder so the harness
 * can assert expected first-round pairings without changing production exports.
 */
export function expectedSeededOrder(
  playerIds: readonly TournamentPlayerId[],
  seed: string,
): TournamentPlayerId[] {
  const output = [...playerIds];
  let state = hashSeed(seed);
  for (let index = output.length - 1; index > 0; index -= 1) {
    state = nextState(state);
    const swapIndex = state % (index + 1);
    [output[index], output[swapIndex]] = [output[swapIndex], output[index]];
  }
  return output;
}

export function expectedFirstRoundPairings(
  playerIds: readonly TournamentPlayerId[],
  seed: string,
): Array<[TournamentPlayerId, TournamentPlayerId]> {
  const shuffled = expectedSeededOrder(playerIds, seed);
  const pairings: Array<[TournamentPlayerId, TournamentPlayerId]> = [];
  for (let i = 0; i < shuffled.length; i += 2) {
    pairings.push([shuffled[i], shuffled[i + 1]]);
  }
  return pairings;
}

/** With a player1-always-wins policy, the champion is the top of the seeded tree. */
export function expectedChampionAlwaysPlayer1(
  playerIds: readonly TournamentPlayerId[],
  seed: string,
): TournamentPlayerId {
  let remaining = expectedSeededOrder(playerIds, seed);
  while (remaining.length > 1) {
    const next: TournamentPlayerId[] = [];
    for (let i = 0; i < remaining.length; i += 2) {
      next.push(remaining[i]);
    }
    remaining = next;
  }
  return remaining[0];
}

export type FakeBattleMode = 'instant-player1-win' | 'hang' | 'failed-then-hang';

export interface FakeBattleEngineControls {
  engine: BattleEngine;
  created: CreateBattleInput[];
  sessions: FakeBattleSession[];
  setNextMode(mode: FakeBattleMode): void;
  settlementProbe: SettlementProbe;
}

export interface FakeBattleSession {
  id: string;
  players: [string, string];
  mode: FakeBattleMode;
  terminalListeners: Array<(terminal: BattleTerminal) => void>;
  result: BattleResult | undefined;
  lifecycle: 'created' | 'awaiting-choice' | 'ended' | 'failed';
  completeAs(winnerId: string, endedBy?: 'timeout'): void;
  asSession(): BattleSession;
}

export function createFakeBattleEngine(
  defaultMode: FakeBattleMode = 'instant-player1-win',
): FakeBattleEngineControls {
  const created: CreateBattleInput[] = [];
  const sessions: FakeBattleSession[] = [];
  let nextMode: FakeBattleMode = defaultMode;
  const settlementProbe = new SettlementProbe();

  const engine = {
    async createBattle(input: CreateBattleInput) {
      created.push(input);
      const mode = nextMode;
      nextMode = defaultMode;
      const session = createFakeSession(input, mode);
      sessions.push(session);
      return session.asSession();
    },
  } as unknown as BattleEngine;

  return {
    engine,
    created,
    sessions,
    setNextMode(mode) {
      nextMode = mode;
    },
    settlementProbe,
  };
}

function createFakeSession(input: CreateBattleInput, mode: FakeBattleMode): FakeBattleSession {
  const id = `fake-battle-${randomUUID()}`;
  const players: [string, string] = [input.players[0].id, input.players[1].id];
  const terminalListeners: Array<(terminal: BattleTerminal) => void> = [];
  const session: FakeBattleSession = {
    id,
    players,
    mode,
    terminalListeners,
    result: undefined,
    lifecycle: 'created',
    completeAs(winnerId, endedBy) {
      if (session.result) return;
      session.result = {
        status: 'win',
        winner: winnerId,
        score: winnerId === players[0] ? [1, 0] : [0, 1],
        turns: 1,
        ...(endedBy ? { endedBy } : {}),
      };
      session.lifecycle = 'ended';
      const terminal: BattleTerminal = { type: 'completed', result: session.result };
      for (const listener of [...terminalListeners]) listener(terminal);
    },
    asSession() {
      return {
        id,
        async start() {
          if (mode === 'instant-player1-win') {
            session.completeAs(players[0]);
            return;
          }
          if (mode === 'failed-then-hang') {
            session.lifecycle = 'failed';
            for (const listener of [...terminalListeners]) {
              listener({
                type: 'failed',
                failure: { code: 'simulator-error', message: 'synthetic failure' },
              });
            }
            session.lifecycle = 'awaiting-choice';
            return;
          }
          session.lifecycle = 'awaiting-choice';
        },
        getResult: () => session.result,
        getState: () => ({
          id,
          lifecycle: session.lifecycle,
          format: input.format,
          players: [
            { id: players[0], name: input.players[0].name ?? players[0] },
            { id: players[1], name: input.players[1].name ?? players[1] },
          ],
          ...(session.result ? { result: session.result } : {}),
          ...(session.lifecycle === 'awaiting-choice'
            ? {
                request: {
                  playerId: players[0],
                  revision: 1,
                  kind: 'move' as const,
                  choices: [{ type: 'move' as const, slot: 1, terastallize: false }],
                },
              }
            : {}),
        }),
        getView: () => ({ sides: [] }),
        getEvents: () => [],
        subscribe(listener: (terminal: BattleTerminal) => void) {
          terminalListeners.push(listener);
          if (session.result) {
            queueMicrotask(() => listener({ type: 'completed', result: session.result! }));
          }
          return () => {
            const index = terminalListeners.indexOf(listener);
            if (index >= 0) terminalListeners.splice(index, 1);
          };
        },
        subscribeEvents() {
          return () => undefined;
        },
        async submitChoice() {
          return undefined;
        },
        async forfeit(playerId: string) {
          const winner = playerId === players[0] ? players[1] : players[0];
          session.completeAs(winner);
        },
      } as unknown as BattleSession;
    },
  };
  return session;
}

export class SettlementProbe {
  readonly calls: Array<{
    winnerId: string;
    entryFee: number;
    playerCount: number;
    settlementKey?: string;
    holdKeys: string[];
    amount: number;
  }> = [];

  wrap(store: InMemoryEconomicsStore): InMemoryEconomicsStore {
    const original = store.completeTournamentWin.bind(store);
    store.completeTournamentWin = async input => {
      const payout = await original(input);
      this.calls.push({
        winnerId: input.winnerId,
        entryFee: input.entryFee,
        playerCount: input.playerCount,
        settlementKey: input.settlementKey,
        holdKeys: [...input.holdKeys],
        amount: payout.amount,
      });
      return payout;
    };
    return store;
  }

  get callCount(): number {
    return this.calls.length;
  }
}

export interface TournamentHarness {
  economics: MockEconomics;
  store: InMemoryEconomicsStore;
  repository: InMemoryAsyncTournamentRepository;
  battles: FakeBattleEngineControls;
  tournaments: TournamentService;
  report: StageReport;
  reset(): void;
}

export function createTournamentHarness(
  battleMode: FakeBattleMode = 'instant-player1-win',
): TournamentHarness {
  const report = new StageReport();
  const economics = new MockEconomics({ devFaucet: true });
  const store = new InMemoryEconomicsStore(economics);
  const repository = new InMemoryAsyncTournamentRepository(undefined, {
    reserve: (holdKey, playerId, amount) => store.reserve(holdKey, playerId, amount),
    release: holdKey => store.release(holdKey),
  });
  const battles = createFakeBattleEngine(battleMode);
  battles.settlementProbe.wrap(store);
  const tournaments = new TournamentService({
    battleEngine: battles.engine,
    repository,
  });
  return {
    economics,
    store,
    repository,
    battles,
    tournaments,
    report,
    reset() {
      // Fresh harness instances are preferred; this documents the cleanup contract.
      report.info('cleanup', 'Harness instances are not reused across scenarios.');
    },
  };
}

export async function registerField(
  service: TournamentService,
  tournamentId: Tournament['id'],
  players: readonly SyntheticPlayer[],
  economics: MockEconomics,
): Promise<void> {
  for (const player of players) {
    economics.ensureWallet(player.wallet);
    await service.registerPlayer(tournamentId, {
      playerId: player.id,
      displayName: player.displayName,
      team: player.team,
    });
  }
}

export async function settleCompletedTournament(
  store: InMemoryEconomicsStore,
  tournament: Tournament,
  winnerId: string,
): Promise<MockPayoutResult> {
  const registered = tournament.players.filter(player => player.status === 'registered');
  return store.completeTournamentWin({
    winnerId,
    entryFee: tournament.entryFee,
    playerCount: registered.length,
    settlementKey: `tournament:${tournament.id}`,
    holdKeys: registered.map(player => `tournament:${tournament.id}:${player.id}`),
  });
}

export async function driveBracketToCompletion(
  service: TournamentService,
  tournamentId: Tournament['id'],
  options: {
    report: StageReport;
    label: string;
    interruptRound1Match0?: boolean;
    repository?: InMemoryAsyncTournamentRepository;
    battles?: FakeBattleEngineControls;
  },
): Promise<{
  winner: TournamentPlayerId;
  matchesByRound: Map<number, TournamentMatch[]>;
  finalMatch: TournamentMatch;
}> {
  const { report, label } = options;
  const roundNames: Record<number, string> = {
    1: 'R32',
    2: 'R16',
    3: 'QF',
    4: 'SF',
    5: 'Final',
  };

  let interruptedHandled = false;

  for (let guard = 0; guard < 64; guard += 1) {
    const tournament = await service.getTournament(tournamentId);
    if (tournament.status === 'completed' && tournament.winner) {
      const matches = await service.getBracket(tournamentId);
      const matchesByRound = groupByRound(matches);
      const finalRound = Math.max(...matches.map(match => match.round));
      const finalMatch = matches.find(match => match.round === finalRound)!;
      report.pass(`${label}/completion`, `Tournament completed under ${tournament.winner}`);
      return { winner: tournament.winner, matchesByRound, finalMatch };
    }

    const ready = (await service.getBracket(tournamentId))
      .filter(match => match.status === 'ready' || match.status === 'interrupted' || match.status === 'tied')
      .sort((a, b) => a.round - b.round || a.bracketPosition - b.bracketPosition);

    if (ready.length === 0) {
      await tick();
      continue;
    }

    for (const match of ready) {
      const roundLabel = roundNames[match.round] ?? `R${match.round}`;
      if (
        options.interruptRound1Match0
        && !interruptedHandled
        && match.round === 1
        && match.bracketPosition === 0
        && options.repository
        && options.battles
      ) {
        options.battles.setNextMode('hang');
        const started = await service.startMatch(match.id);
        report.check(
          `${label}/${roundLabel}-interrupt-start`,
          'Interrupted scenario created a live battle',
          started.status === 'active' || started.status === 'battle-created',
          'active|battle-created',
          started.status,
        );
        const interrupted = await options.repository.interruptMatch(match.id);
        report.check(
          `${label}/${roundLabel}-interrupt`,
          'Unfinished match marked interrupted without inventing a winner',
          interrupted.status === 'interrupted' && interrupted.winner === undefined,
          'interrupted/no-winner',
          `${interrupted.status}/${interrupted.winner ?? 'none'}`,
        );
        interruptedHandled = true;
        const resumed = await service.startMatch(match.id);
        await waitForSettled(service, resumed.id);
        const after = (await service.getMatch(match.id)).match;
        report.check(
          `${label}/${roundLabel}-recover`,
          'Interrupted match resumed and settled',
          after.status === 'completed' || after.status === 'forfeited',
          'completed|forfeited',
          after.status,
        );
        continue;
      }

      const beforeNext = await service.getBracket(tournamentId);
      const started = await service.startMatch(match.id);
      const settled = await waitForSettled(service, started.id);
      report.check(
        `${label}/${roundLabel}-match-${match.bracketPosition}`,
        `${settled.player1} vs ${settled.player2} → ${settled.winner}`,
        settled.status === 'completed' || settled.status === 'forfeited',
        'completed|forfeited',
        settled.status,
      );

      if (settled.winner && settled.round < Math.max(...beforeNext.map(item => item.round))) {
        const next = (await service.getBracket(tournamentId)).find(candidate => (
          candidate.round === settled.round + 1
          && candidate.bracketPosition === Math.floor(settled.bracketPosition / 2)
        ));
        const expectedSlot = settled.bracketPosition % 2 === 0 ? 'player1' : 'player2';
        const actualSlotWinner = expectedSlot === 'player1' ? next?.player1 : next?.player2;
        report.check(
          `${label}/${roundLabel}-advance-${match.bracketPosition}`,
          `Winner advances to round ${settled.round + 1} as ${expectedSlot}`,
          actualSlotWinner === settled.winner,
          settled.winner,
          actualSlotWinner,
        );
        const loser = settled.winner === settled.player1 ? settled.player2 : settled.player1;
        const remaining = await service.getBracket(tournamentId);
        const finalRound = Math.max(...remaining.map(candidate => candidate.round));
        const unfinished = remaining.filter(candidate => (
          !isSettled(candidate)
          && (candidate.player1 === loser || candidate.player2 === loser)
        ));
        const onlyThirdPlace = unfinished.length > 0 && unfinished.every(candidate => (
          candidate.role === 'third-place'
          || (candidate.round === finalRound && candidate.bracketPosition === 1)
        ));
        report.check(
          `${label}/${roundLabel}-eliminate-${match.bracketPosition}`,
          `Loser ${loser} is eliminated from unfinished matches or assigned to third place`,
          unfinished.length === 0 || onlyThirdPlace,
          unfinished.length === 0 ? 'eliminated' : 'third-place',
          unfinished.length === 0 ? 'eliminated' : unfinished.map(candidate => candidate.role ?? 'third-place').join(','),
        );
      }
    }
  }

  throw new Error(`${label}: tournament did not complete.`);
}

export function groupByRound(matches: TournamentMatch[]): Map<number, TournamentMatch[]> {
  const grouped = new Map<number, TournamentMatch[]>();
  for (const match of matches) {
    const list = grouped.get(match.round) ?? [];
    list.push(match);
    grouped.set(match.round, list);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => a.bracketPosition - b.bracketPosition);
  }
  return grouped;
}

export async function waitForSettled(
  service: TournamentService,
  matchId: TournamentMatch['id'],
  timeoutMs = 5_000,
): Promise<TournamentMatch> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = (await service.getMatch(matchId)).match;
    if (isSettled(current)) return current;
    await tick();
  }
  throw new Error(`Match did not settle: ${matchId}`);
}

function isSettled(match: TournamentMatch): boolean {
  return match.status === 'completed' || match.status === 'forfeited' || match.status === 'tied';
}

function tick(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function nextState(state: number): number {
  let next = state + 0x6D2B79F5;
  next = Math.imul(next ^ next >>> 15, next | 1);
  next ^= next + Math.imul(next ^ next >>> 7, next | 61);
  return (next ^ next >>> 14) >>> 0;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
