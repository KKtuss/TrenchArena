import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

import {
  Keypair,
  PublicKey,
  Transaction,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';

const {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} = require('@solana/spl-token') as {
  createAssociatedTokenAccountIdempotentInstruction: (...args: any[]) => TransactionInstruction;
  createTransferCheckedInstruction: (...args: any[]) => TransactionInstruction;
  getAssociatedTokenAddressSync: (...args: any[]) => PublicKey;
  NATIVE_MINT: PublicKey;
  TOKEN_PROGRAM_ID: PublicKey;
};
import { OnlinePumpSdk } from '@pump-fun/pump-sdk';
import {
  BPS_DENOM,
  OPERATOR_BPS,
} from '@pokearena/solana-client';
import {
  type CreatorRewardOperation,
  type CreatorRewardsStore,
} from '@pokearena/db';
import { encodeBase58 } from './wallet-auth';

const CARDS_DECIMALS = 6;
const DEFAULT_POLL_MS = 60_000;
const DEFAULT_MIN_CARDS_RAW = 1n;

type PumpBalance = Awaited<ReturnType<OnlinePumpSdk['getCreatorVaultQuoteBalances']>>[number];

export interface CardsRewardSplit {
  gross: bigint;
  tournament: bigint;
  operator: bigint;
}

/** 90% tournament treasury, 10% operator allocation. Remainder stays with the tournament share. */
export function splitCardsCreatorReward(gross: bigint): CardsRewardSplit {
  if (gross < 0n) throw new Error('CARDS reward gross cannot be negative.');
  const operator = (gross * BigInt(OPERATOR_BPS)) / BigInt(BPS_DENOM);
  const tournament = gross - operator;
  return { gross, tournament, operator };
}

export interface CreatorRewardsConfig {
  enabled: boolean;
  creatorRewardsKeypairPath?: string;
  cardsMint?: PublicKey;
  keeper?: PublicKey;
  programId?: PublicKey;
  operatorDestination?: PublicKey;
  operatorClaimToken?: string;
  pollMs: number;
  minCardsRaw: bigint;
}

export interface PumpRewardsClient {
  getCreatorVaultQuoteBalances(
    creator: PublicKey,
  ): Promise<readonly PumpBalance[]>;
  collectCoinCreatorFeeV2Instructions(
    creator: PublicKey,
    quoteMint: PublicKey,
    quoteTokenProgram: PublicKey,
    feePayer?: PublicKey,
  ): Promise<TransactionInstruction[]>;
}

export interface CreatorRewardsWorkerOptions {
  env?: NodeJS.ProcessEnv;
  connection: Connection;
  store: CreatorRewardsStore;
  pumpClient?: PumpRewardsClient;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface CreatorRewardsCheckResult {
  enabled: boolean;
  claimableCardsRaw: bigint;
  sweptCardsRaw: bigint;
  tournamentAvailableRaw: bigint;
  operatorAllocatedRaw: bigint;
  operatorClaimedRaw: bigint;
}

export class CreatorRewardFundingError extends Error {
  readonly code: 'insufficient' | 'unknown' | 'rejected';
  readonly signature?: string;

  constructor(code: 'insufficient' | 'unknown' | 'rejected', message: string, signature?: string) {
    super(message);
    this.name = 'CreatorRewardFundingError';
    this.code = code;
    this.signature = signature;
  }
}

function envFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when creator rewards are enabled.`);
  return value;
}

function parsePublicKey(value: string, name: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${name} must be a valid Solana public key.`);
  }
}

