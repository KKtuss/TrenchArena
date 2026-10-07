import type { Pool, PoolClient } from 'pg';

import { mapPgError } from './pg-errors';
import { nextTournamentAfterMatchCommit } from './tournament-completion';
import { pokeFromPg, pokeToPg } from './poke';
import type {
  DurableTournament,
  DurableTournamentMatch,
  DurableTournamentPlayer,
  MatchOutcomeInput,
  RegisterTournamentPlayerInput,
  TournamentStore,
} from './tournament-store';

function epoch(value: Date | string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return value;
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(time) ? time : undefined;
}

function requireEpoch(value: Date | string | number | null | undefined): number {
  const time = epoch(value);
  if (time === undefined) throw new Error('Request could not be processed.');
  return time;
}

export interface PostgresTournamentStoreOptions {
  beforeCommit?: () => Promise<void> | void;
}

/**
 * PostgreSQL tournament adapter. Registration debits the entry fee and
 * inserts `tournament_players` in one transaction. Live Showdown state is
 * not stored.
 */
export class PostgresTournamentStore implements TournamentStore {
  constructor(
    private readonly pool: Pool,
    private readonly options: PostgresTournamentStoreOptions = {},
  ) {}

  async saveTournament(tournament: DurableTournament): Promise<void> {
    await this.transact(async client => {
      await this.ensureWallet(client, tournament.hostId);
      for (const player of tournament.players) {
        await this.ensureWallet(client, player.id);
      }
      if (tournament.winner) await this.ensureWallet(client, tournament.winner);
      await this.upsertTournament(client, tournament);
      for (const player of tournament.players) {
        await this.upsertPlayer(client, tournament.id, player);
      }
    });
  }

  async getTournament(id: string): Promise<DurableTournament | undefined> {
    return this.withMapped(async client => this.loadTournament(client, id));
  }

  async listTournaments(): Promise<DurableTournament[]> {
    return this.withMapped(async client => {
      const result = await client.query(
        `SELECT * FROM tournaments ORDER BY created_at DESC`,
      );
      const listed: DurableTournament[] = [];
      for (const row of result.rows) {
        const loaded = await this.loadTournament(client, String(row.id));
        if (loaded) listed.push(loaded);
      }
      return listed;
    });
  }

  async saveMatch(match: DurableTournamentMatch): Promise<void> {
    await this.transact(async client => {
      await this.lockTournament(client, match.tournamentId);
      const existing = await this.lockMatch(client, match.id);
      if (existing && isTerminalMatch(existing.status) && !isTerminalMatch(match.status)) {
        if (match.battleInstanceId && !existing.battleInstanceId) {
          await client.query(
            `UPDATE tournament_matches
             SET battle_instance_id = $2, updated_at = now()
             WHERE id = $1`,
            [match.id, match.battleInstanceId],
          );
        }
        return;
      }
      await this.upsertMatch(client, match);
    });
  }

  async getMatch(id: string): Promise<DurableTournamentMatch | undefined> {
    return this.withMapped(async client => {
      const result = await client.query(`SELECT * FROM tournament_matches WHERE id = $1`, [id]);
      return result.rows[0] ? this.mapMatch(result.rows[0]) : undefined;
    });
  }

  async listMatches(tournamentId: string): Promise<DurableTournamentMatch[]> {
    return this.withMapped(async client => this.loadMatches(client, tournamentId));
  }

