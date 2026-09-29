import { readFileSync } from 'node:fs';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
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
  setPrizeWinnerIx,
  settleMatchTieIx,
  settleMatchWinIx,
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
  type PassportStatus,
  type PokeUsdQuote,
  type SolCasualPreview,
  uuidToBytes,
} from '@pokearena/solana-client';
import type { ChainIntentRow, PostgresChainStore } from '@pokearena/db';

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

  constructor(options: {
    env?: NodeJS.ProcessEnv;
    chainStore?: PostgresChainStore | null;
  } = {}) {
    this.config = loadChainConfig(options.env ?? process.env);
    this.client = this.config.chainEconomyEnabled
      ? new ArenaChainClient(this.config)
      : null;
    this.chainStore = options.chainStore ?? null;
  }

  get enabled(): boolean {
    return this.config.chainEconomyEnabled;
  }

  requireEnabled(): void {
    if (!this.enabled || !this.client) throw new ChainEconomyDisabledError();
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

  async getPassport(playerId: string, env: NodeJS.ProcessEnv = process.env): Promise<PassportStatus> {
    this.requireEnabled();
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
    const ixs = input.side === 0 ? [createIx, depositIx] : [depositIx];
    const tx = await this.client!.buildTransaction(player, ixs);
    const serialized = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
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
  }): Promise<{ status: string }> {
    this.requireEnabled();
    if (!this.chainStore) throw new Error('Chain store is required.');
    const intent = await this.chainStore.getIntent(input.intentId);
    if (!intent) throw new Error(`Unknown chain intent: ${input.intentId}`);
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
    playerPokeAta: string;
    team?: string;
    entryAtoms?: number;
    quoteId?: string;
  }): Promise<{
    intentId: string;
    serializedTx: number[];
    entryAtoms: string;
    quote: PokeUsdQuote;
    passport: PassportStatus;
  }> {
    this.requireEnabled();
    if (!this.chainStore) throw new Error('Chain store is required for POKE entries.');
    const quote = this.resolveQuote();
    await this.persistQuote(quote);
    const entryAtoms = input.entryAtoms !== undefined
      ? BigInt(input.entryAtoms)
      : tournamentEntryAtoms(quote);
    const quoteId = input.quoteId ?? quote.quoteId;
    const passportRequired = passportAtoms(quote);
    const owner = new PublicKey(input.playerId);
    const liquid = await this.client!.getPokeBalance(owner);
    const held = BigInt(await this.chainStore.sumReservedEntryAtoms(input.playerId));
    const afterEntry = liquid > entryAtoms ? liquid - entryAtoms : 0n;
    const qualifyingAfter = afterEntry > held ? afterEntry - held : 0n;
    if (qualifyingAfter < passportRequired) {
      throw new Error(
        'Entering this cup would drop your POKE passport below $20. Hold enough POKE for entry plus the passport.',
      );
    }

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
        playerPokeAta: input.playerPokeAta,
        ...(input.team ? { team: input.team } : {}),
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
      playerPoke: new PublicKey(input.playerPokeAta),
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
    this.requireEnabled();
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
        authority: this.config.authority,
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
    this.requireEnabled();
    if (!this.chainStore) throw new Error('Chain store is required for tournament chain actions.');
    for (const playerId of input.playerIds) {
      const deposit = await this.chainStore.getIntentByScope(
        'poke_entry_deposit',
        `${input.tournamentId}:${playerId}`,
      );
      if (deposit?.status !== 'confirmed') {
        throw new Error(`POKE entry deposit is not confirmed for ${playerId}.`);
      }
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
          authority: this.config.authority,
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
        await this.chainStore.recordPrizeReserve({
          tournamentId: input.tournamentId,
          amountLamports: input.prizeLamports,
          status: 'reserved',
          reserveIntentId: reserve.id,
        });
        return;
      }
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
    this.requireEnabled();
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
        authority: this.config.authority,
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
    this.requireEnabled();
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
          authority: this.config.authority,
          config: this.client!.configAddress,
          winner: new PublicKey(input.winnerId),
          tournamentId: tournamentBytes,
        }),
        payPrizeIx({
          programId: this.config.programId,
          authority: this.config.authority,
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

  /** Optional keeper helper when a local authority keypair is supplied via env path. */
  async submitKeeperTransaction(
    authority: Keypair,
    instructions: Parameters<ArenaChainClient['buildTransaction']>[1],
  ) {
    this.requireEnabled();
    const tx = await this.client!.buildTransaction(authority.publicKey, instructions);
    return this.client!.sendAndConfirm(tx, [authority]);
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
    const after = await this.client!.getMatchEscrowState(roomBytes);
    if (after.status !== 3 || !after.feeCharged) {
      throw new Error('SOL match fee was not reflected on-chain.');
    }
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
    const intent = await this.chainStore.createIntent({
      kind,
      scopeId: input.roomId,
      playerId: input.winnerId,
      asset: 'SOL',
      amount: 0,
      idempotencyKey: `${kind}:${input.roomId}`,
      roomId: input.roomId,
    });
    const roomBytes = uuidToBytes(input.roomId);
    const state = await this.client!.getMatchEscrowState(roomBytes);
    if (state.status === 4 && intent.status !== 'confirmed') {
      await this.chainStore.setIntentStatus(intent.id, 'confirmed');
    }
    if (state.status !== 4) {
      const settlementKey = sha256Key([kind, input.roomId]);
      const instruction = isTie
        ? settleMatchTieIx({
            programId: this.config.programId,
            authority: this.config.authority,
            config: this.client!.configAddress,
            creator: new PublicKey(input.creatorId),
            opponent: new PublicKey(input.opponentId),
            roomId: roomBytes,
            settlementKey,
          })
        : settleMatchWinIx({
            programId: this.config.programId,
            authority: this.config.authority,
            config: this.client!.configAddress,
            winner: new PublicKey(input.winnerId!),
            roomId: roomBytes,
            settlementKey,
          });
      const result = await this.submitKeeperTransaction(this.keeperKeypair(), [instruction]);
      if (result.status !== 'confirmed') {
        await this.chainStore.setIntentStatus(intent.id, result.status, {
          signature: result.signature || undefined,
          slot: result.slot,
          error: result.error,
        });
        throw new Error(result.error ?? 'SOL match settlement failed.');
      }
      await this.chainStore.setIntentStatus(intent.id, 'confirmed', {
        signature: result.signature,
        slot: result.slot,
      });
    }
    const after = await this.client!.getMatchEscrowState(roomBytes);
    if (after.status !== 4) throw new Error('SOL match settlement was not reflected on-chain.');
    const gross = after.collateralLamports * 2n;
    const fee = (gross * 200n) / 10_000n;
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

  async refundCasual(roomId: string, creatorId: string, opponentId?: string): Promise<void> {
    this.requireEnabled();
    if (!this.chainStore) throw new Error('Chain store is required for SOL wagers.');
    const roomBytes = uuidToBytes(roomId);
    const state = await this.client!.getMatchEscrowState(roomBytes);
    if (state.status === 4 || state.status === 3) {
      throw new Error('An active or settled match cannot be refunded.');
    }
    const sides: Array<{ side: 0 | 1; playerId: string; deposited: boolean }> = [
      { side: 0, playerId: creatorId, deposited: state.creatorDeposited },
      { side: 1, playerId: opponentId ?? state.opponent.toBase58(), deposited: state.opponentDeposited },
    ];
    for (const side of sides) {
      if (!side.deposited) continue;
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
          authority: this.config.authority,
          recipient: new PublicKey(side.playerId),
          roomId: roomBytes,
          side: side.side,
        }),
      ]);
      if (result.status !== 'confirmed') {
        await this.chainStore.setIntentStatus(intent.id, result.status, {
          signature: result.signature || undefined,
          slot: result.slot,
          error: result.error,
        });
        throw new Error(result.error ?? 'SOL refund failed.');
      }
      await this.chainStore.setIntentStatus(intent.id, 'confirmed', {
        signature: result.signature,
        slot: result.slot,
      });
    }
  }

  buildChargeMatchFeeIx(roomId: string) {
    this.requireEnabled();
    return chargeMatchFeeIx({
      programId: this.config.programId,
      authority: this.config.authority,
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
        authority: this.config.authority,
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
        authority: this.config.authority,
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
      authority: this.config.authority,
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
        authority: this.config.authority,
        config: this.client!.configAddress,
        winner: new PublicKey(input.winner),
        tournamentId: uuidToBytes(input.tournamentId),
        settlementKey,
      }),
    };
  }

  /** Quoted ~$5 POKE entry atoms for the active oracle quote. */
  quotedEntryAtoms(env: NodeJS.ProcessEnv = process.env): { atoms: bigint; quote: PokeUsdQuote } {
    this.requireEnabled();
    const quote = this.resolveQuote(env);
    return { atoms: tournamentEntryAtoms(quote), quote };
  }

  private keeperKeypair(): Keypair {
    const path = process.env.POKEARENA_KEEPER_KEYPAIR ?? process.env.POKEARENA_AUTHORITY_KEYPAIR;
    if (!path) throw new Error('POKEARENA_KEEPER_KEYPAIR is required for chain settlement.');
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
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