function parsePositiveBigInt(value: string | undefined, name: string, fallback: bigint): bigint {
  if (value === undefined || value.trim() === '') return fallback;
  try {
    const parsed = BigInt(value);
    if (parsed <= 0n) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function parsePollMs(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_POLL_MS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000) {
    throw new Error('POKEARENA_CREATOR_REWARDS_POLL_MS must be an integer >= 1000.');
  }
  return parsed;
}

export function readCreatorRewardsConfig(
  env: NodeJS.ProcessEnv = process.env,
): CreatorRewardsConfig {
  const enabled = envFlag(env.POKEARENA_CREATOR_REWARDS_ENABLED);
  if (!enabled) {
    return {
      enabled: false,
      pollMs: DEFAULT_POLL_MS,
      minCardsRaw: DEFAULT_MIN_CARDS_RAW,
    };
  }
  const programId = parsePublicKey(requiredEnv(env, 'POKEARENA_PROGRAM_ID'), 'POKEARENA_PROGRAM_ID');
  const authority = env.POKEARENA_AUTHORITY?.trim();
  const operatorDestination = env.POKEARENA_CREATOR_REWARDS_OPERATOR?.trim() || authority;
  return {
    enabled: true,
    creatorRewardsKeypairPath: requiredEnv(env, 'POKEARENA_CREATOR_REWARDS_KEYPAIR'),
    cardsMint: parsePublicKey(
      requiredEnv(env, 'POKEARENA_CREATOR_REWARDS_CARDS_MINT'),
      'POKEARENA_CREATOR_REWARDS_CARDS_MINT',
    ),
    keeper: parsePublicKey(
      requiredEnv(env, 'POKEARENA_CREATOR_REWARDS_KEEPER'),
      'POKEARENA_CREATOR_REWARDS_KEEPER',
    ),
    programId,
    ...(operatorDestination
      ? { operatorDestination: parsePublicKey(operatorDestination, 'POKEARENA_CREATOR_REWARDS_OPERATOR') }
      : {}),
    ...(env.POKEARENA_CREATOR_REWARDS_OPERATOR_TOKEN?.trim()
      ? { operatorClaimToken: env.POKEARENA_CREATOR_REWARDS_OPERATOR_TOKEN.trim() }
      : {}),
    pollMs: parsePollMs(env.POKEARENA_CREATOR_REWARDS_POLL_MS),
    minCardsRaw: parsePositiveBigInt(
      env.POKEARENA_CREATOR_REWARDS_MIN_CARDS_RAW,
      'POKEARENA_CREATOR_REWARDS_MIN_CARDS_RAW',
      DEFAULT_MIN_CARDS_RAW,
    ),
  };
}

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(raw) || raw.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new Error('POKEARENA_CREATOR_REWARDS_KEYPAIR must contain a Solana keypair JSON array.');
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function bigintFromUnknown(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (value && typeof (value as { toString?: () => string }).toString === 'function') {
    const text = (value as { toString: () => string }).toString();
    if (/^\d+$/.test(text)) return BigInt(text);
  }
  throw new Error('Pump returned an invalid token amount.');
}

function safeNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('CARDS amount exceeds safe database range.');
  return result;
}

function tokenAccountAmount(value: unknown): bigint {
  const parsed = value as {
    value?: {
      data?: {
        parsed?: { info?: { tokenAmount?: { amount?: string } } };
      };
    };
  };
  const amount = parsed.value?.data?.parsed?.info?.tokenAmount?.amount;
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) {
    throw new Error('Configured CARDS destination is not a parsed classic SPL token account.');
  }
  return BigInt(amount);
}

export class CreatorRewardsWorker {
  readonly config: CreatorRewardsConfig;
  readonly creator: PublicKey | undefined;
  private readonly connection: Connection;
  private readonly store: CreatorRewardsStore;
  private readonly pump: PumpRewardsClient | undefined;
  private readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
  private readonly signer: Keypair | undefined;
  private readonly funding = new Map<string, Promise<{ signature: string }>>();
  private readonly operationJobs = new Map<string, Promise<unknown>>();
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<CreatorRewardsCheckResult> | undefined;

  constructor(options: CreatorRewardsWorkerOptions) {
    const env = options.env ?? process.env;
    this.config = readCreatorRewardsConfig(env);
    this.connection = options.connection;
    this.store = options.store;
    this.logger = options.logger ?? console;
    if (!this.config.enabled) return;
    this.signer = loadKeypair(this.config.creatorRewardsKeypairPath!);
    this.creator = this.signer.publicKey;
    if (this.signer.publicKey.equals(this.config.keeper!)) {
      throw new Error('Creator-rewards signer must be separate from the tournament keeper.');
    }
    const authority = env.POKEARENA_AUTHORITY;
    if (authority && this.signer.publicKey.equals(parsePublicKey(authority, 'POKEARENA_AUTHORITY'))) {
      throw new Error('Creator-rewards signer must be separate from the program authority.');
    }
    if (
      this.config.operatorDestination
      && (
        this.signer.publicKey.equals(this.config.operatorDestination)
        || this.config.keeper?.equals(this.config.operatorDestination)
      )
    ) {
      throw new Error('Creator-rewards operator destination must be separate from creator and keeper.');
    }
    this.pump = options.pumpClient ?? new OnlinePumpSdk(this.connection);
  }