  async registerPlayer(input: RegisterTournamentPlayerInput): Promise<DurableTournamentPlayer> {
    return this.transact(async client => {
      const tournament = await this.lockTournament(client, input.tournamentId);
      if (!tournament) throw new Error(`Unknown tournament: ${input.tournamentId}`);
      if (tournament.status !== 'registration') {
        throw new Error('Tournament registration is closed.');
      }
      const existing = await client.query<{ status: string }>(
        `SELECT status FROM tournament_players
         WHERE tournament_id = $1 AND player_id = $2
         FOR UPDATE`,
        [input.tournamentId, input.playerId],
      );
      if (existing.rows[0] && existing.rows[0].status !== 'withdrawn') {
        throw new Error(`Player is already registered: ${input.playerId}`);
      }
      const registered = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM tournament_players
         WHERE tournament_id = $1 AND status = 'registered'`,
        [input.tournamentId],
      );
      const isFull = Number(registered.rows[0]?.count ?? 0) >= tournament.maxPlayers;
      if (!input.displayName.trim() || !input.team.trim()) {
        throw new Error('Player display name and team are required.');
      }

      const order = await client.query<{ max: string | null }>(
        `SELECT MAX(registration_order)::text AS max FROM tournament_players WHERE tournament_id = $1`,
        [input.tournamentId],
      );
      const registrationOrder = Number(order.rows[0]?.max ?? -1) + 1;
      await this.ensureWallet(client, input.playerId);

      if (!isFull && tournament.rail !== 'sol_chain' && tournament.entryFee > 0) {
        const holdKey = `tournament:${input.tournamentId}:${input.playerId}`;
        await this.reserveTournamentEntryHold(
          client,
          holdKey,
          input.playerId,
          tournament.entryFee,
          input.tournamentId,
        );
      }

      const status: DurableTournamentPlayer['status'] = isFull ? 'waitlisted' : 'registered';
      const player: DurableTournamentPlayer = {
        id: input.playerId,
        displayName: input.displayName,
        team: input.team,
        eligible: true,
        status,
        registrationOrder,
        teamLocked: false,
        burnFeePaid: false,
      };
      if (existing.rows[0]) {
        await client.query(
          `UPDATE tournament_players
           SET display_name = $3,
               team = $4,
               eligible = TRUE,
               status = $5,
               registration_order = $6,
               team_locked = FALSE,
               burn_fee_paid = FALSE
           WHERE tournament_id = $1 AND player_id = $2`,
          [
            input.tournamentId,
            input.playerId,
            input.displayName,
            input.team,
            status,
            registrationOrder,
          ],
        );
      } else {
        await client.query(
          `INSERT INTO tournament_players (
             tournament_id, player_id, display_name, team, eligible, status, registration_order,
             team_locked, burn_fee_paid
           ) VALUES ($1, $2, $3, $4, TRUE, $5, $6, FALSE, FALSE)`,
          [
            input.tournamentId,
            input.playerId,
            input.displayName,
            input.team,
            status,
            registrationOrder,
          ],
        );
      }
      await client.query(
        `UPDATE tournaments SET updated_at = now() WHERE id = $1`,
        [input.tournamentId],
      );
      return player;
    });
  }

  async saveBracket(tournament: DurableTournament, matches: DurableTournamentMatch[]): Promise<void> {
    await this.transact(async client => {
      const current = await this.lockTournament(client, tournament.id);
      if (!current) throw new Error(`Unknown tournament: ${tournament.id}`);
      if (current.status === 'in-progress' && tournament.status === 'in-progress') {
        return;
      }
      if (current.status === 'ready' && tournament.status === 'ready') {
        return;
      }
      if (current.status !== 'registration' && !(current.status === 'ready' && tournament.status === 'in-progress')) {
        throw new Error(`Cannot prepare a tournament in the "${current.status}" state.`);
      }
      await this.upsertTournament(client, tournament);
      for (const match of matches) {
        await this.upsertMatch(client, match);
      }
    });
  }

  async beginMatchStart(matchId: string): Promise<DurableTournamentMatch> {
    return this.transact(async client => {
      const lookup = await client.query<{ tournament_id: string }>(
        `SELECT tournament_id FROM tournament_matches WHERE id = $1`,
        [matchId],
      );
      if (!lookup.rows[0]) throw new Error(`Unknown tournament match: ${matchId}`);
      const tournament = await this.lockTournament(client, lookup.rows[0].tournament_id);
      if (!tournament) throw new Error(`Unknown tournament: ${lookup.rows[0].tournament_id}`);
      const match = await this.lockMatch(client, matchId);
      if (!match) throw new Error(`Unknown tournament match: ${matchId}`);
      if (tournament.status !== 'in-progress') {
        throw new Error(`Cannot start a tournament in the "${tournament.status}" state.`);
      }
      if (match.status !== 'ready' && match.status !== 'tied' && match.status !== 'interrupted') {
        throw new Error(`Cannot start match ${match.id} in the "${match.status}" state.`);
      }
      await client.query(
        `UPDATE tournament_matches
         SET status = 'battle-created',
             winner_id = NULL,
             result_kind = NULL,
             result_summary = NULL,
             completed_at = NULL,
             battle_instance_id = NULL,
             started_at = now(),
             updated_at = now()
         WHERE id = $1`,
        [matchId],
      );
      const updated = await this.lockMatch(client, matchId);
      if (!updated) throw new Error(`Unknown tournament match: ${matchId}`);
      return updated;
    });
  }

  async attachBattleInstance(matchId: string, battleInstanceId: string): Promise<DurableTournamentMatch> {
    return this.transact(async client => {
      const match = await this.lockMatch(client, matchId);
      if (!match) throw new Error(`Unknown tournament match: ${matchId}`);
      await client.query(
        `UPDATE tournament_matches
         SET battle_instance_id = $2, updated_at = now()
         WHERE id = $1`,
        [matchId, battleInstanceId],
      );
      const updated = await this.lockMatch(client, matchId);
      if (!updated) throw new Error(`Unknown tournament match: ${matchId}`);
      return updated;
    });
  }

  async markMatchActive(matchId: string): Promise<DurableTournamentMatch> {
    return this.transact(async client => {
      const match = await this.lockMatch(client, matchId);
      if (!match) throw new Error(`Unknown tournament match: ${matchId}`);
      await client.query(
        `UPDATE tournament_matches
         SET status = 'active', updated_at = now()
         WHERE id = $1 AND status = 'battle-created'`,
        [matchId],
      );
      const updated = await this.lockMatch(client, matchId);
      if (!updated) throw new Error(`Unknown tournament match: ${matchId}`);
      return updated;
    });
  }

  async interruptMatch(matchId: string): Promise<DurableTournamentMatch> {
    return this.transact(async client => {
      const lookup = await client.query<{ tournament_id: string }>(
        `SELECT tournament_id FROM tournament_matches WHERE id = $1`,
        [matchId],
      );
      if (!lookup.rows[0]) throw new Error(`Unknown tournament match: ${matchId}`);
      await this.lockTournament(client, lookup.rows[0].tournament_id);
      const match = await this.lockMatch(client, matchId);
      if (!match) throw new Error(`Unknown tournament match: ${matchId}`);
      if (match.status !== 'battle-created' && match.status !== 'active') {
        return match;
      }
      await client.query(
        `UPDATE tournament_matches
         SET status = 'interrupted',
             winner_id = NULL,
             result_kind = NULL,
             result_summary = NULL,
             battle_instance_id = NULL,
             completed_at = COALESCE(completed_at, now()),
             updated_at = now()
         WHERE id = $1 AND status IN ('battle-created', 'active')`,
        [matchId],
      );
      const updated = await this.lockMatch(client, matchId);
      if (!updated) throw new Error(`Unknown tournament match: ${matchId}`);
      return updated;
    });
  }

  async commitMatchOutcome(input: MatchOutcomeInput): Promise<DurableTournamentMatch> {
    return this.transact(async client => {
      const tournamentId = input.match.tournamentId;
      await this.lockTournament(client, tournamentId);
      const current = await this.lockMatch(client, input.match.id);
      if (!current) throw new Error(`Unknown tournament match: ${input.match.id}`);
      if (isTerminalMatch(current.status)) {
        if (sameTerminal(current, input.match)) return current;
        throw new Error('A completed match cannot receive a different result.');
      }
      const lockedNext = input.nextMatch
        ? await this.lockMatch(client, input.nextMatch.id)
        : undefined;
      if (input.nextMatch && !lockedNext) {
        throw new Error(`Unknown tournament match: ${input.nextMatch.id}`);
      }
      await this.upsertMatch(client, input.match);
      if (input.nextMatch && lockedNext) {
        const player1 = input.nextMatch.player1 ?? lockedNext.player1;
        const player2 = input.nextMatch.player2 ?? lockedNext.player2;
        const nextMatch = {
          ...lockedNext,
          ...(player1 ? { player1 } : {}),
          ...(player2 ? { player2 } : {}),
          ...(lockedNext.status === 'pending' && player1 && player2 ? { status: 'ready' } : {}),
          updatedAt: input.nextMatch.updatedAt,
        };
        await this.upsertMatch(client, nextMatch);
      }
      if (input.placementMatch) {
        const lockedPlacement = await this.lockMatch(client, input.placementMatch.id);
        if (!lockedPlacement) throw new Error(`Unknown tournament match: ${input.placementMatch.id}`);
        if (!isTerminalMatch(lockedPlacement.status)) {
          const player1 = input.placementMatch.player1 ?? lockedPlacement.player1;
          const player2 = input.placementMatch.player2 ?? lockedPlacement.player2;
          await this.upsertMatch(client, {
            ...lockedPlacement,
            ...(player1 ? { player1 } : {}),
            ...(player2 ? { player2 } : {}),
            ...(lockedPlacement.status === 'pending' && player1 && player2 ? { status: 'ready' } : {}),
            updatedAt: input.placementMatch.updatedAt,
          });
        }
      }
      const fresh = await this.lockTournament(client, tournamentId);
      if (fresh) {
        const matches = await this.loadMatches(client, tournamentId);
        const next = nextTournamentAfterMatchCommit(fresh, matches, Date.now());
        if (next) await this.upsertTournament(client, next);
      }
      const stored = await this.lockMatch(client, input.match.id);
      if (!stored) throw new Error(`Unknown tournament match: ${input.match.id}`);
      return stored;
    });
  }

  private async loadTournament(client: PoolClient, id: string): Promise<DurableTournament | undefined> {
    const result = await client.query({
      text: `SELECT * FROM tournaments WHERE id = $1`,
      values: [id],
    });
    const row = result.rows[0];
    if (!row) return undefined;
    const players = await client.query(
      `SELECT * FROM tournament_players
       WHERE tournament_id = $1
       ORDER BY registration_order`,
      [id],
    );
    const matches = await this.loadMatches(client, id);
    return this.mapTournament(row, players.rows, matches);
  }

  private async loadMatches(client: PoolClient, tournamentId: string): Promise<DurableTournamentMatch[]> {
    const result = await client.query(
      `SELECT * FROM tournament_matches
       WHERE tournament_id = $1
       ORDER BY round, bracket_position`,
      [tournamentId],
    );
    return result.rows.map(row => this.mapMatch(row));
  }

  private async upsertTournament(client: PoolClient, tournament: DurableTournament): Promise<void> {
    await client.query(
      `INSERT INTO tournaments (
         id, title, format, max_players, bracket_seed, match_timeout_ms, status,
         host_id, entry_fee, rail, entry_atoms, entry_quote_id, prize_cards_raw,
         winner_id, created_at, updated_at, started_at, completed_at, ruleset, finalizes_at,
         payment_ends_at, payment_player_id, scheduled_key
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9::bigint, $10, $11, $12,
         $13::bigint, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
       )
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         status = EXCLUDED.status,
         rail = EXCLUDED.rail,
         entry_atoms = EXCLUDED.entry_atoms,
         entry_quote_id = EXCLUDED.entry_quote_id,
         prize_cards_raw = EXCLUDED.prize_cards_raw,
         scheduled_key = EXCLUDED.scheduled_key,
         winner_id = EXCLUDED.winner_id,
         updated_at = EXCLUDED.updated_at,
         started_at = EXCLUDED.started_at,
         completed_at = EXCLUDED.completed_at,
         finalizes_at = EXCLUDED.finalizes_at,
         payment_ends_at = EXCLUDED.payment_ends_at,
         payment_player_id = EXCLUDED.payment_player_id`,
      [
        tournament.id,
        tournament.title,
        tournament.format,
        tournament.maxPlayers,
        tournament.bracketSeed,
        tournament.matchTimeoutMs,
        tournament.status,
        tournament.hostId,
        pokeToPg(tournament.entryFee),
        tournament.rail ?? 'legacy_poke',
        tournament.entryAtoms === undefined ? null : pokeToPg(tournament.entryAtoms),
        tournament.entryQuoteId ?? null,
        tournament.prizeCardsRaw === undefined ? null : pokeToPg(tournament.prizeCardsRaw),
        tournament.winner ?? null,
        new Date(tournament.createdAt),
        new Date(tournament.updatedAt),
        tournament.startedAt === undefined ? null : new Date(tournament.startedAt),
        tournament.completedAt === undefined ? null : new Date(tournament.completedAt),
        tournament.ruleset ?? 'gen9ou',
        tournament.finalizesAt === undefined ? null : new Date(tournament.finalizesAt),
        tournament.paymentEndsAt === undefined ? null : new Date(tournament.paymentEndsAt),
        tournament.paymentPlayerId ?? null,
        tournament.scheduledKey ?? null,
      ],
    );
  }

  private async upsertPlayer(
    client: PoolClient,
    tournamentId: string,
    player: DurableTournamentPlayer,
  ): Promise<void> {
    await client.query(
      `INSERT INTO tournament_players (
         tournament_id, player_id, display_name, team, eligible, status, registration_order, team_locked,
         burn_fee_paid
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tournament_id, player_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         team = EXCLUDED.team,
         eligible = EXCLUDED.eligible,
         status = EXCLUDED.status,
         team_locked = EXCLUDED.team_locked,
         burn_fee_paid = EXCLUDED.burn_fee_paid`,
      [
        tournamentId,
        player.id,
        player.displayName,
        player.team,
        player.eligible,
        player.status,
        player.registrationOrder,
        player.teamLocked === true,
        player.burnFeePaid === true,
      ],
    );
  }

  private async upsertMatch(client: PoolClient, match: DurableTournamentMatch): Promise<void> {
    for (const playerId of [match.player1, match.player2, match.winner]) {
      if (playerId) await this.ensureWallet(client, playerId);
    }
    await client.query(
      `INSERT INTO tournament_matches (
         id, tournament_id, round, bracket_position, player1_id, player2_id, status,
         battle_instance_id, winner_id, result_kind, result_summary,
         created_at, updated_at, started_at, completed_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
       )
       ON CONFLICT (id) DO UPDATE SET
         player1_id = EXCLUDED.player1_id,
         player2_id = EXCLUDED.player2_id,
         status = EXCLUDED.status,
         battle_instance_id = EXCLUDED.battle_instance_id,
         winner_id = EXCLUDED.winner_id,
         result_kind = EXCLUDED.result_kind,
         result_summary = EXCLUDED.result_summary,
         updated_at = EXCLUDED.updated_at,
         started_at = EXCLUDED.started_at,
         completed_at = EXCLUDED.completed_at`,
      [
        match.id,
        match.tournamentId,
        match.round,
        match.bracketPosition,
        match.player1 ?? null,
        match.player2 ?? null,
        match.status,
        match.battleInstanceId ?? null,
        match.winner ?? null,
        resultKind(match.result),
        match.result === undefined ? null : match.result,
        new Date(match.createdAt),
        new Date(match.updatedAt),
        match.startedAt === undefined ? null : new Date(match.startedAt),
        match.completedAt === undefined ? null : new Date(match.completedAt),
      ],
    );
  }

  private async lockTournament(client: PoolClient, id: string): Promise<DurableTournament | undefined> {
    const result = await client.query(`SELECT * FROM tournaments WHERE id = $1 FOR UPDATE`, [id]);
    if (!result.rows[0]) return undefined;
    const players = await client.query(
      `SELECT * FROM tournament_players
       WHERE tournament_id = $1
       ORDER BY registration_order`,
      [id],
    );
    const matches = await this.loadMatches(client, id);
    return this.mapTournament(result.rows[0], players.rows, matches);
  }

  private async lockMatch(client: PoolClient, id: string): Promise<DurableTournamentMatch | undefined> {
    const result = await client.query(
      `SELECT * FROM tournament_matches WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return result.rows[0] ? this.mapMatch(result.rows[0]) : undefined;
  }

  private async debit(client: PoolClient, playerId: string, amount: number): Promise<void> {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('Amount must be a positive integer POKE value.');
    }
    const updated = await client.query(
      `UPDATE wallets
       SET balance = balance - $2::bigint, updated_at = now()
       WHERE player_id = $1 AND balance >= $2::bigint`,
      [playerId, pokeToPg(amount)],
    );
    if ((updated.rowCount ?? 0) === 0) {
      throw new Error('Collateral exceeds development POKE balance.');
    }
  }

  private async reserveTournamentEntryHold(
    client: PoolClient,
    holdKey: string,
    playerId: string,
    amount: number,
    tournamentId: string,
  ): Promise<void> {
    const existing = await client.query<{ status: string }>(
      'SELECT status FROM holds WHERE hold_key = $1 FOR UPDATE',
      [holdKey],
    );
    if (existing.rows[0] && existing.rows[0].status !== 'released') {
      throw new Error('Collateral hold already exists.');
    }
    await this.debit(client, playerId, amount);
    if (existing.rows[0]) {
      await client.query(
        `UPDATE holds
         SET player_id = $2,
             amount = $3::bigint,
             purpose = 'tournament_entry',
             status = 'reserved',
             tournament_id = $4,
             terminal_at = NULL
         WHERE hold_key = $1`,
        [holdKey, playerId, pokeToPg(amount), tournamentId],
      );
      return;
    }
    await client.query(
      `INSERT INTO holds (
         hold_key, player_id, amount, purpose, status, tournament_id
       ) VALUES ($1, $2, $3::bigint, 'tournament_entry', 'reserved', $4)`,
      [holdKey, playerId, pokeToPg(amount), tournamentId],
    );
  }

  private mapTournament(
    row: Record<string, unknown>,
    playerRows: Record<string, unknown>[],
    matches: DurableTournamentMatch[],
  ): DurableTournament {
    return {
      id: String(row.id),
      title: String(row.title),
      format: String(row.format),
      ruleset: row.ruleset ? String(row.ruleset) : 'gen9ou',
      maxPlayers: Number(row.max_players) as 4 | 8 | 16 | 32,
      bracketSeed: String(row.bracket_seed),
      matchTimeoutMs: Number(row.match_timeout_ms),
      status: String(row.status),
      hostId: String(row.host_id),
      entryFee: pokeFromPg(row.entry_fee),
      ...(row.rail === 'sol_chain' || row.rail === 'legacy_poke' ? { rail: row.rail } : {}),
      ...(row.entry_atoms !== null && row.entry_atoms !== undefined
        ? { entryAtoms: pokeFromPg(row.entry_atoms) }
        : {}),
      ...(row.entry_quote_id ? { entryQuoteId: String(row.entry_quote_id) } : {}),
      ...(row.prize_cards_raw !== null && row.prize_cards_raw !== undefined
        ? { prizeCardsRaw: pokeFromPg(row.prize_cards_raw) }
        : {}),
      ...(row.scheduled_key ? { scheduledKey: String(row.scheduled_key) } : {}),
      players: playerRows.map(player => ({
        id: String(player.player_id),
        displayName: String(player.display_name),
        team: String(player.team),
        eligible: true,
        status: player.status as DurableTournamentPlayer['status'],
        registrationOrder: Number(player.registration_order),
        ...(player.team_locked === true ? { teamLocked: true } : {}),
        ...(player.burn_fee_paid === true ? { burnFeePaid: true } : {}),
      })),
      matchIds: matches.map(match => match.id),
      ...(row.winner_id ? { winner: String(row.winner_id) } : {}),
      createdAt: requireEpoch(row.created_at as Date),
      updatedAt: requireEpoch(row.updated_at as Date),
      ...(epoch(row.started_at as Date | null) === undefined
        ? {}
        : { startedAt: epoch(row.started_at as Date) }),
      ...(epoch(row.completed_at as Date | null) === undefined
        ? {}
        : { completedAt: epoch(row.completed_at as Date) }),
      ...(epoch(row.finalizes_at as Date | null) === undefined
        ? {}
        : { finalizesAt: epoch(row.finalizes_at as Date) }),
      ...(epoch(row.payment_ends_at as Date | null) === undefined
        ? {}
        : { paymentEndsAt: epoch(row.payment_ends_at as Date) }),
      ...(row.payment_player_id ? { paymentPlayerId: String(row.payment_player_id) } : {}),
    };
  }

  private mapMatch(row: Record<string, unknown>): DurableTournamentMatch {
    return {
      id: String(row.id),
      tournamentId: String(row.tournament_id),
      round: Number(row.round),
      bracketPosition: Number(row.bracket_position),
      ...(row.player1_id ? { player1: String(row.player1_id) } : {}),
      ...(row.player2_id ? { player2: String(row.player2_id) } : {}),
      status: String(row.status),
      ...(row.battle_instance_id ? { battleInstanceId: String(row.battle_instance_id) } : {}),
      ...(row.winner_id ? { winner: String(row.winner_id) } : {}),
      ...(row.result_summary ? { result: parseResult(row.result_summary) } : {}),
      createdAt: requireEpoch(row.created_at as Date),
      updatedAt: requireEpoch(row.updated_at as Date),
      ...(epoch(row.started_at as Date | null) === undefined
        ? {}
        : { startedAt: epoch(row.started_at as Date) }),
      ...(epoch(row.completed_at as Date | null) === undefined
        ? {}
        : { completedAt: epoch(row.completed_at as Date) }),
    };
  }

  private async ensureWallet(client: PoolClient, playerId: string): Promise<void> {
    await client.query(
      `INSERT INTO wallets (player_id, balance) VALUES ($1, 0)
       ON CONFLICT (player_id) DO NOTHING`,
      [playerId],
    );
  }

  private async transact<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      if (this.options.beforeCommit) await this.options.beforeCommit();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is released even if rollback fails.
      }
      throw mapPgError(error);
    } finally {
      client.release();
    }
  }

  private async withMapped<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await work(client);
    } catch (error) {
      throw mapPgError(error);
    } finally {
      client.release();
    }
  }
}

function resultKind(result: unknown): string | null {
  if (!result || typeof result !== 'object' || !('kind' in result)) return null;
  const kind = (result as { kind: unknown }).kind;
  return kind === 'battle' || kind === 'forfeit' ? kind : null;
}

function parseResult(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function isTerminalMatch(status: string): boolean {
  return status === 'completed' || status === 'forfeited' || status === 'tied';
}

function sameTerminal(left: DurableTournamentMatch, right: DurableTournamentMatch): boolean {
  return left.status === right.status
    && left.winner === right.winner
    && stableJson(left.result) === stableJson(right.result);
}

function stableJson(value: unknown): string {
  return JSON.stringify(orderJson(value));
}

function orderJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, orderJson(nested)]),
    );
  }
  return value;
}
