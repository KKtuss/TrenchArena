import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
  ArenaChainClient,
  assertPassportEligible,
  burnPokeEntryIx,
  createAssociatedTokenAccountIdempotentIx,
  chargeMatchFeeIx,
  createMatchEscrowIx,
  depositPokeEntryIx,
  depositSolWagerIx,
  payCardsPrizeIx,
  refundPokeEntryIx,
  refundSolWagerIx,
  fundCardsPrizeIx,
  seatMatchOpponentIx,
  setCardsPrizeWinnerIx,
  settleMatchTieIx,
  settleMatchWinIx,
  releaseCardsPrizeIx,
  type SentTransaction,
  evaluatePassport,
  loadChainConfig,
  previewSolCasual,
  previewTreasurySplit,
  sha256Key,
  IX,
  isRetryableRpcError,
  type ArenaChainConfig,
  type IntentVerification,
  type MatchEscrowState,
  type PassportStatus,
  type PokeUsdQuote,
  type SolCasualPreview,
  TOURNAMENT_BURN_FEE_ATOMS,
  POKE_MINT_DECIMALS,
  assertTournamentBurnFeeAtoms,
  uuidToBytes,
} from '@pokearena/solana-client';
import type { ChainIntentRow, DurableCasualRoom, EconomicsStore, PostgresChainStore } from '@pokearena/db';
import { encodeBase58 } from './wallet-auth';
import { AsyncLimiter } from './async-limit';
import { settleCardsPlace, splitCardsPrize } from './tournament-cards-payout';
import { decimalToScaled } from './play-token-math';
import {
  DEFAULT_MIN_LIQUIDITY_USD,
  JupiterTokenPriceOracle,
  readNonNegativeInt,
  resolveJupiterPriceEndpoint,
  type TokenPriceOracle,
} from './play-token-oracle';

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

/** Independent tx.confirm verifications. Not a single global queue. */
export const INTENT_VERIFICATION_CONCURRENCY = 3;

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

/**
 * The settlement transaction may have landed, but the RPC could not say so.
 * This is not a failed settlement and must not be retried with a new transaction.
 */
export class SettlementUnknownError extends Error {
  readonly retryInMs = 8_000;

  constructor(message: string) {
    super(message);
    this.name = 'SettlementUnknownError';
  }
}

export function assertStagingFundingSmokeAccess(
  env: NodeJS.ProcessEnv,
  token: string,
): void {
  if (
    env.POKEARENA_ENV === 'production'
    || env.POKEARENA_STAGING !== 'true'
  ) {
    throw new Error('Tournament funding smoke harness is staging-only.');
  }
  const expected = env.POKEARENA_STAGING_SMOKE_TOKEN?.trim();
  if (!expected || !token) throw new Error('Tournament funding smoke authorization is required.');
  const actualBytes = Buffer.from(token);
  const expectedBytes = Buffer.from(expected);
  if (
    actualBytes.length !== expectedBytes.length
    || !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    throw new Error('Tournament funding smoke authorization failed.');
  }
}

export class ChainEconomyService {
  readonly config: ArenaChainConfig;
  readonly client: ArenaChainClient | null;
  private readonly chainStore: PostgresChainStore | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly injectedKeeper?: Keypair;
  private creatorRewardFunder?: {
    fundTournament(input: { tournamentId: string; amountRaw: number }): Promise<{ signature: string }>;
  };
  private readonly submitKeeperOverride?: (
    instructions: TransactionInstruction[],
  ) => Promise<SentTransaction>;
  private readonly injectedPriceOracle?: TokenPriceOracle;
  private ownedPriceOracle?: TokenPriceOracle;
  private readonly depositConfirmations = new Map<string, Promise<{ status: string; error?: string }>>();
  private readonly matchOperations = new Map<string, Promise<unknown>>();
  private readonly depositWatchers = new Map<string, Promise<{ status: string }>>();
  private readonly intentVerifications = new Map<string, Promise<{ status: string; error?: string }>>();
  private readonly verificationLimiter = new AsyncLimiter(INTENT_VERIFICATION_CONCURRENCY);
  private solDepositResolved?: (
    intent: ChainIntentRow,
    outcome: { status: string; signature: string },
  ) => void | Promise<void>;

  constructor(options: {
    env?: NodeJS.ProcessEnv;
    chainStore?: PostgresChainStore | null;
    client?: ArenaChainClient | null;
    keeper?: Keypair;
    creatorRewardFunder?: {
      fundTournament(input: { tournamentId: string; amountRaw: number }): Promise<{ signature: string }>;
    };
    submitKeeper?: (
      instructions: TransactionInstruction[],
    ) => Promise<SentTransaction>;
    priceOracle?: TokenPriceOracle;
  } = {}) {
    this.env = options.env ?? process.env;
    this.config = loadChainConfig(this.env);
    this.injectedKeeper = options.keeper;
    this.submitKeeperOverride = options.submitKeeper;
    this.injectedPriceOracle = options.priceOracle;
    if (this.config.chainEconomyEnabled && !this.keeperKeypair().publicKey.equals(this.config.keeper)) {
      throw new Error('POKEARENA_KEEPER_KEYPAIR does not match POKEARENA_KEEPER.');
    }
    this.client = options.client !== undefined
      ? options.client
      : (this.config.chainEconomyEnabled ? new ArenaChainClient(this.config) : null);
    this.chainStore = options.chainStore ?? null;
    this.creatorRewardFunder = options.creatorRewardFunder;
  }

  attachCreatorRewardFunder(funder: {
    fundTournament(input: { tournamentId: string; amountRaw: number }): Promise<{ signature: string }>;
  }): void {
    this.creatorRewardFunder = funder;
  }

  get enabled(): boolean {
    return this.config.chainEconomyEnabled;
  }

  /** SOL wagers can run while this is false. POKE burns stay closed. */
  get pokeConfigured(): boolean {
    return this.enabled && !this.config.pokeMint.equals(PublicKey.default);
  }

  get cardsConfigured(): boolean {
    return this.enabled && !this.config.cardsMint.equals(PublicKey.default);
  }

  tournamentPrizeCardsRaw(): number {
    const raw = Number(this.env.POKEARENA_TOURNAMENT_PRIZE_CARDS_RAW ?? 0);
    if (!Number.isSafeInteger(raw) || raw <= 0) {
      throw new Error('POKEARENA_TOURNAMENT_PRIZE_CARDS_RAW must be a positive raw CARDS amount.');
    }
    return raw;
  }