  start(): void {
    if (!this.config.enabled || this.timer) return;
    this.timer = setInterval(() => {
      void this.checkNow('poll').catch(error => this.logError('worker_error', error));
    }, this.config.pollMs);
    this.timer.unref?.();
    void this.checkNow('startup').catch(error => this.logError('startup_error', error));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async checkNow(reason: 'poll' | 'startup' | 'tournament-start' = 'poll'): Promise<CreatorRewardsCheckResult> {
    if (!this.config.enabled) {
      return {
        enabled: false,
        claimableCardsRaw: 0n,
        sweptCardsRaw: 0n,
        tournamentAvailableRaw: 0n,
        operatorAllocatedRaw: 0n,
        operatorClaimedRaw: 0n,
      };
    }
    if (this.running) return this.running;
    this.running = this.runOnce(reason).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runOnce(reason: string): Promise<CreatorRewardsCheckResult> {
    const cardsMint = this.config.cardsMint!;
    await this.assertCardsMint(cardsMint);
    const creatorAta = getAssociatedTokenAddressSync(cardsMint, this.signer!.publicKey);
    const creatorAtaInfo = await this.connection.getParsedAccountInfo(creatorAta, 'confirmed');
    if (creatorAtaInfo.value && !creatorAtaInfo.value.owner.equals(TOKEN_PROGRAM_ID)) {
      throw new Error('Creator CARDS ATA is not owned by the classic SPL Token program.');
    }
    const beforeCreator = creatorAtaInfo.value ? tokenAccountAmount(creatorAtaInfo) : 0n;

    for (const open of await this.store.listOpen()) {
      if (open.kind === 'claim_cards') {
        const resolved = await this.reconcileOpen(open, beforeCreator, cardsMint);
        if (!resolved) return this.ledgerResult(0n);
      } else if (open.kind === 'operator_claim') {
        const reconciled = await this.reconcileOperatorClaim(open);
        if (!open.signature && open.status === 'pending') {
          // A crash can occur after the durable intent is created but before
          // signing. Resume that exact intent; never create a new one.
          await this.claimOperatorShare(this.config.operatorClaimToken ?? '');
        } else if (!reconciled && open.signature) {
          return this.ledgerResult(0n);
        }
      } else if (open.kind === 'fund_tournament' && open.signature) {
        await this.observeFunding(open);
      }
    }

    const balances = await this.pump!.getCreatorVaultQuoteBalances(this.signer!.publicKey);
    const cardsBalance = this.readCardsBalance(balances, cardsMint);
    if (cardsBalance > 0n) {
      this.logInfo('claimable_cards_detected', { reason, amountRaw: cardsBalance.toString() });
    } else {
      this.logInfo('no_claimable_rewards', { reason });
    }

    if (cardsBalance >= this.config.minCardsRaw) {
      await this.claimCards(cardsBalance, creatorAta, beforeCreator, cardsMint);
    }
    return this.ledgerResult(cardsBalance);
  }

  private async ledgerResult(claimableCardsRaw: bigint): Promise<CreatorRewardsCheckResult> {
    const ledger = await this.store.getLedger(this.config.cardsMint!.toBase58());
    const available = ledger
      ? BigInt(ledger.tournamentAllocatedRaw - ledger.tournamentCommittedRaw)
      : 0n;
    return {
      enabled: true,
      claimableCardsRaw,
      sweptCardsRaw: 0n,
      tournamentAvailableRaw: available,
      operatorAllocatedRaw: ledger ? BigInt(ledger.operatorAllocatedRaw) : 0n,
      operatorClaimedRaw: ledger ? BigInt(ledger.operatorClaimedRaw) : 0n,
    };
  }

  private readCardsBalance(balances: readonly PumpBalance[], cardsMint: PublicKey): bigint {
    let cards = 0n;
    for (const balance of balances) {
      const amount = bigintFromUnknown(balance.total);
      if (balance.mint.equals(NATIVE_MINT)) {
        if (amount > 0n) {
          this.logWarn('non_cards_asset_rejected', { asset: 'SOL', amountRaw: amount.toString() });
        }
        continue;
      }
      if (!balance.mint.equals(cardsMint)) {
        if (amount > 0n) {
          this.logWarn('non_cards_asset_rejected', {
            asset: balance.mint.toBase58(),
            amountRaw: amount.toString(),
          });
        }
        continue;
      }
      if (!balance.quoteTokenProgram.equals(TOKEN_PROGRAM_ID)) {
        throw new Error('CARDS creator fees use Token-2022; the CARDS-only worker rejects them.');
      }
      cards += amount;
    }
    return cards;
  }

  private async claimCards(
    claimable: bigint,
    creatorAta: PublicKey,
    beforeCreator: bigint,
    cardsMint: PublicKey,
  ): Promise<bigint | null> {
    const signer = this.signer!;
    const operationKey = `claim-cards:${cardsMint.toBase58()}:${claimable.toString()}:${beforeCreator.toString()}`;
    const existing = await this.store.getByKey(operationKey);
    if (existing?.status === 'confirmed') return 0n;
    const operation = existing ?? await this.store.create({
      operationKey,
      kind: 'claim_cards',
      amountRaw: safeNumber(claimable),
      metadata: {
        cardsMint: cardsMint.toBase58(),
        preCreatorRaw: beforeCreator.toString(),
        expectedClaimRaw: claimable.toString(),
      },
    });
    if (operation.signature) {
      const resolved = await this.reconcileOpen(operation, beforeCreator, cardsMint);
      if (!resolved) return null;
      return claimable;
    }

    try {
      const creatorAtaInfo = await this.connection.getAccountInfo(creatorAta, 'confirmed');
      const instructions: TransactionInstruction[] = [];
      if (!creatorAtaInfo) {
        instructions.push(createAssociatedTokenAccountIdempotentInstruction(
          signer.publicKey,
          creatorAta,
          signer.publicKey,
          cardsMint,
          TOKEN_PROGRAM_ID,
        ));
      }
      // Pump SDK emits the quote-specific bonding-curve
      // `collect_creator_fee_v2` leg and, when present, the graduated
      // Pump AMM `collect_coin_creator_fee` leg. Passing CARDS as the quote
      // is intentional: never use the SDK's all-quotes helper here.
      instructions.push(...await this.pump!.collectCoinCreatorFeeV2Instructions(
        signer.publicKey,
        cardsMint,
        TOKEN_PROGRAM_ID,
        signer.publicKey,
      ));
      const sent = await this.send(instructions, signer);
      await this.store.update(operationKey, { signature: sent.signature });
      this.logInfo('cards_claim_submitted', { signature: sent.signature });
      const status = await this.confirm(sent);
      if (status === 'confirmed') {
        const after = await this.connection.getParsedAccountInfo(creatorAta, 'confirmed');
        const afterAmount = after.value ? tokenAccountAmount(after) : 0n;
        if (afterAmount <= beforeCreator) {
          throw new Error('CARDS claim confirmed without increasing the creator CARDS balance.');
        }
        await this.creditClaim(operationKey, cardsMint, afterAmount - beforeCreator);
        await this.store.update(operationKey, { status: 'confirmed' });
        this.logInfo('cards_claim_confirmed', {
          signature: sent.signature,
          amountRaw: (afterAmount - beforeCreator).toString(),
        });
        return afterAmount - beforeCreator;
      }
      await this.store.update(operationKey, { status: 'unknown' });
      return null;
    } catch (error) {
      await this.store.update(operationKey, { status: 'unknown' }).catch(() => undefined);
      this.logWarn('rpc_unknown_outcome', { operation: operationKey });
      this.logWarn('retry_reconciliation', {
        operation: operationKey,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Explicitly transfers only the unclaimed operator allocation from the
   * creator-reward signer to the configured operator wallet. This is never
   * called by the Pump claim path or by tournament funding.
   */
  async claimOperatorShare(callerToken: string): Promise<{ amountRaw: number; signature?: string }> {
    this.assertOperatorCaller(callerToken);
    if (!this.config.enabled || !this.signer || !this.config.cardsMint) {
      throw new CreatorRewardFundingError('rejected', 'Creator rewards are not enabled.');
    }
    if (!this.config.operatorDestination) {
      throw new CreatorRewardFundingError(
        'rejected',
        'Creator-reward operator destination is not configured.',
      );
    }
    const cardsMint = this.config.cardsMint!;
    const destinationOwner = this.config.operatorDestination;
    return this.withOperation(`operator-claim:${cardsMint.toBase58()}`, async () => {
      await this.assertCardsMint(cardsMint);
      await this.assertOperatorDestination(cardsMint, destinationOwner);
      let operation = await this.store.reserveOperatorClaim({
        cardsMint: cardsMint.toBase58(),
        destination: destinationOwner.toBase58(),
      });
      if (!operation) return { amountRaw: 0 };
      if (operation.status === 'confirmed') {
        return {
          amountRaw: operation.amountRaw,
          ...(operation.signature ? { signature: operation.signature } : {}),
        };
      }
      if (operation.status === 'failed') {
        throw new CreatorRewardFundingError(
          'rejected',
          'Operator claim already failed and was not resent.',
          operation.signature,
        );
      }
      if (operation.signature) {
        const reconciled = await this.reconcileOperatorClaim(operation);
        const current = await this.store.getByKey(operation.operationKey);
        if (reconciled && current?.status === 'confirmed') {
          return {
            amountRaw: current.amountRaw,
            ...(current.signature ? { signature: current.signature } : {}),
          };
        }
        throw new CreatorRewardFundingError(
          'unknown',
          'Operator claim signature is still unconfirmed.',
          operation.signature,
        );
      }

      const source = getAssociatedTokenAddressSync(cardsMint, this.signer!.publicKey);
      const destination = getAssociatedTokenAddressSync(cardsMint, destinationOwner);
      const beforeSource = await this.readTokenBalance(source);
      const beforeDestination = await this.readTokenBalance(destination);
      if (beforeSource < BigInt(operation.amountRaw)) {
        throw new CreatorRewardFundingError(
          'insufficient',
          'Creator wallet does not contain the recorded operator allocation.',
        );
      }
      await this.store.update(operation.operationKey, {
        metadata: {
          preCreatorRaw: beforeSource.toString(),
          preDestinationRaw: beforeDestination.toString(),
          source: source.toBase58(),
          destination: destination.toBase58(),
          cardsMint: cardsMint.toBase58(),
        },
      });

      const instructions: TransactionInstruction[] = [];
      if (!(await this.connection.getAccountInfo(destination, 'confirmed'))) {
        instructions.push(createAssociatedTokenAccountIdempotentInstruction(
          this.signer!.publicKey,
          destination,
          destinationOwner,
          cardsMint,
          TOKEN_PROGRAM_ID,
        ));
      }
      instructions.push(createTransferCheckedInstruction(
        source,
        cardsMint,
        destination,
        this.signer!.publicKey,
        BigInt(operation.amountRaw),
        CARDS_DECIMALS,
        [],
        TOKEN_PROGRAM_ID,
      ));

      const latest = await this.connection.getLatestBlockhash('confirmed');
      const transaction = new Transaction({
        feePayer: this.signer!.publicKey,
        recentBlockhash: latest.blockhash,
      }).add(...instructions);
      transaction.sign(this.signer!);
      if (!transaction.signature) {
        throw new CreatorRewardFundingError('rejected', 'Operator claim transaction was not signed.');
      }
      const signature = encodeBase58(transaction.signature);
      await this.store.update(operation.operationKey, { signature });
      try {
        await this.connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        });
        const confirmation = await this.connection.confirmTransaction({
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        }, 'confirmed');
        if (confirmation.value.err) {
          await this.store.update(operation.operationKey, { status: 'failed' });
          throw new CreatorRewardFundingError(
            'rejected',
            'Operator claim transaction failed.',
            signature,
          );
        }
        const confirmed = await this.store.confirmOperatorClaim(operation.operationKey, signature);
        this.logInfo('operator_claim_confirmed', {
          signature,
          amountRaw: String(confirmed.amountRaw),
        });
        return { amountRaw: confirmed.amountRaw, signature };
      } catch (error) {
        if (error instanceof CreatorRewardFundingError) throw error;
        await this.store.update(operation.operationKey, { status: 'unknown' }).catch(() => undefined);
        this.logWarn('operator_claim_unknown', { operation: operation.operationKey, signature });
        throw new CreatorRewardFundingError(
          'unknown',
          'Operator claim signature is still unconfirmed.',
          signature,
        );
      }
    });
  }

  async fundTournament(input: { tournamentId: string; amountRaw: number }): Promise<{ signature: string }> {
    if (!this.config.enabled || !this.signer) {
      throw new CreatorRewardFundingError('rejected', 'Creator rewards are not enabled.');
    }
    if (!Number.isSafeInteger(input.amountRaw) || input.amountRaw <= 0) {
      throw new CreatorRewardFundingError('rejected', 'Tournament CARDS funding must be a positive raw amount.');
    }
    const operationKey = `fund-tournament:${input.tournamentId}:${input.amountRaw}`;
    const existing = this.funding.get(operationKey);
    if (existing) return existing;
    const job = this.fundTournamentOnce(input, operationKey).finally(() => {
      this.funding.delete(operationKey);
    });
    this.funding.set(operationKey, job);
    return job;
  }

  private async fundTournamentOnce(
    input: { tournamentId: string; amountRaw: number },
    operationKey: string,
  ): Promise<{ signature: string }> {
    const signer = this.signer!;
    const cardsMint = this.config.cardsMint!;
    const keeper = this.config.keeper!;
    await this.assertCardsMint(cardsMint);
    const destination = getAssociatedTokenAddressSync(cardsMint, keeper);
    await this.assertFundingDestination(destination, cardsMint, keeper);
    const source = getAssociatedTokenAddressSync(cardsMint, signer.publicKey);
    let operation = await this.store.getByKey(operationKey);
    if (operation?.signature) {
      const observed = await this.observeFunding(operation);
      operation = await this.store.getByKey(operationKey);
      if (observed === 'confirmed' && operation?.signature) return { signature: operation.signature };
      if (observed === 'failed') {
        throw new CreatorRewardFundingError(
          'rejected',
          'Creator-reward transfer failed and was not resent.',
          operation?.signature,
        );
      }
      throw new CreatorRewardFundingError(
        'unknown',
        'Creator-reward transfer signature is still unconfirmed.',
        operation?.signature,
      );
    }
    if (operation?.status === 'confirmed' && operation.signature) return { signature: operation.signature };
    if (operation?.status === 'failed') {
      throw new CreatorRewardFundingError('rejected', 'Creator-reward transfer already failed and was not resent.');
    }
    if (operation?.status === 'unknown') {
      throw new CreatorRewardFundingError(
        'unknown',
        'Creator-reward transfer signature is still unconfirmed.',
        operation.signature,
      );
    }
    if (!operation) {
      try {
        operation = await this.store.reserveTournamentFunding({
          operationKey,
          cardsMint: cardsMint.toBase58(),
          tournamentId: input.tournamentId,
          amountRaw: input.amountRaw,
          metadata: {
            source: source.toBase58(),
            destination: destination.toBase58(),
            keeper: keeper.toBase58(),
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('Insufficient')) {
          throw new CreatorRewardFundingError('insufficient', message);
        }
        throw error;
      }
    }
    const destinationInfo = await this.connection.getAccountInfo(destination, 'confirmed');
    const instructions: TransactionInstruction[] = [];
    if (!destinationInfo) {
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(
        signer.publicKey,
        destination,
        keeper,
        cardsMint,
        TOKEN_PROGRAM_ID,
      ));
    }
    instructions.push(createTransferCheckedInstruction(
      source,
      cardsMint,
      destination,
      signer.publicKey,
      BigInt(input.amountRaw),
      CARDS_DECIMALS,
      [],
      TOKEN_PROGRAM_ID,
    ));
    try {
      const sent = await this.send(instructions, signer);
      await this.store.update(operationKey, { signature: sent.signature });
      this.logInfo('tournament_funding_submitted', {
        signature: sent.signature,
        amountRaw: String(input.amountRaw),
        tournamentId: input.tournamentId,
      });
      const result = await this.connection.confirmTransaction({
        signature: sent.signature,
        blockhash: sent.blockhash,
        lastValidBlockHeight: sent.lastValidBlockHeight,
      }, 'confirmed');
      if (result.value.err) {
        await this.store.failFunding(operationKey);
        throw new CreatorRewardFundingError(
          'rejected',
          'Creator-reward transfer failed and was not resent.',
          sent.signature,
        );
      }
      await this.store.update(operationKey, { status: 'confirmed' });
      this.logInfo('tournament_funding_confirmed', {
        signature: sent.signature,
        amountRaw: String(input.amountRaw),
      });
      return { signature: sent.signature };
    } catch (error) {
      if (error instanceof CreatorRewardFundingError) throw error;
      await this.store.update(operationKey, { status: 'unknown' }).catch(() => undefined);
      const current = await this.store.getByKey(operationKey);
      throw new CreatorRewardFundingError(
        'unknown',
        'Creator-reward transfer signature is still unconfirmed.',
        current?.signature,
      );
    }
  }

  private assertOperatorCaller(callerToken: string): void {
    const expected = this.config.operatorClaimToken;
    if (!expected || !callerToken) {
      throw new CreatorRewardFundingError('rejected', 'Operator claim authorization is not configured.');
    }
    const actualBytes = Buffer.from(callerToken);
    const expectedBytes = Buffer.from(expected);
    if (
      actualBytes.length !== expectedBytes.length
      || !timingSafeEqual(actualBytes, expectedBytes)
    ) {
      throw new CreatorRewardFundingError('rejected', 'Operator claim caller is not authorized.');
    }
  }

  private async withOperation<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.operationJobs.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const queued = previous.then(() => gate, () => gate);
    this.operationJobs.set(key, queued);
    await previous.catch(() => undefined);
    try {
      const store = this.store as CreatorRewardsStore & {
        withOperation?: <R>(operationKey: string, operation: () => Promise<R>) => Promise<R>;
      };
      if (typeof store.withOperation === 'function') {
        return await store.withOperation(key, run);
      }
      return await run();
    } finally {
      release();
      if (this.operationJobs.get(key) === queued) this.operationJobs.delete(key);
    }
  }

  private async readTokenBalance(address: PublicKey): Promise<bigint> {
    const account = await this.connection.getParsedAccountInfo(address, 'confirmed');
    return account.value ? tokenAccountAmount(account) : 0n;
  }

  private async assertOperatorDestination(cardsMint: PublicKey, owner: PublicKey): Promise<void> {
    if (
      owner.equals(this.signer!.publicKey)
      || owner.equals(this.config.keeper!)
    ) {
      throw new CreatorRewardFundingError(
        'rejected',
        'Operator destination must be separate from creator and keeper.',
      );
    }
    const destination = getAssociatedTokenAddressSync(cardsMint, owner);
    const account = await this.connection.getParsedAccountInfo(destination, 'confirmed');
    if (!account.value) return;
    if (!account.value.owner.equals(TOKEN_PROGRAM_ID)) {
      throw new CreatorRewardFundingError(
        'rejected',
        'Operator destination is not a classic CARDS token account.',
      );
    }
    const data = account.value.data as { parsed?: { info?: { mint?: string; owner?: string } } };
    if (
      data.parsed?.info?.mint !== cardsMint.toBase58()
      || data.parsed?.info?.owner !== owner.toBase58()
    ) {
      throw new CreatorRewardFundingError(
        'rejected',
        'Operator destination does not belong to the configured operator wallet.',
      );
    }
  }

  private async reconcileOperatorClaim(operation: CreatorRewardOperation): Promise<boolean> {
    if (operation.kind !== 'operator_claim' || !operation.signature) return false;
    const status = await this.connection.getSignatureStatuses([operation.signature]);
    const signatureStatus = status.value[0];
    if (signatureStatus?.err) {
      await this.store.update(operation.operationKey, { status: 'failed' });
      return false;
    }
    const cardsMint = new PublicKey(String(operation.metadata.cardsMint ?? this.config.cardsMint));
    const source = new PublicKey(String(
      operation.metadata.source ?? getAssociatedTokenAddressSync(cardsMint, this.signer!.publicKey),
    ));
    const destination = new PublicKey(String(
      operation.metadata.destination
        ?? getAssociatedTokenAddressSync(cardsMint, this.config.operatorDestination!),
    ));
    const beforeSource = BigInt(String(operation.metadata.preCreatorRaw ?? '0'));
    const beforeDestination = BigInt(String(operation.metadata.preDestinationRaw ?? '0'));
    const currentSource = await this.readTokenBalance(source);
    const currentDestination = await this.readTokenBalance(destination);
    const moved = currentSource === beforeSource - BigInt(operation.amountRaw)
      && currentDestination === beforeDestination + BigInt(operation.amountRaw);
    const confirmed = signatureStatus?.confirmationStatus === 'confirmed'
      || signatureStatus?.confirmationStatus === 'finalized';
    if (moved && confirmed) {
      await this.store.confirmOperatorClaim(operation.operationKey, operation.signature);
      this.logInfo('operator_claim_reconciled', {
        signature: operation.signature,
        amountRaw: String(operation.amountRaw),
      });
      return true;
    }
    if (confirmed) {
      await this.store.update(operation.operationKey, { status: 'unknown' });
    }
    return false;
  }

  private async observeFunding(operation: CreatorRewardOperation): Promise<'confirmed' | 'failed' | 'unknown'> {
    if (!operation.signature) return 'unknown';
    const status = await this.connection.getSignatureStatuses([operation.signature]);
    const signatureStatus = status.value[0];
    if (signatureStatus?.err) {
      await this.store.failFunding(operation.operationKey);
      return 'failed';
    }
    if (
      signatureStatus?.confirmationStatus === 'confirmed'
      || signatureStatus?.confirmationStatus === 'finalized'
    ) {
      await this.store.update(operation.operationKey, { status: 'confirmed' });
      return 'confirmed';
    }
    if (operation.status !== 'unknown') {
      await this.store.update(operation.operationKey, { status: 'unknown' });
    }
    return 'unknown';
  }

  private async creditClaim(operationKey: string, cardsMint: PublicKey, gross: bigint): Promise<void> {
    const split = splitCardsCreatorReward(gross);
    await this.store.creditConfirmedClaim({
      operationKey,
      cardsMint: cardsMint.toBase58(),
      grossRaw: safeNumber(split.gross),
      tournamentRaw: safeNumber(split.tournament),
      operatorRaw: safeNumber(split.operator),
    });
  }

  private async reconcileOpen(
    operation: CreatorRewardOperation,
    beforeSource: bigint,
    cardsMint: PublicKey,
  ): Promise<boolean> {
    if (operation.kind !== 'claim_cards') return false;
    if (!operation.signature) {
      this.logWarn('retry_reconciliation', { operation: operation.operationKey, reason: 'missing_signature' });
      return false;
    }
    const status = await this.connection.getSignatureStatuses([operation.signature]);
    const signatureStatus = status.value[0];
    if (signatureStatus?.err) {
      await this.store.update(operation.operationKey, { status: 'failed' });
      return false;
    }
    const current = await this.connection.getParsedAccountInfo(
      getAssociatedTokenAddressSync(cardsMint, this.creator!),
      'confirmed',
    );
    const currentAmount = current.value ? tokenAccountAmount(current) : 0n;
    const expectedBefore = BigInt(String(operation.metadata.preCreatorRaw ?? beforeSource));
    const signatureConfirmed = signatureStatus?.confirmationStatus === 'confirmed'
      || signatureStatus?.confirmationStatus === 'finalized';
    if (currentAmount <= expectedBefore) {
      if (signatureConfirmed) {
        await this.store.update(operation.operationKey, { status: 'unknown' });
      }
      this.logWarn('retry_reconciliation', { operation: operation.operationKey, result: 'still_unknown' });
      return false;
    }
    await this.creditClaim(operation.operationKey, cardsMint, currentAmount - expectedBefore);
    await this.store.update(operation.operationKey, { status: 'confirmed' });
    this.logInfo('retry_reconciliation', { operation: operation.operationKey, result: 'confirmed' });
    return true;
  }

  private async assertFundingDestination(
    destination: PublicKey,
    cardsMint: PublicKey,
    keeper: PublicKey,
  ): Promise<void> {
    const expected = getAssociatedTokenAddressSync(cardsMint, keeper);
    if (!destination.equals(expected)) {
      throw new CreatorRewardFundingError('rejected', 'Tournament funding destination is not the keeper CARDS account.');
    }
    const account = await this.connection.getParsedAccountInfo(destination, 'confirmed');
    if (!account.value) return;
    if (!account.value.owner.equals(TOKEN_PROGRAM_ID)) {
      throw new CreatorRewardFundingError('rejected', 'Keeper CARDS account is not a classic SPL token account.');
    }
    const data = account.value.data as { parsed?: { info?: { mint?: string; owner?: string } } };
    if (data.parsed?.info?.mint !== cardsMint.toBase58() || data.parsed?.info?.owner !== keeper.toBase58()) {
      throw new CreatorRewardFundingError('rejected', 'Tournament funding destination does not belong to the keeper.');
    }
  }

  private async assertCardsMint(cardsMint: PublicKey): Promise<void> {
    const account = await this.connection.getParsedAccountInfo(cardsMint, 'confirmed');
    if (!account.value || !account.value.owner.equals(TOKEN_PROGRAM_ID)) {
      throw new Error('Configured CARDS mint must be a classic SPL Token mint.');
    }
    const data = account.value.data as { parsed?: { info?: { decimals?: number } } };
    if (data.parsed?.info?.decimals !== CARDS_DECIMALS) {
      throw new Error('Configured CARDS mint must use 6 decimals.');
    }
  }

  private async send(instructions: readonly TransactionInstruction[], signer: Keypair): Promise<{ signature: string; blockhash: string; lastValidBlockHeight: number }> {
    const latest = await this.connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({
      feePayer: signer.publicKey,
      recentBlockhash: latest.blockhash,
    }).add(...instructions);
    transaction.sign(signer);
    const signature = await this.connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    return { signature, ...latest };
  }

  private async confirm(input: {
    signature: string;
    blockhash: string;
    lastValidBlockHeight: number;
  }): Promise<'confirmed' | 'failed'> {
    try {
      const result = await this.connection.confirmTransaction({
        signature: input.signature,
        blockhash: input.blockhash,
        lastValidBlockHeight: input.lastValidBlockHeight,
      }, 'confirmed');
      if (result.value.err) {
        this.logWarn('transaction_failed', { signature: input.signature });
        return 'failed';
      }
      return 'confirmed';
    } catch {
      this.logWarn('rpc_unknown_outcome', { signature: input.signature });
      return 'failed';
    }
  }

  private logInfo(event: string, fields: Record<string, string>): void {
    this.logger.info('[creator-rewards]', { event, ...fields });
  }

  private logWarn(event: string, fields: Record<string, string>): void {
    this.logger.warn('[creator-rewards]', { event, ...fields });
  }

  private logError(event: string, error: unknown): void {
    this.logger.error('[creator-rewards]', {
      event,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
