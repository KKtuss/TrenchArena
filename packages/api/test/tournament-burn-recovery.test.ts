/**
 * A keeper failure midway through tournament burns must be retried without
 * burning a completed player twice or leaving the rest reserved.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import type {
  ChainIntentRow,
  ChainIntentStatus,
  CreateIntentInput,
  PostgresChainStore,
} from '@pokearena/db';
import {
  IX,
  configPda,
  TOURNAMENT_BURN_FEE_ATOMS,
  TOURNAMENT_FIELD_BURN_FEE_ATOMS,
  TOURNAMENT_FIELD_BURN_FEE_POKE,
  entryEscrowPda,
  formatPokeFromAtoms,
  uuidToBytes,
  type ArenaChainClient,
  type SentTransaction,
} from '@pokearena/solana-client';
import { TournamentService } from '@pokearena/tournament';

import { ChainEconomyService } from '../src/chain-economy';

const PLAYERS = 32;
const FAIL_AFTER = 16;
const PRIZE_CARDS_RAW = 100_000_000;

class BurnLedger {
  readonly chainStatus = new Map<string, number>();
  readonly successfulBurns = new Map<string, number>();
  readonly failedBurns = new Map<string, number>();
  readonly burnedAtoms = new Map<string, bigint>();
  reserveSubmits = 0;
  prizeReserved = false;
  private failureArmed = true;

  constructor(
    private readonly programId: PublicKey,
    private readonly tournamentId: string,
    playerIds: string[],
  ) {
    for (const playerId of playerIds) this.chainStatus.set(playerId, 0);
  }

  private playerForBurn(instruction: TransactionInstruction): string {
    const escrow = instruction.keys[3]?.pubkey;
    const tournamentBytes = uuidToBytes(this.tournamentId);
    for (const playerId of this.chainStatus.keys()) {
      const [expected] = entryEscrowPda(this.programId, tournamentBytes, new PublicKey(playerId));
      if (escrow?.equals(expected)) return playerId;
    }
    throw new Error('Burn instruction did not match a tournament player.');
  }

  async submit(instructions: TransactionInstruction[]): Promise<SentTransaction> {
    const instruction = instructions[0];
    if (!instruction) throw new Error('Keeper transaction had no instruction.');
    const data = Buffer.from(instruction.data);
    if (data.subarray(0, 8).equals(IX.fundCardsPrize)) {
      this.reserveSubmits += 1;
      this.prizeReserved = true;
      return { signature: 'reserve', status: 'confirmed', slot: 1 };
    }
    if (!data.subarray(0, 8).equals(IX.burnPokeEntry)) {
      throw new Error('Unexpected keeper instruction.');
    }
    const playerId = this.playerForBurn(instruction);
    if ((this.successfulBurns.get(playerId) ?? 0) > 0 || this.chainStatus.get(playerId) === 1) {
      throw new Error(`Burn repeated for ${playerId}.`);
    }
    const completed = [...this.successfulBurns.values()].reduce((sum, count) => sum + count, 0);
    if (this.failureArmed && completed === FAIL_AFTER) {
      this.failureArmed = false;
      this.failedBurns.set(playerId, (this.failedBurns.get(playerId) ?? 0) + 1);
      return { signature: 'transient', status: 'failed', error: 'transient keeper failure', slot: 2 };
    }
    this.successfulBurns.set(playerId, (this.successfulBurns.get(playerId) ?? 0) + 1);
    this.chainStatus.set(playerId, 1);
    this.burnedAtoms.set(playerId, BigInt(TOURNAMENT_BURN_FEE_ATOMS));
    return { signature: `burn-${playerId}`, status: 'confirmed', slot: 3 };
  }
}

class MemoryBurnStore {
  private readonly intents = new Map<string, ChainIntentRow>();
  private readonly entries = new Map<string, 'reserved' | 'burned'>();

  constructor(playerIds: string[]) {
    for (const playerId of playerIds) this.entries.set(playerId, 'reserved');
  }

  entryStatus(playerId: string): 'reserved' | 'burned' | undefined {
    return this.entries.get(playerId);
  }

  async createIntent(input: CreateIntentInput): Promise<ChainIntentRow> {
    const existing = [...this.intents.values()].find(row => row.idempotencyKey === input.idempotencyKey);
    if (existing) return { ...existing };
    const row: ChainIntentRow = {
      id: randomUUID(),
      kind: input.kind,
      scopeId: input.scopeId,
      ...(input.playerId ? { playerId: input.playerId } : {}),
      asset: input.asset,
      amount: input.amount,
      status: 'created',
      idempotencyKey: input.idempotencyKey,
      ...(input.tournamentId ? { tournamentId: input.tournamentId } : {}),
      metadata: input.metadata ?? {},
    };
    this.intents.set(row.id, row);
    return { ...row };
  }

  async getIntentByScope(kind: ChainIntentRow['kind'], scopeId: string): Promise<ChainIntentRow | undefined> {
    const row = [...this.intents.values()].find(item => item.kind === kind && item.scopeId === scopeId);
    return row ? { ...row } : undefined;
  }

  async setIntentStatus(
    id: string,
    status: ChainIntentStatus,
  ): Promise<ChainIntentRow> {
    const row = this.intents.get(id);
    if (!row) throw new Error(`Unknown chain intent: ${id}`);
    const retryConfirmed = row.status === 'failed' && status === 'confirmed';
    if (
      row.status === 'confirmed'
      || row.status === 'expired'
      || row.status === 'cancelled'
      || (row.status === 'failed' && !retryConfirmed)
    ) {
      return { ...row };
    }
    row.status = status;
    return { ...row };
  }

  async markEntryBurned(tournamentId: string, playerId: string): Promise<void> {
    const intent = await this.getIntentByScope('poke_entry_burn', `${tournamentId}:${playerId}`);
    if (intent?.status !== 'confirmed') {
      throw new Error(`Refusing to record a burn that is not confirmed for ${playerId}.`);
    }
    if (this.entries.get(playerId) === 'reserved') this.entries.set(playerId, 'burned');
  }

  async recordPrizeReserve(): Promise<void> {}
}

function registeredIds(tournament: { players: Array<{ id: string; status: string }> }): string[] {
  return tournament.players.filter(player => player.status === 'registered').map(player => player.id).sort();
}

test('a midway burn failure retries the remaining players exactly once', async () => {
  const keeper = Keypair.generate();
  const programId = Keypair.generate().publicKey;
  const players = Array.from({ length: PLAYERS }, () => Keypair.generate().publicKey.toBase58());
  const tournamentId = randomUUID();
  const ledger = new BurnLedger(programId, tournamentId, players);
  const store = new MemoryBurnStore(players);
  for (const playerId of players) {
    await store.createIntent({
      kind: 'poke_entry_deposit',
      scopeId: `${tournamentId}:${playerId}`,
      playerId,
      asset: 'POKE',
      amount: TOURNAMENT_BURN_FEE_ATOMS,
      idempotencyKey: `poke_entry_deposit:${tournamentId}:${playerId}`,
      tournamentId,
    });
    const deposit = await store.getIntentByScope('poke_entry_deposit', `${tournamentId}:${playerId}`);
    await store.setIntentStatus(deposit!.id, 'confirmed');
  }
  const economy = new ChainEconomyService({
    env: {
      POKEARENA_CHAIN_ECONOMY: 'true',
      POKEARENA_SOLANA_CLUSTER: 'localnet',
      POKEARENA_PROGRAM_ID: programId.toBase58(),
      POKEARENA_POKE_MINT: Keypair.generate().publicKey.toBase58(),
      POKEARENA_CARDS_MINT: Keypair.generate().publicKey.toBase58(),
      POKEARENA_QUOTE_AUTHORITY: keeper.publicKey.toBase58(),
      POKEARENA_KEEPER: keeper.publicKey.toBase58(),
      POKEARENA_AUTHORITY: keeper.publicKey.toBase58(),
    },
    chainStore: store as unknown as PostgresChainStore,
    client: {
      configAddress: configPda(programId)[0],
      async getEntryEscrowState(_tournamentId: Uint8Array, player: PublicKey) {
        return {
          player: player.toBase58(),
          amount: BigInt(TOURNAMENT_BURN_FEE_ATOMS),
          quoteId: Buffer.alloc(32),
          status: ledger.chainStatus.get(player.toBase58()) ?? 255,
        };
      },
      async getCardsPrizeReserveState() {
        if (!ledger.prizeReserved) throw new Error('Prize reserve account was not found.');
        return {
          winner: PublicKey.default,
          cardsAmount: BigInt(PRIZE_CARDS_RAW),
          status: 0,
          winnerSet: false,
        };
      },
      getCardsAta() {
        return Keypair.generate().publicKey;
      },
    } as unknown as ArenaChainClient,
    keeper,
    submitKeeper: instructions => ledger.submit(instructions),
  });

  let now = 1_000;
  const tournaments = new TournamentService({ now: () => now });
  const created = await tournaments.createTournament({
    title: 'Burn Recovery Cup',
    format: 'gen9ou',
    maxPlayers: PLAYERS,
    rail: 'sol_chain',
    entryAtoms: TOURNAMENT_BURN_FEE_ATOMS,
    prizeCardsRaw: PRIZE_CARDS_RAW,
  });
  await tournaments.openRegistration(created.id);
  for (const [index, playerId] of players.entries()) {
    await tournaments.registerPlayer(created.id, {
      playerId: playerId as never,
      displayName: `Player ${index + 1}`,
      team: 'Pikachu',
    });
  }
  const opened = await tournaments.beginTeamFinalization(created.id);
  for (const playerId of players) {
    await tournaments.markBurnFeePaid(created.id, playerId as never);
  }
  now = opened.finalizesAt!;
  const finalizedRoster = await tournaments.advanceBurnFeeWindow(created.id);
  assert.equal(finalizedRoster.readyToFinalize, true);
  const roster = registeredIds(finalizedRoster.tournament);
  assert.deepEqual(roster, [...players].sort());

  await assert.rejects(
    () => economy.lockTournament({
      tournamentId,
      playerIds: roster,
      prizeCardsRaw: PRIZE_CARDS_RAW,
    }),
    /transient keeper failure/,
  );

  const burnedBeforeRetry = players.filter(playerId => ledger.chainStatus.get(playerId) === 1);
  const reservedBeforeRetry = players.filter(playerId => ledger.chainStatus.get(playerId) === 0);
  assert.equal(burnedBeforeRetry.length, FAIL_AFTER);
  assert.equal(reservedBeforeRetry.length, PLAYERS - FAIL_AFTER);
  for (const playerId of burnedBeforeRetry) {
    assert.equal(ledger.successfulBurns.get(playerId), 1);
    assert.equal(store.entryStatus(playerId), 'burned');
    const intent = await store.getIntentByScope('poke_entry_burn', `${tournamentId}:${playerId}`);
    assert.equal(intent?.status, 'confirmed');
  }
  const failedPlayer = reservedBeforeRetry.find(playerId => (ledger.failedBurns.get(playerId) ?? 0) === 1);
  assert.ok(failedPlayer);
  assert.equal(store.entryStatus(failedPlayer!), 'reserved');
  const failedIntent = await store.getIntentByScope('poke_entry_burn', `${tournamentId}:${failedPlayer}`);
  assert.equal(failedIntent?.status, 'failed');
  for (const playerId of reservedBeforeRetry) {
    if (playerId === failedPlayer) continue;
    assert.equal(ledger.successfulBurns.get(playerId), undefined);
    assert.equal(store.entryStatus(playerId), 'reserved');
  }

  const rosterAfterFailure = await tournaments.advanceBurnFeeWindow(created.id);
  assert.equal(rosterAfterFailure.readyToFinalize, true);
  assert.deepEqual(registeredIds(rosterAfterFailure.tournament), roster);
  assert.equal(rosterAfterFailure.promotedPlayerId, undefined);

  await economy.lockTournament({
    tournamentId,
    playerIds: registeredIds(rosterAfterFailure.tournament),
    prizeCardsRaw: PRIZE_CARDS_RAW,
  });

  assert.equal(ledger.reserveSubmits, 1);
  let totalAtoms = 0n;
  for (const playerId of players) {
    assert.equal(ledger.successfulBurns.get(playerId), 1);
    assert.equal(ledger.chainStatus.get(playerId), 1);
    assert.equal(store.entryStatus(playerId), 'burned');
    const intent = await store.getIntentByScope('poke_entry_burn', `${tournamentId}:${playerId}`);
    assert.equal(intent?.status, 'confirmed');
    totalAtoms += ledger.burnedAtoms.get(playerId) ?? 0n;
  }
  assert.equal(totalAtoms, BigInt(TOURNAMENT_FIELD_BURN_FEE_ATOMS));
  assert.equal(formatPokeFromAtoms(Number(totalAtoms)), `${TOURNAMENT_FIELD_BURN_FEE_POKE.toLocaleString('en-US')} POKE`);
  assert.equal(formatPokeFromAtoms(Number(totalAtoms)), '320,000 POKE');

  const started = await tournaments.startTournament(created.id);
  assert.equal(started.status, 'in-progress');
  assert.deepEqual(registeredIds(started), roster);
});