  async runStagingTournamentFundingSmoke(input: {
    tournamentId: string;
    prizeCardsRaw: number;
    authorization: string;
  }): Promise<{
    tournamentId: string;
    amountRaw: number;
    reserveIntentId: string;
    status: string;
    creatorTransferSignature?: string;
    prizeSignature?: string;
  }> {
    assertStagingFundingSmokeAccess(this.env, input.authorization);
    if (!Number.isSafeInteger(input.prizeCardsRaw) || input.prizeCardsRaw <= 0) {
      throw new Error('Staging tournament funding amount must be a positive raw CARDS amount.');
    }
    await this.reserveTournamentCardsPrize({
      tournamentId: input.tournamentId,
      prizeCardsRaw: input.prizeCardsRaw,
    });
    const intent = await this.chainStore!.getIntentByScope(
      'cards_prize_fund',
      input.tournamentId,
    );
    if (!intent) throw new Error('Staging tournament funding intent was not persisted.');
    return {
      tournamentId: input.tournamentId,
      amountRaw: input.prizeCardsRaw,
      reserveIntentId: intent.id,
      status: intent.status,
      ...(typeof intent.metadata.creatorTransferSignature === 'string'
        ? { creatorTransferSignature: intent.metadata.creatorTransferSignature }
        : {}),
      ...(typeof intent.metadata.prizeSignature === 'string'
        ? { prizeSignature: intent.metadata.prizeSignature }
        : {}),
    };
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

  /**
   * Passport authorization uses the configured POKE mint and a live quote.
   * Local tests keep the mock quote. An operator-set env price cannot authorize.
   */
  async resolvePassportQuote(env: NodeJS.ProcessEnv = this.env): Promise<PokeUsdQuote> {
    this.requirePokeEconomy();
    if (this.config.cluster === 'localnet') return this.resolveQuote(env);
    const price = await this.priceOracle().getUsdPrice(this.config.pokeMint.toBase58());
    if (!price.available || !price.priceUsd) {
      throw new Error(`Live POKE quote is unavailable (${price.reason}).`);
    }
    const micro = decimalToScaled(price.priceUsd, 6);
    if (micro === null || micro <= 0n || micro > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Live POKE quote is not a usable USD price.');
    }
    const observedAt = Date.parse(price.timestamp);
    return {
      priceMicroUsd: Number(micro),
      decimals: POKE_MINT_DECIMALS,
      observedAt: Number.isFinite(observedAt) ? observedAt : Date.now(),
      source: 'oracle',
      confidenceBps: 0,
      quoteId: `oracle:${price.mint}:${price.blockId ?? observedAt}`,
    };
  }

  private priceOracle(): TokenPriceOracle {
    if (this.injectedPriceOracle) return this.injectedPriceOracle;
    if (!this.ownedPriceOracle) {
      const endpoint = resolveJupiterPriceEndpoint(this.env);
      this.ownedPriceOracle = new JupiterTokenPriceOracle({
        endpoint: endpoint.url,
        headers: endpoint.headers,
        minLiquidityUsd: readNonNegativeInt(
          this.env.PLAY_TOKEN_MIN_LIQUIDITY_USD,
          DEFAULT_MIN_LIQUIDITY_USD,
          1_000_000_000_000,
        ),
      });
    }
    return this.ownedPriceOracle;
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
      return client.waitForMatchEscrowState(roomBytes, predicate, {
        commitment: 'confirmed',
        attempts: 8,
        ...options,
      });
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

  async getPassport(
    playerId: string,
    env: NodeJS.ProcessEnv = process.env,
    options?: { liquidAtoms?: bigint },
  ): Promise<PassportStatus> {
    this.requirePokeEconomy();
    const quote = await this.resolvePassportQuote(env);
    await this.persistQuote(quote);
    const owner = new PublicKey(playerId);
    const held = this.chainStore
      ? BigInt(await this.chainStore.sumReservedEntryAtoms(playerId))
      : 0n;
    return this.client!.getPassportStatus({
      owner,
      heldEntryAtoms: held,
      quote,
      ...(options?.liquidAtoms !== undefined ? { liquidAtoms: options.liquidAtoms } : {}),
    });
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
    const existing = this.intentVerifications.get(input.intentId);
    if (existing) return existing;
    let settle: (value: { status: string; error?: string }) => void = () => undefined;
    let fail: (error: unknown) => void = () => undefined;
    const job = new Promise<{ status: string; error?: string }>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    this.intentVerifications.set(input.intentId, job);
    void this.verificationLimiter.run(() => this.loadAndConfirm(input))
      .then(settle, fail)
      .finally(() => {
        if (this.intentVerifications.get(input.intentId) === job) {
          this.intentVerifications.delete(input.intentId);
        }
      });
    return job;
  }

  private async loadAndConfirm(input: {
    intentId: string;
    signature: string;
    signedTransaction?: number[];
  }): Promise<{ status: string; error?: string }> {
    const intent = await this.chainStore!.getIntent(input.intentId);
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
    return this.confirmIntentOnce(intent, input);
  }

  private async confirmIntentOnce(
    intent: ChainIntentRow,
    input: { intentId: string; signature: string; signedTransaction?: number[] },
  ): Promise<{ status: string; error?: string }> {
    const current = await this.chainStore!.getIntent(intent.id) ?? intent;
    if (current.status === 'confirmed') return { status: 'confirmed' };
    if (current.kind === 'sol_wager_deposit') {
      const inflight = this.depositConfirmations.get(current.id);
      if (inflight) return inflight;
      const job = this.confirmSolDeposit(current, input.signature, input.signedTransaction).finally(() => {
        this.depositConfirmations.delete(current.id);
      });
      this.depositConfirmations.set(current.id, job);
      return job;
    }
    const storedSignature = typeof current.metadata.signature === 'string'
      ? current.metadata.signature
      : '';
    const signaturePinned = storedSignature.length > 0
      && current.status !== 'failed'
      && current.status !== 'expired'
      && current.status !== 'cancelled';
    const signature = signaturePinned ? storedSignature : input.signature;
    if (!signaturePinned && signature) {
      await this.rememberIntent(current.id, { signature });
    }
    const expected = this.expectedVerification(current);
    const confirmed = expected
      ? await this.client!.verifyIntentTransaction(signature, expected)
      : await this.client!.confirmSignature(signature);
    if (confirmed.status !== 'confirmed' && isRetryableRpcError(confirmed.error ?? '')) {
      console.warn('[pokearena-rpc]', {
        operation: 'confirmIntent',
        classified: 'retryable',
        intentId: current.id,
        kind: current.kind,
        ...(current.roomId ? { roomId: current.roomId } : {}),
        ...(current.tournamentId ? { tournamentId: current.tournamentId } : {}),
        signature,
        message: confirmed.error,
      });
    }
    await this.chainStore!.setIntentStatus(input.intentId, confirmed.status, {
      signature,
      slot: confirmed.slot,
      error: confirmed.error,
    });
    if (confirmed.status === 'confirmed' && current.kind === 'poke_entry_deposit') {
      await this.chainStore!.markEntryReserved(current.tournamentId!, current.playerId!);
    }
    return { status: confirmed.status, ...(confirmed.error ? { error: confirmed.error } : {}) };
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
    signature?: string;
    entryAtoms: string;
    quote: PokeUsdQuote;
    passport: PassportStatus;
  }> {
    this.requirePokeEconomy();
    if (!this.chainStore) throw new Error('Chain store is required for POKE entries.');
    const scopeId = `${input.tournamentId}:${input.playerId}`;
    const existing = await this.chainStore.getIntentByScope('poke_entry_deposit', scopeId);
    const storedSignature = typeof existing?.metadata.signature === 'string'
      ? existing.metadata.signature
      : '';
    if (
      existing
      && storedSignature
      && existing.status !== 'failed'
      && existing.status !== 'expired'
      && existing.status !== 'cancelled'
    ) {
      const quote = this.resolveQuote();
      await this.persistQuote(quote);
      return {
        intentId: existing.id,
        serializedTx: [],
        signature: storedSignature,
        entryAtoms: existing.amount.toString(),
        quote,
        passport: await this.getPassport(input.playerId),
      };
    }
    const quote = this.resolveQuote();
    await this.persistQuote(quote);
    if (
      input.fixedBurnFee
      && input.entryAtoms !== undefined
      && input.entryAtoms !== TOURNAMENT_BURN_FEE_ATOMS
    ) {
      assertTournamentBurnFeeAtoms(input.entryAtoms);
    }
    if (
      input.entryAtoms !== undefined
      && input.entryAtoms !== TOURNAMENT_BURN_FEE_ATOMS
    ) {
      throw new Error('Tournament entry is exactly 10000 POKE and is separate from the passport check.');
    }
    const entryAtoms = BigInt(TOURNAMENT_BURN_FEE_ATOMS);
    const quoteId = input.quoteId ?? quote.quoteId;
    const owner = new PublicKey(input.playerId);
    const playerPokeAta = input.playerPokeAta
      ? new PublicKey(input.playerPokeAta)
      : await this.client!.getPokeAta(owner);

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
    prizeCardsRaw: number;
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
    await this.reserveTournamentCardsPrize(input);
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

  private async reconcileRecordedPrizeFunding(
    reserve: ChainIntentRow,
    tournamentBytes: Uint8Array,
    amount: number,
    signature: string,
  ): Promise<void> {
    const connection = this.client?.connection;
    if (!connection?.getSignatureStatuses) {
      throw new Error('CARDS prize funding signature is still unconfirmed.');
    }
    const status = await connection.getSignatureStatuses([signature]);
    const value = status.value[0];
    if (value?.err) {
      await this.chainStore!.setIntentStatus(reserve.id, 'failed', {
        signature,
        error: 'CARDS prize funding transaction failed.',
      });
      throw new Error('CARDS prize funding transaction failed.');
    }
    const confirmed = value?.confirmationStatus === 'confirmed' || value?.confirmationStatus === 'finalized';
    if (!confirmed) {
      if (reserve.status !== 'pending') {
        await this.chainStore!.setIntentStatus(reserve.id, 'pending', { signature });
      }
      throw new Error('CARDS prize funding signature is still unconfirmed.');
    }
    const state = await this.client!.getCardsPrizeReserveState(tournamentBytes);
    if (state.status !== 0 || state.cardsAmount !== BigInt(amount)) {
      throw new Error('CARDS prize funding signature is still unconfirmed.');
    }
    await this.chainStore!.setIntentStatus(reserve.id, 'confirmed', { signature });
  }

  private async reserveTournamentCardsPrize(input: {
    tournamentId: string;
    prizeCardsRaw: number;
  }): Promise<void> {
    this.requirePokeEconomy();
    if (!this.cardsConfigured) throw new Error('CARDS prize mint is not configured.');
    if (!this.chainStore) throw new Error('Chain store is required for tournament chain actions.');
    const reserve = await this.chainStore.createIntent({
      kind: 'cards_prize_fund',
      scopeId: input.tournamentId,
      asset: 'CARDS',
      amount: input.prizeCardsRaw,
      idempotencyKey: `cards_prize_fund:${input.tournamentId}`,
      tournamentId: input.tournamentId,
    });
    const tournamentBytes = uuidToBytes(input.tournamentId);
    if (reserve.status !== 'confirmed') {
      if (this.creatorRewardFunder && reserve.metadata.creatorTransfer !== 'confirmed') {
        const funded = await this.creatorRewardFunder.fundTournament({
          tournamentId: input.tournamentId,
          amountRaw: input.prizeCardsRaw,
        });
        reserve.metadata = {
          ...reserve.metadata,
          creatorTransfer: 'confirmed',
          creatorTransferSignature: funded.signature,
        };
        await this.rememberIntent(reserve.id, {
          creatorTransfer: 'confirmed',
          creatorTransferSignature: funded.signature,
        });
      }
      const prizeSignature = typeof reserve.metadata.prizeSignature === 'string'
        ? reserve.metadata.prizeSignature
        : '';
      if (prizeSignature) {
        await this.reconcileRecordedPrizeFunding(reserve, tournamentBytes, input.prizeCardsRaw, prizeSignature);
      } else {
        const existingReserve = await this.client!.getCardsPrizeReserveState(tournamentBytes)
          .catch(() => undefined);
        if (
          existingReserve?.status === 0
          && existingReserve.cardsAmount === BigInt(input.prizeCardsRaw)
        ) {
          await this.chainStore.setIntentStatus(reserve.id, 'confirmed');
        } else {
          const fundingKey = sha256Key(['cards-fund', input.tournamentId, String(input.prizeCardsRaw)]);
          const result = await this.submitKeeperTransaction(this.keeperKeypair(), [
            fundCardsPrizeIx({
              programId: this.config.programId,
              fundingAuthority: this.keeperPublicKey(),
              config: this.client!.configAddress,
              cardsMint: this.config.cardsMint,
              fundingCards: this.client!.getCardsAta(this.keeperPublicKey()),
              tournamentId: tournamentBytes,
              amount: input.prizeCardsRaw,
              fundingKey,
            }),
          ]);
          if (result.signature) {
            reserve.metadata = { ...reserve.metadata, prizeSignature: result.signature };
            await this.rememberIntent(reserve.id, { prizeSignature: result.signature });
          }
          if (result.status !== 'confirmed') {
            await this.chainStore.setIntentStatus(reserve.id, result.status, {
              signature: result.signature || undefined,
              slot: result.slot,
              error: result.error,
            });
            throw new Error(`CARDS funding unavailable: ${result.error ?? 'CARDS prize funding failed.'}`);
          }
          const state = await this.client!.getCardsPrizeReserveState(tournamentBytes);
          if (state.status !== 0 || state.cardsAmount !== BigInt(input.prizeCardsRaw)) {
            throw new Error('CARDS prize funding was not reflected on-chain.');
          }
          await this.chainStore.setIntentStatus(reserve.id, 'confirmed', {
            signature: result.signature,
            slot: result.slot,
          });
        }
      }
    }
    await this.chainStore.recordPrizeReserve({
      tournamentId: input.tournamentId,
      amountCardsRaw: input.prizeCardsRaw,
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

  async payTournamentCardsPrize(input: {
    tournamentId: string;
    winnerId: string;
  }): Promise<import('./mock-economics').CardsPayoutResult> {
    this.requirePokeEconomy();
    if (!this.cardsConfigured) throw new Error('CARDS prize mint is not configured.');
    if (!this.chainStore) throw new Error('Chain store is required for tournament chain actions.');
    const intent = await this.chainStore.createIntent({
      kind: 'cards_prize_pay',
      scopeId: input.tournamentId,
      playerId: input.winnerId,
      asset: 'CARDS',
      amount: 0,
      idempotencyKey: `cards_prize_pay:${input.tournamentId}`,
      tournamentId: input.tournamentId,
    });
    const tournamentBytes = uuidToBytes(input.tournamentId);
    const reserve = await this.client!.getCardsPrizeReserveState(tournamentBytes);
    if (reserve.status === 2) {
      throw new Error('Tournament CARDS prize was released and cannot be paid.');
    }
    if (reserve.status === 1 && !reserve.winner.equals(new PublicKey(input.winnerId))) {
      throw new Error('Tournament prize was already paid to a different recipient.');
    }
    if (reserve.status === 1) {
      if (intent.status !== 'confirmed') {
        const signature = typeof intent.metadata.signature === 'string'
          ? intent.metadata.signature
          : undefined;
        await this.chainStore.setIntentStatus(intent.id, 'confirmed', signature ? { signature } : {});
      }
      await this.chainStore.recordPrizeReserve({
        tournamentId: input.tournamentId,
        amountCardsRaw: Number(reserve.cardsAmount),
        status: 'paid',
        settleIntentId: intent.id,
        winnerId: input.winnerId,
      });
    }
    if (reserve.status !== 1) {
      const settlementKey = sha256Key(['cards-prize', input.tournamentId, input.winnerId]);
      const winner = new PublicKey(input.winnerId);
      if (reserve.winnerSet && !reserve.winner.equals(winner)) {
        throw new Error('Tournament prize winner is already authoritatively set to another recipient.');
      }
      const payoutInstructions: TransactionInstruction[] = [
        createAssociatedTokenAccountIdempotentIx({
          payer: this.keeperPublicKey(),
          owner: winner,
          mint: this.config.cardsMint,
        }),
        ...(reserve.winnerSet
          ? []
          : [setCardsPrizeWinnerIx({
              programId: this.config.programId,
              authority: this.keeperPublicKey(),
              config: this.client!.configAddress,
              winner,
              tournamentId: tournamentBytes,
            })]),
        payCardsPrizeIx({
          programId: this.config.programId,
          authority: this.keeperPublicKey(),
          config: this.client!.configAddress,
          cardsMint: this.config.cardsMint,
          winner,
          winnerCards: this.client!.getCardsAta(winner),
          tournamentId: tournamentBytes,
          settlementKey,
        }),
      ];
      const result = await this.submitKeeperTransaction(this.keeperKeypair(), payoutInstructions);
      if (result.signature) {
        // Keep the landed transaction identity durable before the final
        // confirmation/update step. Recovery can then confirm the same
        // settlement without creating a second payout transaction.
        await this.rememberIntent(intent.id, {
          signature: result.signature,
          settlementPhase: 'submitted',
        });
      }
      if (result.status !== 'confirmed') {
        await this.chainStore.setIntentStatus(intent.id, result.status, {
          signature: result.signature || undefined,
          slot: result.slot,
          error: result.error,
        });
        throw new Error(result.error ?? 'Tournament prize payment failed.');
      }
      const paid = await this.client!.getCardsPrizeReserveState(tournamentBytes);
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
        amountCardsRaw: Number(paid.cardsAmount),
        status: 'paid',
        settleIntentId: intent.id,
        winnerId: input.winnerId,
      });
    }
    return {
      symbol: 'CARDS',
      rail: 'cards_chain',
      winnerId: input.winnerId,
      amount: Number(reserve.cardsAmount),
      cardsAmountRaw: Number(reserve.cardsAmount),
      settlementKey: `cards_prize_pay:${input.tournamentId}`,
      settlementKeyHex: sha256Key(['cards-prize', input.tournamentId, input.winnerId]).toString('hex'),
    };
  }

  /**
   * Collect the reserved CARDS vault once to the keeper, then pay 50/35/15.
   * Two-player cups keep payTournamentCardsPrize and never call this.
   */
  async payTournamentCardsPodium(input: {
    tournamentId: string;
    firstId: string;
    secondId: string;
    thirdId: string;
  }): Promise<import('./mock-economics').CardsPayoutResult> {
    this.requirePokeEconomy();
    if (!this.cardsConfigured) throw new Error('CARDS prize mint is not configured.');
    if (!this.chainStore) throw new Error('Chain store is required for tournament chain actions.');
    if (new Set([input.firstId, input.secondId, input.thirdId]).size !== 3) {
      throw new Error('Podium places must be three different players.');
    }
    const store = this.chainStore as PostgresChainStore & {
      withAdvisoryLock?: <T>(key: string, work: () => Promise<T>) => Promise<T>;
    };
    if (typeof store.withAdvisoryLock !== 'function') {
      throw new Error('Tournament podium payout requires a database lock.');
    }
    return store.withAdvisoryLock(`prize_pay:${input.tournamentId}`, () => this.payTournamentCardsPodiumLocked(input));
  }

  private async payTournamentCardsPodiumLocked(input: {
    tournamentId: string;
    firstId: string;
    secondId: string;
    thirdId: string;
  }): Promise<import('./mock-economics').CardsPayoutResult> {
    const keeperId = this.keeperPublicKey().toBase58();
    const collected = await this.payTournamentCardsPrize({
      tournamentId: input.tournamentId,
      winnerId: keeperId,
    });
    const payIntent = await this.chainStore!.getIntentByScope('cards_prize_pay', input.tournamentId);
    const storedPool = metadataUnsigned(payIntent?.metadata, 'cardsPoolRaw');
    const reported = BigInt(collected.cardsAmountRaw);
    const pool = storedPool > 0n ? storedPool : reported;
    if (pool <= 0n) throw new Error('Tournament CARDS prize vault is empty.');
    if (storedPool === 0n && payIntent) {
      await this.rememberIntent(payIntent.id, { cardsPoolRaw: pool.toString() });
    }
    const shares = splitCardsPrize(pool);
    const places = [
      { place: 1 as const, playerId: input.firstId, amount: shares.first },
      { place: 2 as const, playerId: input.secondId, amount: shares.second },
      { place: 3 as const, playerId: input.thirdId, amount: shares.third },
    ];
    for (const place of places) {
      await this.payCardsPlace(input.tournamentId, place.place, place.playerId, place.amount);
    }
    return {
      symbol: 'CARDS',
      rail: 'cards_chain',
      winnerId: input.firstId,
      amount: Number(shares.first),
      cardsAmountRaw: Number(pool),
      settlementKey: `prize_pay:${input.tournamentId}`,
      settlementKeyHex: sha256Key(['cards-prize', input.tournamentId, input.firstId]).toString('hex'),
    };
  }

  private async payCardsPlace(
    tournamentId: string,
    place: 1 | 2 | 3,
    playerId: string,
    amount: bigint,
  ): Promise<void> {
    const chainStore = this.chainStore;
    if (!chainStore) throw new Error('Chain store is required for tournament chain actions.');
    const scopeId = `${tournamentId}:${place}`;
    await settleCardsPlace({
      place,
      playerId,
      amount,
      loadOrCreate: async () => {
        const intent = await chainStore.createIntent({
          kind: 'prize_pay',
          scopeId,
          playerId,
          asset: 'CARDS',
          amount: Number(amount),
          idempotencyKey: `prize_pay:${tournamentId}:${place}`,
          tournamentId,
        });
        return {
          id: intent.id,
          status: intent.status,
          ...(intent.playerId ? { playerId: intent.playerId } : {}),
          amount: intent.amount,
          metadata: intent.metadata,
        };
      },
      remember: (intentId, patch) => this.rememberIntent(intentId, patch),
      setStatus: async (intentId, status, signature) => {
        await chainStore.setIntentStatus(intentId, status, signature ? { signature } : {});
      },
      reload: async intent => {
        const current = await chainStore.getIntentByScope('prize_pay', scopeId);
        return current
          ? {
            id: current.id,
            status: current.status,
            ...(current.playerId ? { playerId: current.playerId } : {}),
            amount: current.amount,
            metadata: current.metadata,
          }
          : intent;
      },
      reconcile: signature => this.cardsSignatureOutcome(signature),
      blockhashExpired: () => this.cardsPlaceBlockhashExpired(scopeId),
      mayStillLand: signature => this.cardsSignatureMayStillLand(signature, scopeId),
      rebroadcast: serializedTx => this.rebroadcastKeeperTransaction(serializedTx),
      submit: async persistSigned => {
        const player = new PublicKey(playerId);
        const keeper = this.keeperPublicKey();
        const result = await this.submitKeeperReplayable([
          createAssociatedTokenAccountIdempotentIx({
            payer: keeper,
            owner: player,
            mint: this.config.cardsMint,
          }),
          cardsTransferIx({
            source: this.client!.getCardsAta(keeper),
            destination: this.client!.getCardsAta(player),
            owner: keeper,
            amount,
          }),
        ], persistSigned);
        if (result.status === 'confirmed' || result.status === 'failed' || result.status === 'pending' || result.status === 'expired') {
          return {
            status: result.status,
            ...(result.signature ? { signature: result.signature } : {}),
            ...(result.error ? { error: result.error } : {}),
          };
        }
        return { status: 'failed', ...(result.error ? { error: result.error } : {}) };
      },
    });
  }

  private async cardsSignatureOutcome(signature: string): Promise<'confirmed' | 'failed' | 'unknown'> {
    const connection = this.client?.connection;
    if (!connection?.getSignatureStatuses) return 'unknown';
    try {
      const status = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const value = status.value[0];
      if (!value) return 'unknown';
      if (value.err) return 'failed';
      if (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized') return 'confirmed';
      return 'unknown';
    } catch (error) {
      if (isRetryableRpcError(error)) return 'unknown';
      throw error;
    }
  }

  async releaseTournamentCardsPrize(tournamentId: string): Promise<void> {
    this.requirePokeEconomy();
    if (!this.cardsConfigured) throw new Error('CARDS prize mint is not configured.');
    if (!this.chainStore) throw new Error('Chain store is required for tournament chain actions.');
    const intent = await this.chainStore.createIntent({
      kind: 'cards_prize_release',
      scopeId: tournamentId,
      asset: 'CARDS',
      amount: 0,
      idempotencyKey: `cards_prize_release:${tournamentId}`,
      tournamentId,
    });
    if (intent.status === 'confirmed') return;
    const tournamentBytes = uuidToBytes(tournamentId);
    const reserve = await this.client!.getCardsPrizeReserveState(tournamentBytes);
    if (reserve.status === 2) {
      await this.chainStore.setIntentStatus(intent.id, 'confirmed');
      return;
    }
    if (reserve.status !== 0 || reserve.winnerSet) {
      throw new Error('CARDS prize is not releasable after winner assignment or payout.');
    }
    const result = await this.submitKeeperTransaction(this.keeperKeypair(), [
      releaseCardsPrizeIx({
        programId: this.config.programId,
        authority: this.keeperPublicKey(),
        config: this.client!.configAddress,
        cardsMint: this.config.cardsMint,
        funderCards: this.client!.getCardsAta(reserve.funder),
        tournamentId: tournamentBytes,
      }),
    ]);
    if (result.status !== 'confirmed') {
      await this.chainStore.setIntentStatus(intent.id, result.status, {
        signature: result.signature || undefined,
        slot: result.slot,
        error: result.error,
      });
      throw new Error(result.error ?? 'CARDS prize release failed.');
    }
    await this.chainStore.setIntentStatus(intent.id, 'confirmed', {
      signature: result.signature,
      slot: result.slot,
    });
    await this.chainStore.recordPrizeReserve({
      tournamentId,
      amountCardsRaw: Number(reserve.cardsAmount),
      status: 'released',
      settleIntentId: intent.id,
    });
  }

  /**
   * Same-process callers wait here. A store that implements `withMatchOperation`
   * also locks across API processes. The lock is held for the whole operation,
   * including the escrow read and the send.
   */
  private async withMatchOperation<T>(
    operation: string,
    roomId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const key = `${operation}:${roomId}`;
    const previous = this.matchOperations.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const queued = previous.then(() => gate, () => gate);
    this.matchOperations.set(key, queued);
    await previous.catch(() => undefined);
    try {
      const store = this.chainStore as (PostgresChainStore & {
        withMatchOperation?: <R>(op: string, id: string, work: () => Promise<R>) => Promise<R>;
      }) | null;
      if (store && typeof store.withMatchOperation === 'function') {
        return await store.withMatchOperation(operation, roomId, run);
      }
      return await run();
    } finally {
      release();
      if (this.matchOperations.get(key) === queued) this.matchOperations.delete(key);
    }
  }

  /**
   * Persist the signature, then broadcast that exact signed transaction.
   * The test override persists the signature it returns before the caller
   * interprets success or failure, still inside the operation lock.
   */
  private async submitKeeperReplayable(
    instructions: Parameters<ArenaChainClient['buildTransaction']>[1],
    persistSigned: (signed: {
      signature: string;
      serializedTx: string;
      lastValidBlockHeight?: number;
    }) => Promise<void>,
  ): Promise<SentTransaction> {
    this.requireEnabled();
    const authority = this.keeperKeypair();
    if (this.submitKeeperOverride) {
      const result = await this.submitKeeperOverride(instructions);
      if (!result.signature) return result;
      const serializedTx = typeof (result as { serializedTx?: string }).serializedTx === 'string'
        ? (result as { serializedTx?: string }).serializedTx!
        : '';
      if (!serializedTx) throw new Error('Keeper override returned a signature without signed bytes.');
      const lastValidBlockHeight = (result as { lastValidBlockHeight?: number }).lastValidBlockHeight;
      await persistSigned({
        signature: result.signature,
        serializedTx,
        ...(Number.isFinite(lastValidBlockHeight) ? { lastValidBlockHeight } : {}),
      });
      return result;
    }
    const tx = await this.client!.buildTransaction(authority.publicKey, instructions);
    tx.sign(authority);
    const raw = tx.signature;
    if (!raw) throw new Error('Keeper transaction was not signed.');
    const signature = encodeBase58(raw);
    const serializedTx = Buffer.from(tx.serialize()).toString('base64');
    const lastValidBlockHeight = tx.lastValidBlockHeight;
    await persistSigned({
      signature,
      serializedTx,
      ...(Number.isFinite(lastValidBlockHeight) ? { lastValidBlockHeight } : {}),
    });
    try {
      await this.client!.connection.sendRawTransaction(Buffer.from(serializedTx, 'base64'), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/blockhash not found|block height exceeded|transaction expired/i.test(message)) {
        return { signature, status: 'expired', error: message };
      }
      if (!/already processed|already confirmed|duplicate/i.test(message)) {
        return { signature, status: 'pending', error: message };
      }
    }
    try {
      const confirmation = await this.client!.connection.confirmTransaction({
        signature,
        blockhash: tx.recentBlockhash!,
        lastValidBlockHeight: tx.lastValidBlockHeight!,
      }, 'confirmed');
      if (confirmation.value.err) {
        return { signature, status: 'failed', error: JSON.stringify(confirmation.value.err) };
      }
      return { signature, status: 'confirmed' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/block height exceeded|blockhash/i.test(message)) {
        return { signature, status: 'expired', error: message };
      }
      return { signature, status: 'pending', error: message };
    }
  }

  private async rebroadcastKeeperTransaction(serializedTx: string): Promise<'submitted' | 'expired' | 'failed'> {
    try {
      await this.client!.connection.sendRawTransaction(Buffer.from(serializedTx, 'base64'), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      return 'submitted';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/blockhash not found|block height exceeded|transaction expired/i.test(message)) return 'expired';
      return 'submitted';
    }
  }

  private async cardsPlaceBlockhashExpired(scopeId: string): Promise<boolean> {
    const current = await this.chainStore?.getIntentByScope('prize_pay', scopeId);
    const height = Number(current?.metadata?.lastValidBlockHeight);
    if (!Number.isFinite(height) || height <= 0) return false;
    try {
      const now = await this.client!.connection.getBlockHeight('confirmed');
      return now > height;
    } catch {
      return false;
    }
  }

  private async cardsSignatureMayStillLand(signature: string, scopeId: string): Promise<boolean> {
    const current = await this.chainStore?.getIntentByScope('prize_pay', scopeId);
    const signedAt = Date.parse(String(current?.metadata?.signedAt ?? ''));
    if (Number.isFinite(signedAt) && Date.now() - signedAt < 120_000) return true;
    const connection = this.client?.connection;
    if (!connection) return true;
    try {
      const status = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      if (status.value?.[0]) return true;
      const found = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (found) return true;
      const recent = await connection.getSignaturesForAddress(this.keeperPublicKey(), { limit: 100 });
      if (recent.some(entry => entry.signature === signature)) return true;
      return false;
    } catch {
      return true;
    }
  }

  private async submitKeeperOnce(
    instructions: Parameters<ArenaChainClient['buildTransaction']>[1],
    persistSignature: (signature: string) => Promise<void>,
  ): Promise<SentTransaction> {
    this.requireEnabled();
    const authority = this.keeperKeypair();
    if (this.submitKeeperOverride) {
      const result = await this.submitKeeperOverride(instructions);
      if (result.signature) await persistSignature(result.signature);
      return result;
    }
    const tx = await this.client!.buildTransaction(authority.publicKey, instructions);
    tx.sign(authority);
    const raw = tx.signature;
    if (!raw) throw new Error('Keeper transaction was not signed.');
    const signature = encodeBase58(raw);
    await persistSignature(signature);
    const sender = this.client as ArenaChainClient & {
      sendSignedAndConfirm?: (transaction: Transaction) => Promise<SentTransaction>;
    };
    if (typeof sender.sendSignedAndConfirm === 'function') {
      return sender.sendSignedAndConfirm(tx);
    }
    return this.client!.sendAndConfirm(tx, [authority]);
  }

  private async recordChainProgress(
    intentId: string,
    signature: string,
    status: 'pending' | 'failed' | 'confirmed',
    error?: string,
  ): Promise<void> {
    const store = this.chainStore as (PostgresChainStore & {
      appendChainTx?: (input: {
        intentId: string;
        signature: string;
        status: 'pending' | 'failed' | 'confirmed';
        error?: string;
      }) => Promise<void>;
    }) | null;
    if (!store || typeof store.appendChainTx !== 'function') return;
    await store.appendChainTx({ intentId, signature, status, ...(error ? { error } : {}) });
  }

  private async recordNonCanonicalAttempt(
    intentId: string,
    signature: string | undefined,
    error?: string,
  ): Promise<void> {
    if (!signature) return;
    await this.recordChainProgress(intentId, signature, 'failed', error);
  }

  private async reloadIntent(intent: ChainIntentRow): Promise<ChainIntentRow> {
    const store = this.chainStore as (PostgresChainStore & {
      getIntent?: (id: string) => Promise<ChainIntentRow | undefined>;
    }) | null;
    if (!store || typeof store.getIntent !== 'function') return intent;
    return await store.getIntent(intent.id) ?? intent;
  }

  private async successfulAccountSignature(roomId: string): Promise<string> {
    return this.signatureForSettledEscrow(roomId, '');
  }

  private async markFeeConfirmed(intent: ChainIntentRow, signature: string): Promise<void> {
    if (!this.chainStore) return;
    const existing = metadataString(intent.metadata, 'signature');
    if (intent.status === 'confirmed' && existing && signature && existing !== signature) return;
    if (intent.status !== 'confirmed') {
      await this.chainStore.setIntentStatus(intent.id, 'confirmed', {
        ...(signature ? { signature } : {}),
      });
      intent.status = 'confirmed';
    }
    await this.rememberIntent(intent.id, {
      feePhase: 'confirmed',
      ...(signature ? { signature } : {}),
    });
    if (signature) intent.metadata = { ...intent.metadata, signature, feePhase: 'confirmed' };
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
      await this.markSettlementConfirmed(win);
      await economics.completeCasualWin({
        roomId: room.id,
        winnerId: win!.playerId!,
        loserId,
        collateral: room.collateral,
        reason: 'casual-win',
      });
      return;
    }
    if (tie && tie.status !== 'confirmed' && tie.status !== 'cancelled') {
      await this.markSettlementConfirmed(tie);
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
    return this.withMatchOperation('sol_match_fee', roomId, () => this.prepareCasualStartLocked(roomId));
  }

  private async prepareCasualStartLocked(roomId: string): Promise<void> {
    this.requireEnabled();
    if (!this.chainStore) throw new Error('Chain store is required for SOL wagers.');
    const creator = await this.chainStore.getIntentByScope('sol_wager_deposit', `${roomId}:creator`);
    const opponent = await this.chainStore.getIntentByScope('sol_wager_deposit', `${roomId}:opponent`);
    if (creator?.status !== 'confirmed' || opponent?.status !== 'confirmed') {
      throw new Error('Both SOL deposits must be confirmed before the match starts.');
    }
    const feeAmount = Math.floor((creator.amount * 2 * 200) / 10_000);
    const created = await this.chainStore.createIntent({
      kind: 'sol_match_fee',
      scopeId: roomId,
      asset: 'SOL',
      amount: feeAmount,
      idempotencyKey: `sol_match_fee:${roomId}`,
      roomId,
    });
    const feeIntent = await this.reloadIntent(created);
    if (feeIntent.status === 'confirmed') return;
    const storedSignature = metadataString(feeIntent.metadata, 'signature');
    const phase = metadataString(feeIntent.metadata, 'feePhase');
    if (storedSignature) {
      const outcome = await this.signatureOutcome(storedSignature, roomId, feeIntent.id);
      if (outcome === 'unknown' || outcome === 'pending') {
        throw new SettlementUnknownError('Fee signature is not confirmed yet.');
      }
      if (outcome === 'confirmed') {
        await this.markFeeConfirmed(feeIntent, storedSignature);
        return;
      }
      await this.recordNonCanonicalAttempt(feeIntent.id, storedSignature, 'Fee signature failed on-chain.');
    } else if (phase === 'submitting' || phase === 'submitted') {
      const roomBytes = uuidToBytes(roomId);
      const inflight = await this.readEscrow(roomBytes).catch(() => undefined);
      if (inflight?.status === 3 && inflight.feeCharged) {
        await this.markFeeConfirmed(feeIntent, await this.successfulAccountSignature(roomId));
        return;
      }
      throw new SettlementUnknownError('Fee submission is in flight.');
    }
    const roomBytes = uuidToBytes(roomId);
    const state = await this.client!.getMatchEscrowState(roomBytes);
    if (state.status === 3 && state.feeCharged) {
      const paying = storedSignature && await this.signatureOutcome(storedSignature, roomId, feeIntent.id) === 'confirmed'
        ? storedSignature
        : await this.successfulAccountSignature(roomId);
      await this.markFeeConfirmed(feeIntent, paying);
      return;
    }
    if (state.status !== 2 || !state.creatorDeposited || !state.opponentDeposited) {
      throw new Error('On-chain match escrow is not funded.');
    }
    const latest = await this.reloadIntent(feeIntent);
    if (latest.status === 'confirmed' || metadataString(latest.metadata, 'feePhase') === 'submitting') {
      if (latest.status === 'confirmed') return;
      throw new SettlementUnknownError('Fee submission is in flight.');
    }
    await this.rememberIntent(feeIntent.id, { feePhase: 'submitting', submittedAt: Date.now() });
    const result = await this.submitKeeperOnce(
      [this.buildChargeMatchFeeIx(roomId)],
      async signature => {
        await this.rememberIntent(feeIntent.id, { signature, feePhase: 'submitted' });
        await this.recordChainProgress(feeIntent.id, signature, 'pending');
      },
    );
    if (submissionOutcomeUnknown(result)) {
      await this.chainStore.setIntentStatus(feeIntent.id, 'pending', {
        ...(result.signature ? { signature: result.signature } : {}),
        error: result.error,
      });
      throw new SettlementUnknownError(result.error ?? 'Fee outcome is unknown.');
    }
    if (result.status !== 'confirmed') {
      await this.recordNonCanonicalAttempt(feeIntent.id, result.signature, result.error);
      const landed = await this.readEscrow(roomBytes).catch(error => {
        if (isRetryableRpcError(error)) return undefined;
        throw error;
      });
      if (landed?.status === 3 && landed.feeCharged) {
        const paying = await this.successfulAccountSignature(roomId);
        if (paying && paying !== result.signature) await this.markFeeConfirmed(feeIntent, paying);
        return;
      }
      if (!landed && isRetryableRpcError(result.error ?? '')) {
        throw new SettlementUnknownError(result.error ?? 'Fee outcome is unknown.');
      }
      await this.chainStore.setIntentStatus(feeIntent.id, 'failed', {
        signature: result.signature || undefined,
        error: result.error,
      });
      await this.rememberIntent(feeIntent.id, { feePhase: 'failed', lastError: result.error ?? 'SOL match fee transaction failed.' });
      throw new Error(result.error ?? 'SOL match fee transaction failed.');
    }
    await this.markFeeConfirmed(feeIntent, result.signature);
    try {
      await this.waitForMatchEscrowState(
        roomBytes,
        after => after.status === 3 && after.feeCharged,
      );
    } catch (error) {
      const after = await this.readEscrow(roomBytes).catch(() => undefined);
      if (!(after?.status === 3 && after.feeCharged)) throw error;
    }
  }

  async settleCasual(input: {
    roomId: string;
    creatorId: string;
    opponentId: string;
    winnerId?: string;
    /** Confirm an already-submitted settlement. Never send another transaction. */
    observeOnly?: boolean;
  }): Promise<import('./mock-economics').ChainPayoutResult> {
    return this.withMatchOperation(
      'sol_match_settlement',
      input.roomId,
      () => this.settleCasualLocked(input),
    );
  }

  private async settleCasualLocked(input: {
    roomId: string;
    creatorId: string;
    opponentId: string;
    winnerId?: string;
    observeOnly?: boolean;
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
    const storedSignature = typeof intent.metadata.signature === 'string' ? intent.metadata.signature : '';
    const phase = String(intent.metadata.settlementPhase ?? '');
    let state = await this.readSettlementEscrow(input.roomId, intent.id, roomBytes, storedSignature, phase);
    let resubmitFailedSignature = false;
    if (state.status !== 4 && phase === 'submitted' && storedSignature) {
      const outcome = await this.signatureOutcome(storedSignature, input.roomId, intent.id);
      if (outcome === 'failed') {
        resubmitFailedSignature = !input.observeOnly;
        await this.markSettlementRetryable(
          intent.id,
          'Settlement signature failed on-chain.',
          storedSignature,
        );
      } else if (outcome === 'confirmed') {
        state = { ...state, status: 4, feeCharged: state.feeCharged || !isTie };
      } else {
        this.logSettlementUnknown({
          roomId: input.roomId,
          intentId: intent.id,
          signature: storedSignature,
          operation: 'readSignatureOutcome',
          message: 'Settlement signature is not confirmed yet.',
        });
        throw new SettlementUnknownError('Settlement signature is not confirmed yet.');
      }
    }
    if (state.status === 4) {
      await this.assertRecordedSettlementAgrees(input.roomId, isTie);
      const signature = await this.signatureForSettledEscrow(input.roomId, storedSignature);
      await this.markSettlementConfirmed(intent, signature);
    } else if (
      input.observeOnly
      || (!resubmitFailedSignature && phase === 'submitted' && storedSignature)
    ) {
      this.logSettlementUnknown({
        roomId: input.roomId,
        intentId: intent.id,
        signature: storedSignature,
        operation: 'observeSettlement',
        message: 'Submitted settlement is not on the escrow yet.',
      });
      throw new SettlementUnknownError('Submitted settlement is not on the escrow yet.');
    } else {
      if (!storedSignature && (phase === 'submitting' || phase === 'submitted')) {
        throw new SettlementUnknownError('Settlement submission is in flight.');
      }
      if (!isTie && state.status === 2 && !state.feeCharged) {
        await this.prepareCasualStart(input.roomId);
        state = await this.readSettlementEscrow(input.roomId, intent.id, roomBytes, storedSignature, phase);
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
        await this.rememberIntent(intent.id, {
          settlementPhase: 'submitting',
          submittedAt: Date.now(),
        });
        let result: SentTransaction;
        try {
          result = await this.submitKeeperOnce([instruction], async signature => {
            await this.rememberIntent(intent.id, { signature, settlementPhase: 'submitted' });
            await this.recordChainProgress(intent.id, signature, 'pending');
          });
        } catch (error) {
          if (isRetryableRpcError(error)) {
            this.logSettlementUnknown({
              roomId: input.roomId,
              intentId: intent.id,
              operation: 'submitSettlement',
              message: error instanceof Error ? error.message : String(error),
            });
            throw new SettlementUnknownError(
              error instanceof Error ? error.message : 'Settlement submission outcome is unknown.',
            );
          }
          throw error;
        }
        if (result.signature) {
          await this.rememberIntent(intent.id, { signature: result.signature });
        }
        if (submissionOutcomeUnknown(result)) {
          if (intent.status !== 'confirmed') {
            await this.chainStore.setIntentStatus(intent.id, 'pending', {
              ...(result.signature ? { signature: result.signature } : {}),
              error: result.error,
            });
          }
          await this.rememberIntent(intent.id, {
            settlementPhase: 'submitted',
            ...(result.signature ? { signature: result.signature } : {}),
            lastError: result.error ?? 'Settlement outcome unknown.',
          });
          const landed = await this.readEscrow(roomBytes).catch(error => {
            if (isRetryableRpcError(error)) return undefined;
            throw error;
          });
          if (landed?.status !== 4) {
            this.logSettlementUnknown({
              roomId: input.roomId,
              intentId: intent.id,
              signature: result.signature,
              operation: 'confirmSettlement',
              message: result.error ?? 'Settlement outcome unknown.',
            });
            throw new SettlementUnknownError(result.error ?? 'Settlement outcome is unknown.');
          }
          state = landed;
          await this.adoptSettledEscrow(intent, result.signature, result.status === 'confirmed', result.error);
        } else if (result.status !== 'confirmed') {
          const landed = await this.readEscrow(roomBytes).catch(error => {
            if (isRetryableRpcError(error)) return undefined;
            throw error;
          });
          if (landed?.status === 4) {
            state = landed;
            await this.adoptSettledEscrow(intent, result.signature, false, result.error);
          } else if (!landed && isRetryableRpcError(result.error ?? '')) {
            throw new SettlementUnknownError(result.error ?? 'Settlement outcome is unknown.');
          } else {
            await this.markSettlementRetryable(
              intent.id,
              result.error ?? 'SOL match settlement failed.',
              result.signature || undefined,
            );
            throw new Error(result.error ?? 'SOL match settlement failed.');
          }
        } else {
          await this.markSettlementConfirmed(intent, result.signature);
        }
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
      const latest = await this.readEscrow(roomBytes).catch(() => undefined);
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
    try {
      await this.waitForMatchEscrowState(
        roomBytes,
        after => after.opponent.equals(opponent),
      );
    } catch (error) {
      const latest = await this.readEscrow(roomBytes).catch(() => undefined);
      if (!latest?.opponent.equals(opponent)) throw error;
    }
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

  buildReservePrizeIx(_input: { tournamentId: string; amountLamports: number }): never {
    throw new Error('SOL tournament prizes are disabled. Tournament prizes are CARDS.');
  }

  buildPayPrizeIx(_input: { tournamentId: string; winner: string }): never {
    throw new Error('SOL tournament prizes are disabled. Tournament prizes are CARDS.');
  }

  /** Fixed 10,000 POKE entry. The passport quote is a separate check. */
  quotedEntryAtoms(env: NodeJS.ProcessEnv = process.env): { atoms: bigint; quote: PokeUsdQuote } {
    this.requirePokeEconomy();
    const quote = this.resolveQuote(env);
    return { atoms: BigInt(TOURNAMENT_BURN_FEE_ATOMS), quote };
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
    })().catch(error => {
      console.error('[pokearena-rpc]', {
        operation: 'depositWatcher',
        intentId: intent.id,
        ...(intent.roomId ? { roomId: intent.roomId } : {}),
        signature,
        classified: isRetryableRpcError(error) ? 'retryable' : 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      return { status: 'pending' as const };
    }).finally(() => {
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

  /**
   * A settlement intent that is not confirmed yet. Reconciliation uses this
   * to avoid another escrow read once the intent has already converged.
   */
  async unconfirmedSettlement(roomId: string): Promise<{ winnerId?: string } | undefined> {
    if (!this.chainStore) return undefined;
    const win = await this.chainStore.getIntentByScope('sol_match_win', roomId);
    const tie = await this.chainStore.getIntentByScope('sol_match_tie', roomId);
    if (win?.status === 'confirmed' || tie?.status === 'confirmed') return undefined;
    const open = (intent?: ChainIntentRow) => Boolean(
      intent && intent.status !== 'confirmed' && intent.status !== 'cancelled',
    );
    if (open(win)) return win?.playerId ? { winnerId: win.playerId } : {};
    if (open(tie)) return {};
    return undefined;
  }

  /** Catches a synchronous throw and a rejected read the same way. */
  private readEscrow(
    roomBytes: Uint8Array,
    commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed',
  ): Promise<MatchEscrowState> {
    return Promise.resolve().then(() => this.client!.getMatchEscrowState(roomBytes, commitment));
  }

  private async readSettlementEscrow(
    roomId: string,
    intentId: string,
    roomBytes: Uint8Array,
    signature: string,
    _phase: string,
  ): Promise<MatchEscrowState> {
    try {
      return await this.client!.getMatchEscrowState(roomBytes, 'confirmed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isRetryableRpcError(error)) {
        this.logSettlementUnknown({
          roomId,
          intentId,
          signature,
          operation: 'getMatchEscrowState',
          message,
        });
        throw new SettlementUnknownError(message);
      }
      throw error;
    }
  }

  private async signatureOutcome(
    signature: string,
    roomId: string,
    intentId: string,
  ): Promise<'confirmed' | 'failed' | 'pending' | 'unknown'> {
    const reader = this.client as (ArenaChainClient & {
      readSignatureOutcome?: (value: string) => Promise<'confirmed' | 'failed' | 'pending'>;
    }) | null;
    if (!reader || typeof reader.readSignatureOutcome !== 'function') return 'unknown';
    try {
      return await reader.readSignatureOutcome(signature);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isRetryableRpcError(error)) {
        this.logSettlementUnknown({
          roomId,
          intentId,
          signature,
          operation: 'readSignatureOutcome',
          message,
        });
        return 'unknown';
      }
      throw error;
    }
  }

  private async signatureForSettledEscrow(roomId: string, stored: string): Promise<string> {
    if (stored) {
      const outcome = await this.signatureOutcome(stored, roomId, '');
      if (outcome !== 'failed') return stored;
    }
    const lookup = this.client as (ArenaChainClient & {
      latestSuccessfulSignature?: (address: PublicKey) => Promise<string | undefined>;
    }) | null;
    if (!lookup || typeof lookup.latestSuccessfulSignature !== 'function') return '';
    try {
      return await lookup.latestSuccessfulSignature(
        matchEscrowAddress(this.config.programId, roomId),
      ) ?? '';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isRetryableRpcError(error)) {
        this.logSettlementUnknown({
          roomId,
          operation: 'latestSuccessfulSignature',
          message,
        });
        return '';
      }
      throw error;
    }
  }

  /**
   * The escrow is already settled. Keep a failed duplicate off the canonical
   * receipt and record the paying signature when one is known.
   */
  private async adoptSettledEscrow(
    intent: ChainIntentRow,
    attempted: string | undefined,
    attemptedConfirmed: boolean,
    error?: string,
  ): Promise<void> {
    const paying = await this.signatureForSettledEscrow(
      intent.roomId ?? '',
      attemptedConfirmed ? attempted ?? '' : '',
    );
    if (attempted && paying && paying !== attempted) {
      await this.recordNonCanonicalAttempt(intent.id, attempted, error);
    } else if (attempted && !attemptedConfirmed) {
      await this.recordNonCanonicalAttempt(intent.id, attempted, error);
    }
    await this.markSettlementConfirmed(intent, paying || (attemptedConfirmed ? attempted : ''));
  }

  private async markSettlementConfirmed(
    intent: ChainIntentRow | undefined,
    signature?: string,
  ): Promise<void> {
    if (!intent || !this.chainStore) return;
    const existing = metadataString(intent.metadata, 'signature');
    if (intent.status === 'confirmed') {
      if (!signature || signature === existing) return;
      const existingOutcome = existing
        ? await this.signatureOutcome(existing, intent.roomId ?? '', intent.id)
        : 'failed';
      if (existing && existingOutcome !== 'failed') return;
      await this.rememberIntent(intent.id, { settlementPhase: 'confirmed', signature });
      await this.chainStore.setIntentStatus(intent.id, 'confirmed', { signature });
      intent.metadata = { ...intent.metadata, signature, settlementPhase: 'confirmed' };
      return;
    }
    let retained = signature || (typeof intent.metadata.signature === 'string' ? intent.metadata.signature : '');
    if (!retained && intent.roomId) {
      retained = await this.signatureForSettledEscrow(intent.roomId, '');
    }
    await this.chainStore.setIntentStatus(intent.id, 'confirmed', {
      ...(retained ? { signature: retained } : {}),
    });
    intent.status = 'confirmed';
    await this.rememberIntent(intent.id, {
      settlementPhase: 'confirmed',
      ...(retained ? { signature: retained } : {}),
    });
  }

  private logSettlementUnknown(detail: {
    roomId: string;
    intentId?: string;
    signature?: string;
    operation: string;
    message: string;
  }): void {
    let escrow = '';
    try {
      escrow = matchEscrowAddress(this.config.programId, detail.roomId).toBase58();
    } catch {
      escrow = '';
    }
    console.info('[pokearena-settlement]', {
      roomId: detail.roomId,
      ...(escrow ? { escrow } : {}),
      ...(detail.intentId ? { intentId: detail.intentId } : {}),
      ...(detail.signature ? { signature: detail.signature } : {}),
      operation: detail.operation,
      classified: 'retryable',
      retryInMs: 8_000,
      message: detail.message,
    });
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

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : '';
}

function metadataUnsigned(metadata: Record<string, unknown> | undefined, key: string): bigint {
  const value = metadata?.[key];
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return 0n;
}

function cardsTransferIx(input: {
  source: PublicKey;
  destination: PublicKey;
  owner: PublicKey;
  amount: bigint;
}): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(input.amount, 1);
  return new TransactionInstruction({
    programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    keys: [
      { pubkey: input.source, isSigner: false, isWritable: true },
      { pubkey: input.destination, isSigner: false, isWritable: true },
      { pubkey: input.owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function submissionOutcomeUnknown(result: SentTransaction): boolean {
  if (result.status === 'pending' || result.status === 'expired') return true;
  return result.status === 'failed' && isRetryableRpcError(result.error ?? '');
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
