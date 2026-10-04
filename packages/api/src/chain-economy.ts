import { readFileSync } from 'node:fs';
import { Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from '@solana/web3.js';
import {
  ArenaChainClient,
  assertPassportEligible,
  burnPokeEntryIx,
  chargeMatchFeeIx,
  createMatchEscrowIx,
  depositPokeEntryIx,
  depositSolWagerIx,
  payPrizeIx,
  refundPokeEntryIx,
  refundSolWagerIx,
  reservePrizeIx,
  seatMatchOpponentIx,
  setPrizeWinnerIx,
  settleMatchTieIx,
  settleMatchWinIx,
  type SentTransaction,
  evaluatePassport,
  loadChainConfig,
  passportAtoms,
  previewSolCasual,
  previewTreasurySplit,
  sha256Key,
  IX,
  tournamentEntryAtoms,
  type ArenaChainConfig,
  type IntentVerification,
  type MatchEscrowState,
  type PassportStatus,
  type PokeUsdQuote,
  type SolCasualPreview,
  TOURNAMENT_BURN_FEE_ATOMS,
  assertTournamentBurnFeeAtoms,
  uuidToBytes,
} from '@pokearena/solana-client';
import type { ChainIntentRow, DurableCasualRoom, EconomicsStore, PostgresChainStore } from '@pokearena/db';

/**
 * Background escrow check after a deposit signature has already opened the lobby.
 * A missing deposit flag is lag. A contradictory account is a mismatch.
 */
export function assessDepositEscrow(input: {
  side: 'creator' | 'opponent';
  roomCreator: string;
  roomOpponent?: string;
  roomCollateral: number;
  state: MatchEscrowState;
}): 'matched' | 'lagging' | 'mismatch' {
  if (input.state.creator.toBase58() !== input.roomCreator) return 'mismatch';
  if (input.state.collateralLamports !== BigInt(input.roomCollateral)) return 'mismatch';
  if (input.state.status >= 4) return 'mismatch';
  const deposited = input.side === 'creator'
    ? input.state.creatorDeposited
    : input.state.opponentDeposited;
  if (
    deposited
    && input.side === 'opponent'
    && input.roomOpponent
    && input.state.opponent.toBase58() !== input.roomOpponent
  ) {
    return 'mismatch';
  }
  return deposited ? 'matched' : 'lagging';
}

/** What a background escrow read may do. It cannot close a lobby on lag or an RPC error. */
export function depositEscrowFollowUp(
  outcome: 'matched' | 'lagging' | 'mismatch' | 'unread',
  attempt: number,
): 'keep' | 'revoke' | 'retry' {
  if (outcome === 'mismatch') return 'revoke';
  if (attempt === 0 && (outcome === 'lagging' || outcome === 'unread')) return 'retry';
  return 'keep';
}

export class ChainEconomyDisabledError extends Error {
  constructor() {
    super('Chain economy is not enabled. Set POKEARENA_CHAIN_ECONOMY=true.');
    this.name = 'ChainEconomyDisabledError';
  }
}

export class ChainEconomyService {
  readonly config: ArenaChainConfig;
  readonly client: ArenaChainClient | null;
  private readonly chainStore: PostgresChainStore | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly injectedKeeper?: Keypair;
  private readonly submitKeeperOverride?: (
    instructions: TransactionInstruction[],
  ) => Promise<SentTransaction>;
  private readonly depositConfirmations = new Map<string, Promise<{ status: string; error?: string }>>();
  private readonly depositWatchers = new Map<string, Promise<{ status: string }>>();
  private solDepositResolved?: (
    intent: ChainIntentRow,
    outcome: { status: string; signature: string },
  ) => void | Promise<void>;

  constructor(options: {
    env?: NodeJS.ProcessEnv;
    chainStore?: PostgresChainStore | null;
    client?: ArenaChainClient | null;
    keeper?: Keypair;
    submitKeeper?: (
      instructions: TransactionInstruction[],
    ) => Promise<SentTransaction>;
  } = {}) {
    this.env = options.env ?? process.env;
    this.config = loadChainConfig(this.env);
    this.injectedKeeper = options.keeper;
    this.submitKeeperOverride = options.submitKeeper;
    if (this.config.chainEconomyEnabled && !this.keeperKeypair().publicKey.equals(this.config.keeper)) {
      throw new Error('POKEARENA_KEEPER_KEYPAIR does not match POKEARENA_KEEPER.');
    }
    this.client = options.client !== undefined
      ? options.client
      : (this.config.chainEconomyEnabled ? new ArenaChainClient(this.config) : null);
    this.chainStore = options.chainStore ?? null;
  }

  get enabled(): boolean {
    return this.config.chainEconomyEnabled;
  }

  /** SOL wagers can run while this is false. POKE burns stay closed. */
  get pokeConfigured(): boolean {
    return this.enabled && !this.config.pokeMint.equals(PublicKey.default);
  }

  /** Fired when a deposit watcher reaches a terminal signature after the first response. */
  setSolDepositResolved(listener: (
    intent: ChainIntentRow,
    outcome: { status: string; signature: string },
  ) => void | Promise<void>): void {
    this.solDepositResolved = listener;
  }

  requireEnabled(): void {
    if (!this.enabled || !this.client) throw new ChainEconomyDisabledError();
  }

  requirePokeEconomy(): void {
    this.requireEnabled();
    if (!this.pokeConfigured) {
      throw new Error('POKE economy is not configured. POKEARENA_POKE_MINT is unset.');
    }
  }

  resolveQuote(env: NodeJS.ProcessEnv = process.env): PokeUsdQuote {
    this.requireEnabled();
    return this.client!.resolveQuote(env);
  }

  async persistQuote(quote: PokeUsdQuote): Promise<void> {
    if (!this.chainStore) return;
    await this.chainStore.saveQuote({
      quoteId: quote.quoteId,
      priceMicroUsd: quote.priceMicroUsd,
      decimals: quote.decimals,
      observedAt: quote.observedAt,
      source: quote.source,
      confidenceBps: quote.confidenceBps,
    });
  }

  async getIntent(intentId: string): Promise<ChainIntentRow | undefined> {
    if (!this.chainStore) return undefined;
    return this.chainStore.getIntent(intentId);
  }

  async getIntentByScope(
    kind: Parameters<PostgresChainStore['getIntentByScope']>[0],
    scopeId: string,
  ): Promise<ChainIntentRow | undefined> {
    if (!this.chainStore) return undefined;
    return this.chainStore.getIntentByScope(kind, scopeId);
  }

  private async waitForMatchEscrowState(
    roomBytes: Uint8Array,
    predicate: (state: MatchEscrowState) => boolean,
    options?: { commitment?: 'processed' | 'confirmed' | 'finalized'; attempts?: number },
  ): Promise<MatchEscrowState> {
    const client = this.client as ArenaChainClient & {
      waitForMatchEscrowState?: (
        roomId: Uint8Array,
        predicate: (state: MatchEscrowState) => boolean,
        options?: {
          commitment?: 'processed' | 'confirmed' | 'finalized';
          attempts?: number;
          initialDelayMs?: number;
          maxDelayMs?: number;
        },
      ) => Promise<MatchEscrowState>;
    };
    if (typeof client.waitForMatchEscrowState === 'function') {
      return client.waitForMatchEscrowState(roomBytes, predicate, options);
    }

    const commitment = options?.commitment ?? 'confirmed';
    const attempts = Math.max(1, options?.attempts ?? 8);
    let lastError: unknown = new Error('Match escrow state did not reach the expected state.');
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const state = await client.getMatchEscrowState(roomBytes, commitment);
        if (predicate(state)) return state;
        lastError = new Error('Match escrow state did not reach the expected state.');
      } catch (error) {
        lastError = error;
      }
      if (attempt + 1 < attempts) {
        await new Promise(resolve => setTimeout(resolve, Math.min(2_000, 250 * (2 ** attempt))));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async getPassport(playerId: string, env: NodeJS.ProcessEnv = process.env): Promise<PassportStatus> {
    this.requirePokeEconomy();
    const quote = this.resolveQuote(env);
    await this.persistQuote(quote);
    const owner = new PublicKey(playerId);
    const held = this.chainStore
      ? BigInt(await this.chainStore.sumReservedEntryAtoms(playerId))
      : 0n;
    return this.client!.getPassportStatus({ owner, heldEntryAtoms: held, quote });
  }

  async assertCanPlay(playerId: string, env: NodeJS.ProcessEnv = process.env): Promise<PassportStatus> {
    const status = await this.getPassport(playerId, env);
    assertPassportEligible(status);
    return status;
  }

  previewCasual(collateralLamports: number): SolCasualPreview {
    return previewSolCasual(collateralLamports);
  }

  previewTreasury(grossLamports: number) {
    return previewTreasurySplit(grossLamports);
  }

  async createSolWagerDepositIntent(input: {
    roomId: string;
    playerId: string;
    side: 0 | 1;
    collateralLamports: number;
  }): Promise<{
    intentId: string;
    serializedTx: number[];
    economics: SolCasualPreview;
  }> {
    this.requireEnabled();
    if (!this.chainStore) throw new Error('Chain store is required for SOL wagers.');
    if (input.side === 1) {
      await this.seatMatchOpponent({ roomId: input.roomId, opponentId: input.playerId });
    }
    const scopeId = `${input.roomId}:${input.side === 0 ? 'creator' : 'opponent'}`;
    const roomBytes = uuidToBytes(input.roomId);
    const player = new PublicKey(input.playerId);
    const intent = await this.chainStore.createIntent({
      kind: 'sol_wager_deposit',
      scopeId,
      playerId: input.playerId,
      asset: 'SOL',
      amount: input.collateralLamports,
      idempotencyKey: `sol_wager_deposit:${scopeId}`,
      roomId: input.roomId,
      metadata: {
        side: input.side,
        expected: {
          signer: player.toBase58(),
          program: this.config.programId.toBase58(),
          instruction: 'deposit_sol_wager',
          discriminator: IX.depositSolWager.toString('hex'),
        },
      },
    });
    if (intent.status === 'confirmed') {
      return {
        intentId: intent.id,
        serializedTx: [],
        economics: previewSolCasual(input.collateralLamports),
      };
    }

    let escrowExists = false;
    try {
      const state = await this.client!.getMatchEscrowState(roomBytes);
      escrowExists = true;
      if (state.collateralLamports !== BigInt(input.collateralLamports)) {
        throw new Error('On-chain match collateral does not match the wager.');
      }
      const expectedParticipant = input.side === 0
        ? state.creator.toBase58()
        : state.opponent.toBase58();
      if (expectedParticipant !== input.playerId) {
        throw new Error('On-chain match participant does not match the wager.');
      }
      const deposited = input.side === 0 ? state.creatorDeposited : state.opponentDeposited;
      if (deposited) {
        await this.chainStore.setIntentStatus(intent.id, 'confirmed');
        return {
          intentId: intent.id,
          serializedTx: [],
          economics: previewSolCasual(input.collateralLamports),
        };
      }
    } catch (error) {
      if (escrowExists || !(error instanceof Error) || !/not found/i.test(error.message)) {
        throw error;
      }
    }

    const reusable = await this.reusableDepositTransaction(intent, escrowExists);
    if (reusable) {
      return {
        intentId: intent.id,
        serializedTx: reusable,
        economics: previewSolCasual(input.collateralLamports),
      };
    }

    const createIx = createMatchEscrowIx({
      programId: this.config.programId,
      creator: player,
      config: this.client!.configAddress,
      roomId: roomBytes,
      collateralLamports: input.collateralLamports,
    });
    const depositIx = depositSolWagerIx({
      programId: this.config.programId,
      depositor: player,
      roomId: roomBytes,
      side: input.side,
    });
    // Creator creates escrow + deposits; opponent only deposits.
    const ixs = input.side === 0 && !escrowExists ? [createIx, depositIx] : [depositIx];
    const tx = await this.client!.buildTransaction(player, ixs);
    const serialized = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    await this.chainStore.mergeIntentMetadata(intent.id, {
      serializedTx: Buffer.from(serialized).toString('base64'),
      lastValidBlockHeight: tx.lastValidBlockHeight,
      createsEscrow: input.side === 0 && !escrowExists,
    });
    await this.chainStore.setIntentStatus(intent.id, 'pending');
    return {
      intentId: intent.id,
      serializedTx: [...serialized],
      economics: previewSolCasual(input.collateralLamports),
    };
  }

  async confirmIntent(input: {
    intentId: string;
    signature: string;
    signedTransaction?: number[];
  }): Promise<{ status: string; error?: string }> {
    this.requireEnabled();
    if (!this.chainStore) throw new Error('Chain store is required.');
    const intent = await this.chainStore.getIntent(input.intentId);
    if (!intent) throw new Error(`Unknown chain intent: ${input.intentId}`);
    if (intent.status === 'confirmed') {
      console.info('[pokearena-deposit]', {
        signature: input.signature,
        intentId: intent.id,
        lobby: 'already-open',
        idempotent: true,
      });
      return { status: 'confirmed' };
    }
    if (intent.kind === 'sol_wager_deposit') {
      const inflight = this.depositConfirmations.get(intent.id);
      if (inflight) return inflight;
      const job = this.confirmSolDeposit(intent, input.signature, input.signedTransaction).finally(() => {
        this.depositConfirmations.delete(intent.id);
      });
      this.depositConfirmations.set(intent.id, job);
      return job;
    }
    const expected = this.expectedVerification(intent);
    const confirmed = expected
      ? await this.client!.verifyIntentTransaction(input.signature, expected)
      : await this.client!.confirmSignature(input.signature);
    await this.chainStore.setIntentStatus(input.intentId, confirmed.status, {
      signature: input.signature,
      slot: confirmed.slot,
      error: confirmed.error,
    });
    if (confirmed.status === 'confirmed' && intent.kind === 'poke_entry_deposit') {
      await this.chainStore.markEntryReserved(intent.tournamentId!, intent.playerId!);
    }
    return { status: confirmed.status };
  }

  async createPokeEntryDepositIntent(input: {
    tournamentId: string;
    playerId: string;
    playerPokeAta?: string;
    team?: string;
    entryAtoms?: number;
    quoteId?: string;
    fixedBurnFee?: boolean;
  }): Promise<{
    intentId: string;
    serializedTx: number[];
    entryAtoms: string;
    quote: PokeUsdQuote;
    passport: PassportStatus;
  }> {
    this.requirePokeEconomy();
    if (!this.chainStore) throw new Error('Chain store is required for POKE entries.');
    const quote = this.resolveQuote();
    await this.persistQuote(quote);
    if (
      input.fixedBurnFee
      && input.entryAtoms !== undefined
      && input.entryAtoms !== TOURNAMENT_BURN_FEE_ATOMS
    ) {
      assertTournamentBurnFeeAtoms(input.entryAtoms);
    }
    const entryAtoms = input.fixedBurnFee
      ? BigInt(TOURNAMENT_BURN_FEE_ATOMS)
      : input.entryAtoms !== undefined
      ? BigInt(input.entryAtoms)
      : tournamentEntryAtoms(quote);
    const quoteId = input.quoteId ?? quote.quoteId;
    const passportRequired = passportAtoms(quote);
    const owner = new PublicKey(input.playerId);
    if (!input.fixedBurnFee) {
      const liquid = await this.client!.getPokeBalance(owner);
      const held = BigInt(await this.chainStore.sumReservedEntryAtoms(input.playerId));
      const afterEntry = liquid > entryAtoms ? liquid - entryAtoms : 0n;
      const qualifyingAfter = afterEntry > held ? afterEntry - held : 0n;
      if (qualifyingAfter < passportRequired) {
        throw new Error(
          'Entering this cup would drop your POKE passport below $20. Hold enough POKE for entry plus the passport.',
        );
      }
    }
    const playerPokeAta = input.playerPokeAta
      ? new PublicKey(input.playerPokeAta)
      : await this.client!.getPokeAta(owner);

    const scopeId = `${input.tournamentId}:${input.playerId}`;
    const quoteIdBytes = sha256Key([quoteId]);
    const intent = await this.chainStore.createIntent({
      kind: 'poke_entry_deposit',
      scopeId,
      playerId: input.playerId,
      asset: 'POKE',
      amount: Number(entryAtoms),
      quoteId,
      idempotencyKey: `poke_entry_deposit:${scopeId}`,
      tournamentId: input.tournamentId,
      metadata: {
        playerPokeAta: playerPokeAta.toBase58(),
        ...(input.team ? { team: input.team } : {}),
        ...(input.fixedBurnFee ? { fixedBurnFee: true } : {}),
        expected: {
          signer: owner.toBase58(),
          program: this.config.programId.toBase58(),
          instruction: 'deposit_poke_entry',
          discriminator: IX.depositPokeEntry.toString('hex'),
          quoteId: quoteIdBytes.toString('hex'),
        },
      },
    });

    const ix = depositPokeEntryIx({
      programId: this.config.programId,
      player: owner,
      config: this.client!.configAddress,
      pokeMint: this.config.pokeMint,
      playerPoke: playerPokeAta,
      tournamentId: uuidToBytes(input.tournamentId),
      amount: entryAtoms,
      quoteId: quoteIdBytes,
      priceMicroUsd: quote.priceMicroUsd,
    });
    const tx = await this.client!.buildTransaction(owner, [ix]);
    const serialized = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    await this.chainStore.setIntentStatus(intent.id, 'pending');
    await this.chainStore.upsertEntryEscrow({
      tournamentId: input.tournamentId,
      playerId: input.playerId,
      amountAtoms: Number(entryAtoms),
      quoteId,
      status: 'pending',
      depositIntentId: intent.id,
    });

    const passport = await this.getPassport(input.playerId);
    return {
      intentId: intent.id,
      serializedTx: [...serialized],
      entryAtoms: entryAtoms.toString(),
      quote,
      passport,
    };
  }

  async listTreasury(limit = 50) {
    if (!this.chainStore) return [];
    return this.chainStore.listTreasuryDeposits(limit);
  }

  /**
   * Build burn instructions for all reserved entries at bracket lock.
   * Keeper/authority signs and submits; replay keys make burns idempotent.
   */
  async buildBurnEntryInstructions(input: {
    tournamentId: string;
    playerIds: string[];
  }): Promise<{
    instructions: import('@solana/web3.js').TransactionInstruction[];
    burnKeys: string[];
  }> {
    this.requirePokeEconomy();
    const instructions = [];
    const burnKeys: string[] = [];
    for (const playerId of input.playerIds) {
      const deposit = this.chainStore
        ? await this.chainStore.getIntentByScope(
            'poke_entry_deposit',
            `${input.tournamentId}:${playerId}`,
          )
        : undefined;
      if (deposit?.status !== 'confirmed') {
        throw new Error(`POKE entry deposit is not confirmed for ${playerId}.`);
      }
      assertTournamentBurnFeeAtoms(deposit.amount, playerId);
      const entryState = await this.client!.getEntryEscrowState(
        uuidToBytes(input.tournamentId),
        new PublicKey(playerId),
      );
      if (entryState.status !== 0) {
        throw new Error(`POKE entry is not burnable for ${playerId}.`);
      }
      const burnKey = sha256Key([`burn`, input.tournamentId, playerId]);
      burnKeys.push(burnKey.toString('hex'));
      if (this.chainStore) {
        await this.chainStore.createIntent({
          kind: 'poke_entry_burn',
          scopeId: `${input.tournamentId}:${playerId}`,
          playerId,
          asset: 'POKE',
          amount: 0,
          idempotencyKey: `poke_entry_burn:${input.tournamentId}:${playerId}`,
          tournamentId: input.tournamentId,
        });
      }
      instructions.push(burnPokeEntryIx({
        programId: this.config.programId,
        authority: this.keeperPublicKey(),
        config: this.client!.configAddress,
        pokeMint: this.config.pokeMint,
        tournamentId: uuidToBytes(input.tournamentId),
        player: new PublicKey(playerId),
        burnKey,
      }));
    }
    return { instructions, burnKeys };
  }

  async lockTournament(input: {
    tournamentId: string;
    playerIds: string[];
    prizeLamports: number;
  }): Promise<void> {
    this.requirePokeEconomy();
    if (!this.chainStore) throw new Error('Chain store is required for tournament chain actions.');
    for (const playerId of input.playerIds) {
      const deposit = await this.chainStore.getIntentByScope(
        'poke_entry_deposit',
        `${input.tournamentId}:${playerId}`,
      );
      if (deposit?.status !== 'confirmed') {
        throw new Error(`POKE entry deposit is not confirmed for ${playerId}.`);
      }
      assertTournamentBurnFeeAtoms(deposit.amount, playerId);
      const state = await this.client!.getEntryEscrowState(
        uuidToBytes(input.tournamentId),
        new PublicKey(playerId),
      );
      if (state.status !== 0 && state.status !== 1) {
        throw new Error(`POKE entry is not burnable for ${playerId}.`);
      }
    }
    await this.reserveTournamentPrize(input);
    for (const playerId of input.playerIds) {
      const deposit = await this.chainStore.getIntentByScope(
        'poke_entry_deposit',
        `${input.tournamentId}:${playerId}`,
      );
      if (deposit?.status !== 'confirmed') {
        throw new Error(`POKE entry deposit is not confirmed for ${playerId}.`);
      }
      assertTournamentBurnFeeAtoms(deposit.amount, playerId);
      const entryState = await this.client!.getEntryEscrowState(
        uuidToBytes(input.tournamentId),
        new PublicKey(playerId),
      );
      if (entryState.status === 2) throw new Error(`POKE entry was already refunded for ${playerId}.`);
      const intent = await this.chainStore.getIntentByScope(
        'poke_entry_burn',
        `${input.tournamentId}:${playerId}`,
      );
      const burnIntent = intent ?? await this.chainStore.createIntent({
        kind: 'poke_entry_burn',
        scopeId: `${input.tournamentId}:${playerId}`,
        playerId,
        asset: 'POKE',
        amount: 0,
        idempotencyKey: `poke_entry_burn:${input.tournamentId}:${playerId}`,
        tournamentId: input.tournamentId,
      });
      if (entryState.status === 1) {
        if (burnIntent.status !== 'confirmed') {
          await this.chainStore.setIntentStatus(burnIntent.id, 'confirmed');
        }
        await this.chainStore.markEntryBurned(input.tournamentId, playerId);
        continue;
      }
      const burnKey = sha256Key(['burn', input.tournamentId, playerId]);
      const result = await this.submitKeeperTransaction(this.keeperKeypair(), [
        burnPokeEntryIx({
          programId: this.config.programId,
          authority: this.keeperPublicKey(),
          config: this.client!.configAddress,
          pokeMint: this.config.pokeMint,
          tournamentId: uuidToBytes(input.tournamentId),
          player: new PublicKey(playerId),
          burnKey,
        }),
      ]);
      if (result.status !== 'confirmed') {
        await this.chainStore.setIntentStatus(burnIntent.id, result.status, {
          signature: result.signature || undefined,
          slot: result.slot,
          error: result.error,
        });
        throw new Error(result.error ?? 'POKE entry burn failed.');
      }
      const state = await this.client!.getEntryEscrowState(
        uuidToBytes(input.tournamentId),
        new PublicKey(playerId),
      );
      if (state.status !== 1) throw new Error('POKE entry burn was not reflected on-chain.');
      await this.chainStore.setIntentStatus(burnIntent.id, 'confirmed', {
        signature: result.signature,
        slot: result.slot,
      });
      await this.chainStore.markEntryBurned(input.tournamentId, playerId);
    }

  }

  private async reserveTournamentPrize(input: {
    tournamentId: string;
    prizeLamports: number;
  }): Promise<void> {
    if (!this.chainStore) throw new Error('Chain store is required for tournament chain actions.');
    const reserve = await this.chainStore.createIntent({
      kind: 'prize_reserve',
      scopeId: input.tournamentId,
      asset: 'SOL',
      amount: input.prizeLamports,
      idempotencyKey: `prize_reserve:${input.tournamentId}`,
      tournamentId: input.tournamentId,
    });
    if (reserve.status !== 'confirmed') {
      const existingReserve = await this.client!.getPrizeReserveState(uuidToBytes(input.tournamentId))
        .catch(() => undefined);
      if (existingReserve?.status === 0 && existingReserve.amount === BigInt(input.prizeLamports)) {
        await this.chainStore.setIntentStatus(reserve.id, 'confirmed');
      } else {
        const result = await this.submitKeeperTransaction(this.keeperKeypair(), [
          this.buildReservePrizeIx({
            tournamentId: input.tournamentId,
            amountLamports: input.prizeLamports,
          }),
        ]);
        if (result.status !== 'confirmed') {
          await this.chainStore.setIntentStatus(reserve.id, result.status, {
            signature: result.signature || undefined,
            slot: result.slot,
            error: result.error,
          });
          throw new Error(result.error ?? 'Prize reserve failed.');
        }
        const state = await this.client!.getPrizeReserveState(uuidToBytes(input.tournamentId));
        if (state.status !== 0 || state.amount !== BigInt(input.prizeLamports)) {
          throw new Error('Prize reserve was not reflected on-chain.');
        }
        await this.chainStore.setIntentStatus(reserve.id, 'confirmed', {
          signature: result.signature,
          slot: result.slot,
        });
      }
    }
    await this.chainStore.recordPrizeReserve({
      tournamentId: input.tournamentId,
      amountLamports: input.prizeLamports,
      status: 'reserved',
      reserveIntentId: reserve.id,
    });
  }

  async refundPokeEntry(input: {
    tournamentId: string;
    playerId: string;
    playerPokeAta: string;
  }): Promise<void> {
    this.requirePokeEconomy();
    if (!this.chainStore) throw new Error('Chain store is required for POKE entries.');
    const intent = await this.chainStore.createIntent({
      kind: 'poke_entry_refund',
      scopeId: `${input.tournamentId}:${input.playerId}`,
      playerId: input.playerId,
      asset: 'POKE',
      amount: 0,
      idempotencyKey: `poke_entry_refund:${input.tournamentId}:${input.playerId}`,
      tournamentId: input.tournamentId,
    });
    if (intent.status === 'confirmed') return;
    const existing = await this.client!.getEntryEscrowState(
      uuidToBytes(input.tournamentId),
      new PublicKey(input.playerId),
    );
    if (existing.status === 2) {
      await this.chainStore.setIntentStatus(intent.id, 'confirmed');
      await this.chainStore.markEntryRefunded(input.tournamentId, input.playerId);
      return;
    }
    const result = await this.submitKeeperTransaction(this.keeperKeypair(), [
      refundPokeEntryIx({
        programId: this.config.programId,
        authority: this.keeperPublicKey(),
        config: this.client!.configAddress,
        pokeMint: this.config.pokeMint,
        playerPoke: new PublicKey(input.playerPokeAta),
        tournamentId: uuidToBytes(input.tournamentId),
        player: new PublicKey(input.playerId),
      }),
    ]);
    if (result.status !== 'confirmed') {
      await this.chainStore.setIntentStatus(intent.id, result.status, {
        signature: result.signature || undefined,
        slot: result.slot,
        error: result.error,
      });
      throw new Error(result.error ?? 'POKE refund failed.');
    }
    await this.chainStore.setIntentStatus(intent.id, 'confirmed', {
      signature: result.signature,
      slot: result.slot,
    });
    await this.chainStore.markEntryRefunded(input.tournamentId, input.playerId);
  }

  async payTournamentPrize(input: {
    tournamentId: string;
    winnerId: string;
  }): Promise<import('./mock-economics').ChainPayoutResult> {
    this.requirePokeEconomy();
    if (!this.chainStore) throw new Error('Chain store is required for tournament chain actions.');
    const intent = await this.chainStore.createIntent({
      kind: 'prize_pay',
      scopeId: input.tournamentId,
      playerId: input.winnerId,
      asset: 'SOL',
      amount: 0,
      idempotencyKey: `prize_pay:${input.tournamentId}`,
      tournamentId: input.tournamentId,
    });
    const tournamentBytes = uuidToBytes(input.tournamentId);
    const reserve = await this.client!.getPrizeReserveState(tournamentBytes);
    if (reserve.status === 1 && !reserve.winner.equals(new PublicKey(input.winnerId))) {
      throw new Error('Tournament prize was already paid to a different recipient.');
    }
    if (reserve.status === 1) {
      if (intent.status !== 'confirmed') await this.chainStore.setIntentStatus(intent.id, 'confirmed');
      await this.chainStore.recordPrizeReserve({
        tournamentId: input.tournamentId,
        amountLamports: Number(reserve.amount),
        status: 'paid',
        settleIntentId: intent.id,
        winnerId: input.winnerId,
      });
    }
    if (reserve.status !== 1) {
      const settlementKey = sha256Key(['prize', input.tournamentId, input.winnerId]);
      const result = await this.submitKeeperTransaction(this.keeperKeypair(), [
        setPrizeWinnerIx({
          programId: this.config.programId,
          authority: this.keeperPublicKey(),
          config: this.client!.configAddress,
          winner: new PublicKey(input.winnerId),
          tournamentId: tournamentBytes,
        }),
        payPrizeIx({
          programId: this.config.programId,
          authority: this.keeperPublicKey(),
          config: this.client!.configAddress,
          winner: new PublicKey(input.winnerId),
          tournamentId: tournamentBytes,
          settlementKey,
        }),
      ]);
      if (result.status !== 'confirmed') {
        await this.chainStore.setIntentStatus(intent.id, result.status, {
          signature: result.signature || undefined,
          slot: result.slot,
          error: result.error,
        });
        throw new Error(result.error ?? 'Tournament prize payment failed.');
      }
      const paid = await this.client!.getPrizeReserveState(tournamentBytes);
      if (
        paid.status !== 1
        || !paid.winnerSet
        || !paid.winner.equals(new PublicKey(input.winnerId))
      ) {
        throw new Error('Tournament prize payment was not reflected on-chain.');
      }
      await this.chainStore.setIntentStatus(intent.id, 'confirmed', {
        signature: result.signature,
        slot: result.slot,
      });
      await this.chainStore.recordPrizeReserve({
        tournamentId: input.tournamentId,
        amountLamports: Number(paid.amount),
        status: 'paid',
        settleIntentId: intent.id,
        winnerId: input.winnerId,
      });
    }
    return {
      symbol: 'SOL',
      rail: 'sol_chain',
      winnerId: input.winnerId,
      amount: Number(reserve.amount),
      settlementKey: `prize_pay:${input.tournamentId}`,
      settlementKeyHex: sha256Key(['prize', input.tournamentId, input.winnerId]).toString('hex'),
    };
  }

  /** Submit a keeper-signed transaction using the configured keeper account. */
  async submitKeeperTransaction(
    authority: Keypair,
    instructions: Parameters<ArenaChainClient['buildTransaction']>[1],
  ): Promise<SentTransaction> {
    this.requireEnabled();
    if (!authority.publicKey.equals(this.config.keeper)) {
      throw new Error('Keeper transaction signer does not match POKEARENA_KEEPER.');
    }
    if (this.submitKeeperOverride) return this.submitKeeperOverride(instructions);
    const tx = await this.client!.buildTransaction(authority.publicKey, instructions);
    return this.client!.sendAndConfirm(tx, [authority]);
  }

  private async syncSettledCasualRoom(room: DurableCasualRoom, economics: EconomicsStore): Promise<void> {
    if (!this.chainStore) throw new Error('Chain store is required for SOL wagers.');
    const win = await this.chainStore.getIntentByScope('sol_match_win', room.id);
    const tie = await this.chainStore.getIntentByScope('sol_match_tie', room.id);
    const confirmedWin = win?.playerId && win.status === 'confirmed';
    const recordedWin = !confirmedWin
      && win?.playerId
      && usableSettlementIntent(win.status)
      && tie?.status !== 'confirmed';
    if (confirmedWin || recordedWin) {
      const loserId = win!.playerId === room.creatorId ? room.opponentId : room.creatorId;
      if (!loserId || loserId === win!.playerId) {
        throw new Error('Settled win is missing the opposing player.');
      }
      await economics.completeCasualWin({
        roomId: room.id,
        winnerId: win!.playerId!,
        loserId,
        collateral: room.collateral,
        reason: 'casual-win',
      });
      return;
    }
    const opponentId = room.opponentId;
    if (!opponentId) {
      await releaseSolRoomRecord(economics, room);
      return;
    }
    await economics.completeCasualTie({
      roomId: room.id,
      player1Id: room.creatorId,
      player2Id: opponentId,
      collateral: room.collateral,
    });
  }

  async prepareCasualStart(roomId: string): Promise<void> {
    this.requireEnabled();
    if (!this.chainStore) throw new Error('Chain store is required for SOL wagers.');
    const creator = await this.chainStore.getIntentByScope('sol_wager_deposit', `${roomId}:creator`);
    const opponent = await this.chainStore.getIntentByScope('sol_wager_deposit', `${roomId}:opponent`);
    if (creator?.status !== 'confirmed' || opponent?.status !== 'confirmed') {
      throw new Error('Both SOL deposits must be confirmed before the match starts.');
    }
    const roomBytes = uuidToBytes(roomId);
    const state = await this.client!.getMatchEscrowState(roomBytes);
    const feeIntent = await this.chainStore.createIntent({
      kind: 'sol_match_fee',
      scopeId: roomId,
      asset: 'SOL',
      amount: Number((state.collateralLamports * 2n * 200n) / 10_000n),
      idempotencyKey: `sol_match_fee:${roomId}`,
      roomId,
    });
    if (state.status === 3 && state.feeCharged) {
      if (feeIntent.status !== 'confirmed') {
        await this.chainStore.setIntentStatus(feeIntent.id, 'confirmed');
      }
      return;
    }
    if (state.status !== 2 || !state.creatorDeposited || !state.opponentDeposited) {
      throw new Error('On-chain match escrow is not funded.');
    }
    const feeAmount = Number((state.collateralLamports * 2n * 200n) / 10_000n);
    if (feeIntent.status !== 'confirmed') {
      const result = await this.submitKeeperTransaction(this.keeperKeypair(), [
        this.buildChargeMatchFeeIx(roomId),
      ]);
      if (result.status !== 'confirmed') {
        await this.chainStore.setIntentStatus(feeIntent.id, result.status, {
          signature: result.signature || undefined,
          slot: result.slot,
          error: result.error,
        });
        throw new Error(result.error ?? 'SOL match fee transaction failed.');
      }
      await this.chainStore.setIntentStatus(feeIntent.id, 'confirmed', {
        signature: result.signature,
        slot: result.slot,
      });
    }
    await this.waitForMatchEscrowState(
      roomBytes,
      after => after.status === 3 && after.feeCharged,
    );
  }

  async settleCasual(input: {
    roomId: string;
    creatorId: string;
    opponentId: string;
    winnerId?: string;
  }): Promise<import('./mock-economics').ChainPayoutResult> {
    this.requireEnabled();
    if (!this.chainStore) throw new Error('Chain store is required for SOL wagers.');
    const isTie = !input.winnerId;
    const kind = isTie ? 'sol_match_tie' : 'sol_match_win';
    // The intent is the authoritative result. It is written before the keeper signs.
    const intent = await this.chainStore.createIntent({
      kind,
      scopeId: input.roomId,
      playerId: input.winnerId,
      asset: 'SOL',
      amount: 0,
      idempotencyKey: `${kind}:${input.roomId}`,
      roomId: input.roomId,
      metadata: {
        settlementPhase: 'recorded',
        ...(input.winnerId ? { winnerId: input.winnerId } : {}),
      },
    });
    await this.rememberIntent(intent.id, {
      settlementPhase: intent.metadata.settlementPhase ?? 'recorded',
      ...(input.winnerId ? { winnerId: input.winnerId } : {}),
    });
    const roomBytes = uuidToBytes(input.roomId);
    let state = await this.client!.getMatchEscrowState(roomBytes);
    if (state.status === 4) {
      await this.assertRecordedSettlementAgrees(input.roomId, isTie);
      if (intent.status !== 'confirmed') {
        await this.chainStore.setIntentStatus(intent.id, 'confirmed');
      }
      await this.rememberIntent(intent.id, { settlementPhase: 'confirmed' });
    } else {
      if (!isTie && state.status === 2 && !state.feeCharged) {
        await this.prepareCasualStart(input.roomId);
        state = await this.client!.getMatchEscrowState(roomBytes);
      }
      if (state.status !== 4) {
        const compatible = isTie
          ? state.status === 2 || state.status === 3
          : state.status === 3 && state.feeCharged;
        if (!compatible) {
          await this.markSettlementRetryable(
            intent.id,
            `Refusing ${kind} while escrow status is ${state.status}.`,
          );
          throw new Error(`Refusing ${kind} while escrow status is ${state.status}.`);
        }
        const settlementKey = sha256Key([kind, input.roomId]);
        const instruction = isTie
          ? settleMatchTieIx({
              programId: this.config.programId,
              authority: this.keeperPublicKey(),
              config: this.client!.configAddress,
              creator: new PublicKey(input.creatorId),
              opponent: new PublicKey(input.opponentId),
              roomId: roomBytes,
              settlementKey,
            })
          : settleMatchWinIx({
              programId: this.config.programId,
              authority: this.keeperPublicKey(),
              config: this.client!.configAddress,
              winner: new PublicKey(input.winnerId!),
              roomId: roomBytes,
              settlementKey,
            });
        await this.rememberIntent(intent.id, { settlementPhase: 'submitted' });
        const result = await this.submitKeeperTransaction(this.keeperKeypair(), [instruction]);
        if (result.status !== 'confirmed') {
          const landed = await Promise.resolve(this.client!.getMatchEscrowState(roomBytes)).catch(() => undefined);
          if (landed?.status === 4) {
            await this.assertRecordedSettlementAgrees(input.roomId, isTie);
            if (intent.status !== 'confirmed') {
              await this.chainStore.setIntentStatus(intent.id, 'confirmed', {
                signature: result.signature || undefined,
                error: result.error,
              });
            }
            await this.rememberIntent(intent.id, { settlementPhase: 'confirmed' });
          } else {
            await this.markSettlementRetryable(
              intent.id,
              result.error ?? 'SOL match settlement failed.',
              result.signature || undefined,
            );
            throw new Error(result.error ?? 'SOL match settlement failed.');
          }
        }
        await this.chainStore.setIntentStatus(intent.id, 'confirmed', {
          signature: result.signature,
          slot: result.slot,
        });
        await this.rememberIntent(intent.id, {
          settlementPhase: 'confirmed',
          signature: result.signature,
        });
      }
    }
    // The keeper transaction is already confirmed. `finalized` account reads
    // lag that confirmation, and throwing here leaves the room battling.
    let after: MatchEscrowState;
    try {
      after = await this.waitForMatchEscrowState(
        roomBytes,
        candidate => candidate.status === 4,
        { commitment: 'confirmed', attempts: 8 },
      );
    } catch (error) {
      const latest = await Promise.resolve(
        this.client!.getMatchEscrowState(roomBytes, 'confirmed'),
      ).catch(() => undefined);
      if (latest?.status === 4) {
        after = latest;
      } else {
        after = { ...state, status: 4, feeCharged: state.feeCharged || !isTie };
        console.info('[pokearena-settlement]', {
          roomId: input.roomId,
          phase: 'confirmed-before-account-read',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const gross = after.collateralLamports * 2n;
    const fee = after.feeCharged ? (gross * 200n) / 10_000n : 0n;
    const payout = isTie ? (gross - fee) / 2n : gross - fee;
    return {
      symbol: 'SOL',
      rail: 'sol_chain',
      ...(input.winnerId ? { winnerId: input.winnerId } : {}),
      amount: Number(payout),
      settlementKey: `${kind}:${input.roomId}`,
      settlementKeyHex: sha256Key([kind, input.roomId]).toString('hex'),
    };
  }

  /**
   * Return a SOL wager that has no authoritative battle result.
   * Open/Funding uses `refund_sol_wager`. Funded or Active (fee taken, no
   * result) uses `settle_match_tie`, which returns both stakes or the
   * post-fee remainder. Settled is a no-op.
   */
  async refundCasual(roomId: string, creatorId: string, opponentId?: string): Promise<void> {
    this.requireEnabled();
    if (!this.chainStore) throw new Error('Chain store is required for SOL wagers.');
    const roomBytes = uuidToBytes(roomId);
    let state: Awaited<ReturnType<ArenaChainClient['getMatchEscrowState']>>;
    try {
      state = await this.client!.getMatchEscrowState(roomBytes);
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) return;
      throw error;
    }
    if (state.creator.toBase58() !== creatorId) {
      throw new Error('On-chain match creator does not match this room.');
    }
    if (state.status === 4) return;
    if (state.status === 2 || state.status === 3) {
      const chainOpponent = state.opponent.toBase58();
      if (opponentId && chainOpponent !== opponentId) {
        throw new Error('On-chain opponent does not match the seated player.');
      }
      if (state.opponent.equals(PublicKey.default)) {
        throw new Error('Funded match is missing an on-chain opponent.');
      }
      await this.settleCasual({
        roomId,
        creatorId,
        opponentId: chainOpponent,
      });
      return;
    }
    const sides: Array<{ side: 0 | 1; playerId: string; deposited: boolean }> = [
      { side: 0, playerId: creatorId, deposited: state.creatorDeposited },
      { side: 1, playerId: opponentId ?? state.opponent.toBase58(), deposited: state.opponentDeposited },
    ];
    for (const side of sides) {
      if (!side.deposited) continue;
      if (side.side === 1 && side.playerId !== state.opponent.toBase58()) {
        throw new Error('On-chain opponent does not match the seated player.');
      }
      const intent = await this.chainStore.createIntent({
        kind: 'sol_wager_refund',
        scopeId: `${roomId}:${side.side}`,
        playerId: side.playerId,
        asset: 'SOL',
        amount: Number(state.collateralLamports),
        idempotencyKey: `sol_wager_refund:${roomId}:${side.side}`,
        roomId,
      });
      if (intent.status === 'confirmed') continue;
      const result = await this.submitKeeperTransaction(this.keeperKeypair(), [
        refundSolWagerIx({
          programId: this.config.programId,
          authority: this.keeperPublicKey(),
          config: this.client!.configAddress,
          recipient: new PublicKey(side.playerId),
          roomId: roomBytes,
          side: side.side,
        }),
      ]);
      if (result.status !== 'confirmed') {
        await this.chainStore.setIntentStatus(intent.id, 'failed', {
          signature: result.signature || undefined,
          slot: result.slot,
          error: result.error,
        });
        throw new Error(result.error ?? 'SOL refund failed.');
      }
      await this.waitForMatchEscrowState(
        roomBytes,
        after => side.side === 0 ? !after.creatorDeposited : !after.opponentDeposited,
      );
      await this.chainStore.setIntentStatus(intent.id, 'confirmed', {
        signature: result.signature,
        slot: result.slot,
      });
    }
  }

  async seatMatchOpponent(input: { roomId: string; opponentId: string }): Promise<void> {
    this.requireEnabled();
    const roomBytes = uuidToBytes(input.roomId);
    const opponent = new PublicKey(input.opponentId);
    let state: Awaited<ReturnType<ArenaChainClient['getMatchEscrowState']>>;
    try {
      state = await this.client!.getMatchEscrowState(roomBytes);
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) {
        throw new Error('Creator SOL deposit is not on-chain yet.');
      }
      throw error;
    }
    if (state.opponent.equals(opponent)) return;
    if (state.opponentDeposited || (!state.opponent.equals(PublicKey.default) && !state.opponent.equals(opponent))) {
      throw new Error('A different opponent is already seated on-chain.');
    }
    const result = await this.submitKeeperTransaction(this.keeperKeypair(), [
      seatMatchOpponentIx({
        programId: this.config.programId,
        authority: this.keeperPublicKey(),
        config: this.client!.configAddress,
        opponent,
        roomId: roomBytes,
      }),
    ]);
    if (result.status !== 'confirmed') {
      throw new Error(result.error ?? 'Seating the match opponent failed.');
    }
    await this.waitForMatchEscrowState(
      roomBytes,
      after => after.opponent.equals(opponent),
    );
  }

  /**
   * Boot recovery for one SOL room. A persisted win or tie is settled again
   * until the escrow is Settled. An Active escrow, or a battle that was
   * already starting or fighting, is tie-settled when no result was stored:
   * the simulator does not survive a restart. A Funded lobby that never
   * started is left untouched. An empty escrow is refunded. A Funding escrow
   * with a landed deposit stays joinable. An already-settled escrow is
   * reconciled from the persisted intent.
   */
  async recoverCasualRoom(room: DurableCasualRoom, economics: EconomicsStore): Promise<void> {
    this.requireEnabled();
    if (room.status === 'completed' || room.status === 'cancelled') return;
    const roomBytes = uuidToBytes(room.id);
    let state: Awaited<ReturnType<ArenaChainClient['getMatchEscrowState']>> | undefined;
    try {
      state = await this.client!.getMatchEscrowState(roomBytes);
    } catch (error) {
      if (!(error instanceof Error) || !/not found/i.test(error.message)) throw error;
    }
    if (!state) {
      // The create+deposit transaction may still be in flight. Cancelling here
      // lets it land into an escrow the next boot will ignore.
      if (await this.depositStillLive(room.id)) return;
      await releaseSolRoomRecord(economics, room);
      return;
    }
    if (state.status === 4) {
      await this.syncSettledCasualRoom(room, economics);
      return;
    }
    const persisted = await this.persistedMatchSettlement(room.id);
    if (persisted && (state.status === 2 || state.status === 3)) {
      const opponentId = room.opponentId ?? state.opponent.toBase58();
      await this.settleCasual({
        roomId: room.id,
        creatorId: room.creatorId,
        opponentId,
        ...(persisted.winnerId ? { winnerId: persisted.winnerId } : {}),
      });
      await this.syncSettledCasualRoom(room, economics);
      return;
    }
    const battleDied = room.status === 'battling'
      || room.status === 'starting'
      || state.status === 3;
    if (battleDied && (state.status === 2 || state.status === 3)) {
      const opponentId = room.opponentId && !state.opponent.equals(PublicKey.default)
        ? room.opponentId
        : state.opponent.toBase58();
      if (opponentId && opponentId !== PublicKey.default.toBase58()) {
        // The simulator is gone and no result was stored. Return the stakes
        // with the program's tie rules instead of leaving the vault locked.
        await this.settleCasual({
          roomId: room.id,
          creatorId: room.creatorId,
          opponentId,
        });
        await this.syncSettledCasualRoom(room, economics);
      }
      return;
    }
    if (state.status === 2 || state.status === 3) return;
    if (state.status === 1 && (state.creatorDeposited || state.opponentDeposited)) return;
    await this.refundCasual(room.id, room.creatorId, room.opponentId);
    await releaseSolRoomRecord(economics, room);
  }

  /** A settlement that was already requested. Not inferred from escrow status. */
  private async persistedMatchSettlement(roomId: string): Promise<{ winnerId?: string } | undefined> {
    if (!this.chainStore) return undefined;
    const win = await this.chainStore.getIntentByScope('sol_match_win', roomId);
    if (win?.playerId && usableSettlementIntent(win.status)) return { winnerId: win.playerId };
    const tie = await this.chainStore.getIntentByScope('sol_match_tie', roomId);
    if (tie && usableSettlementIntent(tie.status)) return {};
    return undefined;
  }

  buildChargeMatchFeeIx(roomId: string) {
    this.requireEnabled();
    return chargeMatchFeeIx({
      programId: this.config.programId,
      authority: this.keeperPublicKey(),
      config: this.client!.configAddress,
      feeVault: this.config.feeVault,
      roomId: uuidToBytes(roomId),
    });
  }

  buildSettleMatchWinIx(input: { roomId: string; winner: string; settlementKey?: Uint8Array }) {
    this.requireEnabled();
    const settlementKey = input.settlementKey ?? sha256Key(['win', input.roomId, input.winner]);
    return {
      settlementKey,
      instruction: settleMatchWinIx({
        programId: this.config.programId,
        authority: this.keeperPublicKey(),
        config: this.client!.configAddress,
        winner: new PublicKey(input.winner),
        roomId: uuidToBytes(input.roomId),
        settlementKey,
      }),
    };
  }

  buildSettleMatchTieIx(input: {
    roomId: string;
    creator: string;
    opponent: string;
    settlementKey?: Uint8Array;
  }) {
    this.requireEnabled();
    const settlementKey = input.settlementKey ?? sha256Key(['tie', input.roomId]);
    return {
      settlementKey,
      instruction: settleMatchTieIx({
        programId: this.config.programId,
        authority: this.keeperPublicKey(),
        config: this.client!.configAddress,
        creator: new PublicKey(input.creator),
        opponent: new PublicKey(input.opponent),
        roomId: uuidToBytes(input.roomId),
        settlementKey,
      }),
    };
  }

  buildReservePrizeIx(input: { tournamentId: string; amountLamports: number }) {
    this.requireEnabled();
    return reservePrizeIx({
      programId: this.config.programId,
      authority: this.keeperPublicKey(),
      config: this.client!.configAddress,
      treasuryVault: this.config.treasuryVault,
      tournamentId: uuidToBytes(input.tournamentId),
      amount: input.amountLamports,
    });
  }

  buildPayPrizeIx(input: { tournamentId: string; winner: string }) {
    this.requireEnabled();
    const settlementKey = sha256Key(['prize', input.tournamentId, input.winner]);
    return {
      settlementKey,
      instruction: payPrizeIx({
        programId: this.config.programId,
        authority: this.keeperPublicKey(),
        config: this.client!.configAddress,
        winner: new PublicKey(input.winner),
        tournamentId: uuidToBytes(input.tournamentId),
        settlementKey,
      }),
    };
  }

  /** Quoted ~$5 POKE entry atoms for the active oracle quote. */
  quotedEntryAtoms(env: NodeJS.ProcessEnv = process.env): { atoms: bigint; quote: PokeUsdQuote } {
    this.requirePokeEconomy();
    const quote = this.resolveQuote(env);
    return { atoms: tournamentEntryAtoms(quote), quote };
  }

  private keeperKeypair(): Keypair {
    if (this.injectedKeeper) return this.injectedKeeper;
    const path = this.env.POKEARENA_KEEPER_KEYPAIR ?? this.env.POKEARENA_AUTHORITY_KEYPAIR;
    if (!path) throw new Error('POKEARENA_KEEPER_KEYPAIR is required for chain settlement.');
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
  }

  private keeperPublicKey(): PublicKey {
    return this.keeperKeypair().publicKey;
  }

  private async confirmSolDeposit(
    intent: ChainIntentRow,
    signature: string,
    signedTransaction?: number[],
  ): Promise<{ status: string; error?: string }> {
    const serialized = intent.metadata.serializedTx;
    if (!intent.playerId || typeof serialized !== 'string' || !serialized) {
      console.info('[pokearena-deposit]', {
        signature,
        intentId: intent.id,
        localVerification: 'rejected',
        lobby: 'rejected',
        reason: 'Issued deposit transaction is missing.',
      });
      return { status: 'failed', error: 'Issued deposit transaction is missing.' };
    }
    const issuedBytes = Buffer.from(serialized, 'base64');
    const signedBytes = signedTransaction ? Uint8Array.from(signedTransaction) : undefined;
    if (this.depositWatchers.has(intent.id)) {
      return { status: 'pending', error: 'Deposit transaction is still pending.' };
    }
    await this.rememberIntent(intent.id, { signature });
    const superseded = await this.supersedeCreateIfEscrowExists(intent, signature, signedBytes ?? issuedBytes);
    if (superseded) return superseded;

    const confirmed = await this.client!.confirmIssuedDeposit({
      signature,
      serializedTx: issuedBytes,
      expectedSigner: new PublicKey(intent.playerId),
      ...(signedBytes ? { signedSerializedTx: signedBytes } : {}),
    });
    await this.persistDepositOutcome(intent, signature, confirmed);
    if (confirmed.status === 'pending') {
      this.ensureDepositWatcher(intent, signature, signedBytes);
    }
    console.info('[pokearena-deposit]', {
      signature,
      intentId: intent.id,
      roomId: intent.roomId,
      confirmation: confirmed.status,
      lobby: confirmed.status === 'confirmed' ? 'opening' : confirmed.status,
    });
    return {
      status: confirmed.status,
      ...(confirmed.error ? { error: confirmed.error } : {}),
    };
  }

  /** Resume signature watches after a process restart. Pending is not failure. */
  async resumePendingDeposits(): Promise<void> {
    const store = this.chainStore as (PostgresChainStore & {
      listPendingIntents?: () => Promise<ChainIntentRow[]>;
    }) | null;
    if (!store || typeof store.listPendingIntents !== 'function' || !this.client) return;
    const pending = await store.listPendingIntents();
    for (const intent of pending) {
      if (intent.kind !== 'sol_wager_deposit') continue;
      const signature = intent.metadata.signature;
      if (typeof signature !== 'string' || !signature) continue;
      this.ensureDepositWatcher(intent, signature);
    }
  }

  /**
   * The escrow account is authoritative. A stale pending or failed intent
   * must not hide a deposit that already landed.
   */
  async adoptEscrowDeposit(roomId: string, side: 'creator' | 'opponent'): Promise<void> {
    if (!this.chainStore) return;
    const intent = await this.chainStore.getIntentByScope('sol_wager_deposit', `${roomId}:${side}`);
    if (!intent || intent.status === 'confirmed') return;
    await this.chainStore.setIntentStatus(intent.id, 'confirmed');
  }

  /** True while a creator deposit is confirmed, still inside its blockhash, or already on the escrow. */
  async depositStillLive(roomId: string): Promise<boolean> {
    this.requireEnabled();
    if (!this.chainStore) return false;
    const intent = await this.chainStore.getIntentByScope('sol_wager_deposit', `${roomId}:creator`);
    if (intent?.status === 'confirmed') return true;
    if (intent?.status === 'pending') {
      // A submitted signature is still authoritative after its blockhash
      // height passes. The watcher records failed or expired when it is not.
      if (typeof intent.metadata.signature === 'string' && intent.metadata.signature) return true;
      const expiry = Number(intent.metadata.lastValidBlockHeight);
      try {
        const height = await this.client!.getBlockHeight();
        if (height <= expiry) return true;
      } catch {
        return true;
      }
    }
    try {
      const state = await this.client!.getMatchEscrowState(uuidToBytes(roomId));
      return state.creatorDeposited || state.opponentDeposited;
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) return false;
      return true;
    }
  }

  private async reusableDepositTransaction(
    intent: ChainIntentRow,
    escrowExists: boolean,
  ): Promise<number[] | undefined> {
    const serialized = intent.metadata.serializedTx;
    if (typeof serialized !== 'string' || !serialized) return undefined;
    if (intent.status !== 'pending' && intent.status !== 'created') return undefined;
    const bytes = Buffer.from(serialized, 'base64');
    if (escrowExists && transactionCreatesEscrow(bytes, this.config.programId)) return undefined;
    const expiry = Number(intent.metadata.lastValidBlockHeight);
    if (Number.isFinite(expiry)) {
      try {
        const height = await this.client!.getBlockHeight();
        if (height > expiry) return undefined;
      } catch {
        // A failed height read must not mint a second create transaction.
      }
    }
    return [...bytes];
  }

  private async supersedeCreateIfEscrowExists(
    intent: ChainIntentRow,
    signature: string,
    signedBytes: Uint8Array,
  ): Promise<{ status: string; error?: string } | undefined> {
    if (!intent.roomId || !transactionCreatesEscrow(signedBytes, this.config.programId)) return undefined;
    let state: MatchEscrowState;
    try {
      state = await this.client!.getMatchEscrowState(uuidToBytes(intent.roomId));
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) return undefined;
      throw error;
    }
    const side = Number(intent.metadata.side) === 1 ? 1 : 0;
    const deposited = side === 0 ? state.creatorDeposited : state.opponentDeposited;
    if (deposited) {
      await this.persistDepositOutcome(intent, signature, { signature, status: 'confirmed' });
      return { status: 'confirmed' };
    }
    await this.rememberIntent(intent.id, {
      createsEscrow: false,
      serializedTx: '',
    });
    await this.chainStore!.setIntentStatus(intent.id, 'pending', {
      signature,
      error: 'Escrow already exists. Request a deposit-only transaction.',
    });
    return {
      status: 'pending',
      error: 'Escrow already exists. Request a deposit-only transaction.',
    };
  }

  private ensureDepositWatcher(
    intent: ChainIntentRow,
    signature: string,
    signedBytes?: Uint8Array,
  ): void {
    if (this.depositWatchers.has(intent.id) || !intent.playerId) return;
    const serialized = intent.metadata.serializedTx;
    if (typeof serialized !== 'string' || !serialized) return;
    const expiry = Number(intent.metadata.lastValidBlockHeight);
    const job = (async () => {
      const outcome = await this.client!.pollIssuedSignature({
        signature,
        serializedTx: Buffer.from(serialized, 'base64'),
        expectedSigner: new PublicKey(intent.playerId!),
        ...(signedBytes ? { signedSerializedTx: signedBytes } : {}),
        ...(Number.isFinite(expiry) ? { lastValidBlockHeight: expiry } : {}),
        pollDelayMs: this.depositPollDelayMs(),
      });
      const current = await this.chainStore!.getIntent(intent.id) ?? intent;
      await this.persistDepositOutcome(current, signature, outcome);
      if (outcome.status === 'confirmed') {
        await this.solDepositResolved?.(current, { status: outcome.status, signature });
      }
      return { status: outcome.status };
    })().finally(() => {
      this.depositWatchers.delete(intent.id);
    });
    this.depositWatchers.set(intent.id, job);
  }

  /** Test hook. Resolves when the background deposit watch for this intent finishes. */
  waitForDepositWatch(intentId: string): Promise<{ status: string }> | undefined {
    return this.depositWatchers.get(intentId);
  }

  private depositPollDelayMs(): number {
    const raw = Number(this.env.POKEARENA_DEPOSIT_POLL_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : 400;
  }

  private async persistDepositOutcome(
    intent: ChainIntentRow,
    signature: string,
    outcome: { status: string; slot?: number; error?: string; signature?: string },
  ): Promise<void> {
    if (!this.chainStore) return;
    await this.rememberIntent(intent.id, {
      signature,
      ...(outcome.error ? { lastError: outcome.error } : {}),
    });
    if (intent.status === outcome.status) return;
    await this.chainStore.setIntentStatus(intent.id, outcome.status as ChainIntentRow['status'], {
      signature,
      slot: outcome.slot,
      error: outcome.error,
    });
  }

  private async assertRecordedSettlementAgrees(roomId: string, isTie: boolean): Promise<void> {
    if (!this.chainStore) return;
    if (!isTie) {
      const tie = await this.chainStore.getIntentByScope('sol_match_tie', roomId);
      if (tie?.status === 'confirmed') throw new Error('Match was already settled as a tie.');
      return;
    }
    const win = await this.chainStore.getIntentByScope('sol_match_win', roomId);
    if (win?.status === 'confirmed') throw new Error('Match was already settled as a win.');
  }

  private async markSettlementRetryable(
    intentId: string,
    error: string,
    signature?: string,
  ): Promise<void> {
    if (!this.chainStore) return;
    await this.chainStore.setIntentStatus(intentId, 'pending', {
      ...(signature ? { signature } : {}),
      error,
    });
    await this.rememberIntent(intentId, {
      settlementPhase: 'retryable',
      lastError: error,
      ...(signature ? { signature } : {}),
    });
  }

  private async rememberIntent(id: string, patch: Record<string, unknown>): Promise<void> {
    const store = this.chainStore as (PostgresChainStore & {
      mergeIntentMetadata?: (intentId: string, value: Record<string, unknown>) => Promise<unknown>;
    }) | null;
    if (!store || typeof store.mergeIntentMetadata !== 'function') return;
    await store.mergeIntentMetadata(id, patch);
  }

  private expectedVerification(intent: ChainIntentRow): IntentVerification | undefined {
    const expected = intent.metadata.expected as Record<string, unknown> | undefined;
    if (
      !expected
      || !intent.playerId
      || (intent.kind !== 'sol_wager_deposit' && intent.kind !== 'poke_entry_deposit')
    ) return undefined;
    const signer = new PublicKey(String(expected.signer));
    const accounts = intent.kind === 'sol_wager_deposit'
      ? [
          signer,
          matchEscrowAddress(this.config.programId, intent.roomId!),
          matchVaultAddress(this.config.programId, intent.roomId!),
          SystemProgram.programId,
        ]
      : [
          signer,
          this.client!.configAddress,
          this.config.pokeMint,
          new PublicKey(String(intent.metadata.playerPokeAta)),
          entryEscrowAddress(this.config.programId, intent.tournamentId!, signer),
          entryVaultAddress(this.config.programId, intent.tournamentId!, signer),
        ];
    return {
      expectedSigner: signer,
      expectedProgram: this.config.programId,
      discriminator: Buffer.from(String(expected.discriminator), 'hex'),
      accounts,
      kind: intent.kind,
      ...(intent.roomId ? { roomId: uuidToBytes(intent.roomId) } : {}),
      ...(intent.tournamentId ? { tournamentId: uuidToBytes(intent.tournamentId) } : {}),
      ...(intent.metadata.side !== undefined ? { side: Number(intent.metadata.side) as 0 | 1 } : {}),
      amount: BigInt(intent.amount),
      ...(intent.metadata.expected && typeof intent.metadata.expected === 'object'
        && 'quoteId' in (intent.metadata.expected as Record<string, unknown>)
        ? { quoteId: Buffer.from(String((intent.metadata.expected as Record<string, unknown>).quoteId), 'hex') }
        : {}),
    };
  }
}

function transactionCreatesEscrow(bytes: Uint8Array, programId: PublicKey): boolean {
  try {
    const tx = Transaction.from(bytes);
    return tx.instructions.some(instruction => (
      instruction.programId.equals(programId)
      && Buffer.from(instruction.data).subarray(0, 8).equals(IX.createMatchEscrow)
    ));
  } catch {
    return false;
  }
}

function usableSettlementIntent(status: string): boolean {
  return status === 'created'
    || status === 'pending'
    || status === 'confirmed'
    || status === 'failed'
    || status === 'expired';
}

async function releaseSolRoomRecord(economics: EconomicsStore, room: DurableCasualRoom): Promise<void> {
  if (room.status === 'starting' || room.status === 'battling') {
    await economics.abortCasualRoom(room.id);
    return;
  }
  await economics.cancelCasualRoom(room.id);
}

function matchEscrowAddress(programId: PublicKey, roomId: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('match_escrow'), uuidToBytes(roomId)],
    programId,
  )[0];
}

function matchVaultAddress(programId: PublicKey, roomId: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('match_vault'), uuidToBytes(roomId)],
    programId,
  )[0];
}

function entryEscrowAddress(programId: PublicKey, tournamentId: string, player: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('entry_escrow'), uuidToBytes(tournamentId), player.toBuffer()],
    programId,
  )[0];
}

function entryVaultAddress(programId: PublicKey, tournamentId: string, player: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('entry_vault'), uuidToBytes(tournamentId), player.toBuffer()],
    programId,
  )[0];
}
