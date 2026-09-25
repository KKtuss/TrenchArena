import { randomUUID } from 'node:crypto';

import {
  assertSupportedFormat,
  DEFAULT_SEED,
  formatRules,
  validateAndPackTeam,
} from './teams';
import { replayBattle } from './replay';
import {
  BattleEngineError,
  TeamValidationError,
  UnknownBattleError,
} from './errors';
import { BattleSession } from './session';
import type {
  BattlePlayer,
  BattleReplay,
  BattleResult,
  CreateBattleInput,
  SupportedFormat,
} from './types';

const DEFAULT_TIMEOUT_MS = 15_000;

export class BattleEngine {
  private readonly sessions = new Map<string, BattleSession>();

  async createBattle(input: CreateBattleInput): Promise<BattleSession> {
    assertSupportedFormat(String(input.format));
    if (!Array.isArray(input.players) || input.players.length !== 2) {
      throw new BattleEngineError('Exactly two players are required.');
    }
    if (!Array.isArray(input.teams) || input.teams.length !== 2) {
      throw new BattleEngineError('Exactly two teams are required.');
    }

    const players = normalizePlayers(input.players);
    const format = input.format as SupportedFormat;
    const initialTeams: [string, string] = [
      validateTeamInput(input.teams[0], format),
      validateTeamInput(input.teams[1], format),
    ];
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new BattleEngineError('timeoutMs must be a positive finite number.');
    }

    const session = new BattleSession({
      id: randomUUID(),
      format,
      rules: formatRules(format),
      seed: input.seed ?? DEFAULT_SEED,
      players,
      initialTeams,
      timeoutMs,
    });
    this.sessions.set(session.id, session);
    return session;
  }

  getBattle(battleId: string): BattleSession {
    const session = this.sessions.get(battleId);
    if (!session) throw new UnknownBattleError(battleId);
    return session;
  }

  async replay(replay: BattleReplay): Promise<BattleResult> {
    return replayBattle(replay);
  }
}

function normalizePlayers(
  players: CreateBattleInput['players'],
): [BattlePlayer, BattlePlayer] {
  if (players.some(player => (
    !player ||
    typeof player.id !== 'string' ||
    (player.name !== undefined && typeof player.name !== 'string')
  ))) {
    throw new BattleEngineError('Player IDs and names must be strings.');
  }

  const normalized = players.map(player => ({
    id: player.id,
    name: player.name ?? player.id,
  })) as [BattlePlayer, BattlePlayer];

  const ids = new Set(normalized.map(player => player.id));
  const names = new Set(normalized.map(player => player.name));
  if (
    normalized.some(player => !player.id || !player.name) ||
    ids.size !== normalized.length ||
    names.size !== normalized.length
  ) {
    throw new BattleEngineError('Player IDs and names must be non-empty and unique.');
  }
  return normalized;
}

function validateTeamInput(team: string, format: SupportedFormat): string {
  if (typeof team !== 'string') {
    throw new TeamValidationError('Team must be a Showdown export string.');
  }
  return validateAndPackTeam(team, format);
}
