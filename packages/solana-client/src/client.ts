import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type Commitment,
  type Signer,
  type TransactionSignature,
} from '@solana/web3.js';
import type { ArenaChainConfig } from './config';
import {
  configPda,
  entryEscrowPda,
  matchEscrowPda,
  prizeReservePda,
} from './pdas';
import { IX } from './discriminator';
import { evaluatePassport, type PassportStatus } from './passport';
import {
  createEnvQuote,
  createMockQuote,
  type PokeUsdQuote,
} from './quote';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from './token';

export type TxLifecycle = 'pending' | 'confirmed' | 'failed' | 'expired';

export interface SentTransaction {
  signature: TransactionSignature;
  status: TxLifecycle;
  slot?: number;
  error?: string;
}

export interface IntentVerification {
  expectedSigner: PublicKey;
  expectedProgram: PublicKey;
  discriminator: Buffer;
  accounts: PublicKey[];
  kind: 'sol_wager_deposit' | 'poke_entry_deposit';
  roomId?: Uint8Array;
  tournamentId?: Uint8Array;
  side?: 0 | 1;
  amount: bigint;
  quoteId?: Uint8Array;
}

export interface MatchEscrowState {
  creator: PublicKey;
  opponent: PublicKey;
  collateralLamports: bigint;
  creatorDeposited: boolean;
  opponentDeposited: boolean;
  feeCharged: boolean;
  status: number;
}

export interface MatchEscrowReadOptions {
  commitment?: Commitment;
  attempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export class ArenaChainClient {
  readonly connection: Connection;
  readonly config: ArenaChainConfig;
  private readonly solBalanceCache = new Map<string, { value: bigint; expiresAt: number }>();
  private readonly solBalanceReads = new Map<string, Promise<bigint>>();

  constructor(config: ArenaChainConfig) {
    this.config = config;
    this.connection = new Connection(config.rpcUrl, {
      commitment: config.commitment as Commitment,
      // web3.js otherwise sleeps 0.5s–4s per 429 and stacks on our own retry.
      disableRetryOnRateLimit: true,
    });
  }

  get configAddress(): PublicKey {
    return configPda(this.config.programId)[0];
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return this.withRpcRetry(() => this.connection.getLatestBlockhash(this.config.commitment));
  }

  async buildTransaction(
    payer: PublicKey,
    instructions: TransactionInstruction[],
  ): Promise<Transaction> {
    const latestBlockhash = await this.getLatestBlockhash();
    const tx = new Transaction();
    tx.feePayer = payer;
    tx.recentBlockhash = latestBlockhash.blockhash;
    tx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
    tx.add(...instructions);
    return tx;
  }

  async sendAndConfirm(
    transaction: Transaction,
    signers: Signer[],
  ): Promise<SentTransaction> {
    try {
      const signature = await this.connection.sendTransaction(transaction, signers, {
        skipPreflight: false,
        preflightCommitment: this.config.commitment,
      });
      const confirmation = await this.connection.confirmTransaction(
        {
          signature,
          blockhash: transaction.recentBlockhash!,
          lastValidBlockHeight: transaction.lastValidBlockHeight!,
        },
        this.config.commitment,
      );
      if (confirmation.value.err) {
        return {
          signature,
          status: 'failed',
          error: JSON.stringify(confirmation.value.err),
        };
      }
      const status = await this.connection.getSignatureStatus(signature);
      return {
        signature,
        status: 'confirmed',
        slot: status.value?.slot,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/block height exceeded|expired|not confirmed/i.test(message)) {
        return { signature: '', status: 'expired', error: message };
      }
      return { signature: '', status: 'failed', error: message };
    }
  }

  async confirmSignature(signature: string): Promise<SentTransaction> {
    if (!signature) return { signature, status: 'failed', error: 'Missing signature.' };
    try {
      const latest = await this.getLatestBlockhash();
      const confirmation = await this.connection.confirmTransaction(
        {
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        this.config.commitment,
      );
      if (confirmation.value.err) {
        return {
          signature,
          status: 'failed',
          error: JSON.stringify(confirmation.value.err),
        };
      }
      const status = await this.connection.getSignatureStatuses([signature]);
      return {
        signature,
        status: 'confirmed',
        slot: status.value[0]?.slot,
      };
    } catch (error) {
      return {
        signature,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Submit a deposit the server already issued, then read its signature once.
   * `processed` and a missing status are `pending`. Callers that need a
   * terminal outcome keep polling with `pollIssuedSignature`.
   */
  async confirmIssuedDeposit(input: {
    signature: string;
    serializedTx: Uint8Array;
    expectedSigner: PublicKey;
    signedSerializedTx?: Uint8Array;
    /** When false, only read the signature. The bytes were already submitted. */
    submit?: boolean;
  }): Promise<SentTransaction> {
    const local = input.signedSerializedTx
      ? verifyIssuedSignedTransaction({
          signature: input.signature,
          serializedTx: input.serializedTx,
          signedSerializedTx: input.signedSerializedTx,
          expectedSigner: input.expectedSigner,
        })
      : verifyIssuedSignature(input);
    console.info('[pokearena-deposit]', {
      signature: input.signature,
      localVerification: local.ok ? 'accepted' : 'rejected',
      ...(local.ok ? {} : { reason: local.reason }),
    });
    if (!local.ok) {
      return { signature: input.signature, status: 'failed', error: local.reason };
    }

    if (input.submit !== false && input.signedSerializedTx) {
      const signed = verifyIssuedSignedTransaction({
        signature: input.signature,
        serializedTx: input.serializedTx,
        signedSerializedTx: input.signedSerializedTx,
        expectedSigner: input.expectedSigner,
      });
      if (!signed.ok) {
        console.info('[pokearena-deposit]', {
          signature: input.signature,
          localVerification: 'rejected',
          lobby: 'rejected',
          reason: signed.reason,
        });
        return { signature: input.signature, status: 'failed', error: signed.reason };
      }
      try {
        await this.connection.sendRawTransaction(input.signedSerializedTx, {
          skipPreflight: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already processed|already confirmed|duplicate/i.test(message)) {
          return { signature: input.signature, status: 'failed', error: message };
        }
      }
    }

    return this.readIssuedSignature(input.signature);
  }

  /**
   * Follow an already-submitted deposit until it confirms, fails on-chain,
   * or its blockhash expires with no landing.
   */
  async pollIssuedSignature(input: {
    signature: string;
    serializedTx: Uint8Array;
    expectedSigner: PublicKey;
    signedSerializedTx?: Uint8Array;
    lastValidBlockHeight?: number;
    pollDelayMs?: number;
  }): Promise<SentTransaction> {
    const delay = input.pollDelayMs ?? 400;
    let outcome = await this.confirmIssuedDeposit({ ...input, submit: false });
    while (outcome.status === 'pending') {
      if (await this.depositBlockhashExpired(input.lastValidBlockHeight, outcome)) {
        return {
          signature: input.signature,
          status: 'expired',
          error: 'Blockhash expired before the deposit was confirmed.',
        };
      }
      await new Promise(resolve => setTimeout(resolve, delay));
      outcome = await this.readIssuedSignature(input.signature);
    }
    return outcome;
  }

  async getBlockHeight(): Promise<number> {
    return this.withRpcRetry(() => this.connection.getBlockHeight(this.config.commitment));
  }

  private async depositBlockhashExpired(
    lastValidBlockHeight: number | undefined,
    outcome: SentTransaction,
  ): Promise<boolean> {
    if (lastValidBlockHeight === undefined || outcome.slot !== undefined) return false;
    try {
      const height = await this.getBlockHeight();
      return height > lastValidBlockHeight;
    } catch {
      return false;
    }
  }

  private async readIssuedSignature(signature: string): Promise<SentTransaction> {
    let signatureStatus: {
      err: unknown;
      confirmationStatus?: string | null;
      slot?: number;
    } | null;
    try {
      const response = await this.connection.getSignatureStatuses([signature]);
      signatureStatus = response.value[0] ?? null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.info('[pokearena-deposit]', {
        signature,
        localVerification: 'accepted',
        signatureStatus: 'unavailable',
        lobby: 'pending',
        reason: message,
      });
      return {
        signature,
        status: 'pending',
        error: 'Signature status is not available yet.',
      };
    }

    console.info('[pokearena-deposit]', {
      signature,
      localVerification: 'accepted',
      signatureStatus: signatureStatus
        ? {
            err: signatureStatus.err,
            confirmationStatus: signatureStatus.confirmationStatus ?? null,
            slot: signatureStatus.slot,
          }
        : null,
    });
    if (!signatureStatus) {
      return {
        signature,
        status: 'pending',
        error: 'Transaction is not available yet.',
      };
    }
    if (signatureStatus.err) {
      return {
        signature,
        status: 'failed',
        slot: signatureStatus.slot,
        error: JSON.stringify(signatureStatus.err),
      };
    }
    const landed = signatureStatus.confirmationStatus === 'confirmed'
      || signatureStatus.confirmationStatus === 'finalized';
    if (!landed) {
      return {
        signature,
        status: 'pending',
        slot: signatureStatus.slot,
        error: 'Transaction has not reached confirmed status.',
      };
    }
    return {
      signature,
      status: 'confirmed',
      slot: signatureStatus.slot,
    };
  }

  async verifyIntentTransaction(
    signature: string,
    expected: IntentVerification,
  ): Promise<SentTransaction> {
    if (!signature) return { signature, status: 'failed', error: 'Missing signature.' };
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        commitment: this.config.commitment === 'processed' ? 'confirmed' : this.config.commitment,
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) {
        const signatureStatus = (
          await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
        ).value[0];
        if (!signatureStatus) {
          return { signature, status: 'pending', error: 'Transaction is not available yet.' };
        }
        if (signatureStatus.err) {
          return {
            signature,
            status: 'failed',
            slot: signatureStatus.slot ?? undefined,
            error: JSON.stringify(signatureStatus.err),
          };
        }
        const sufficientlyConfirmed = signatureStatus.confirmationStatus === 'finalized'
          || (
            this.config.commitment !== 'finalized'
            && signatureStatus.confirmationStatus === 'confirmed'
          );
        if (!sufficientlyConfirmed) {
          return { signature, status: 'pending', slot: signatureStatus.slot ?? undefined };
        }
        if (expected.kind === 'sol_wager_deposit') {
          try {
            await this.waitForMatchEscrowState(
              expected.roomId!,
              state => (
                state.collateralLamports === expected.amount
                && (expected.side === 0 ? state.creatorDeposited : state.opponentDeposited)
              ),
            );
            return { signature, status: 'confirmed', slot: signatureStatus.slot ?? undefined };
          } catch {
            return {
              signature,
              status: 'pending',
              slot: signatureStatus.slot ?? undefined,
              error: 'Transaction is finalized but its expected escrow state is not visible yet.',
            };
          }
        }
        return {
          signature,
          status: 'pending',
          slot: signatureStatus.slot ?? undefined,
          error: 'Transaction is finalized but its expected state is not visible yet.',
        };
      }
      if (tx.meta?.err) {
        return { signature, status: 'failed', error: JSON.stringify(tx.meta.err) };
      }

      const signer = tx.transaction.message.accountKeys.find(key => key.signer);
      if (!signer?.pubkey.equals(expected.expectedSigner)) {
        return { signature, status: 'failed', error: 'Transaction signer does not match the intent.' };
      }

      const instruction = tx.transaction.message.instructions.find(candidate => {
        if (!('accounts' in candidate) || !candidate.programId.equals(expected.expectedProgram)) return false;
        const data = decodeBase58(candidate.data);
        return data.subarray(0, 8).equals(expected.discriminator);
      });
      if (!instruction || !('accounts' in instruction)) {
        return { signature, status: 'failed', error: 'Expected program instruction was not found.' };
      }
      const actualAccounts = instruction.accounts.map(account => account.toBase58());
      for (const account of expected.accounts) {
        if (!actualAccounts.includes(account.toBase58())) {
          return { signature, status: 'failed', error: 'Transaction accounts do not match the intent.' };
        }
      }

      if (expected.kind === 'sol_wager_deposit') {
        try {
          await this.waitForMatchEscrowState(
            expected.roomId!,
            state => (
              state.collateralLamports === expected.amount
              && (expected.side === 0 ? state.creatorDeposited : state.opponentDeposited)
            ),
          );
        } catch {
          return { signature, status: 'pending', error: 'Match escrow state is not finalized yet.' };
        }
      } else {
        const state = await this.getEntryEscrowState(expected.tournamentId!, expected.expectedSigner);
        if (
          state.player !== expected.expectedSigner.toBase58()
          || state.amount !== expected.amount
          || state.status !== 0
          || (expected.quoteId && !Buffer.from(state.quoteId).equals(Buffer.from(expected.quoteId)))
        ) {
          return { signature, status: 'failed', error: 'Entry escrow state does not match the deposit intent.' };
        }
      }

      const status = await this.connection.getSignatureStatus(signature);
      return { signature, status: 'confirmed', slot: status.value?.slot };
    } catch (error) {
      return {
        signature,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getMatchEscrowState(
    roomId: Uint8Array,
    commitment: Commitment = this.config.commitment,
  ): Promise<MatchEscrowState> {
    return this.withRpcRetry(() => this.readMatchEscrowState(roomId, commitment), 3);
  }

  /** One escrow read. Deposit confirmation must not poll this. */
  async getMatchEscrowStateOnce(
    roomId: Uint8Array,
    commitment: Commitment = 'confirmed',
  ): Promise<MatchEscrowState> {
    return this.readMatchEscrowState(roomId, commitment);
  }

  private async readMatchEscrowState(
    roomId: Uint8Array,
    commitment: Commitment,
  ): Promise<MatchEscrowState> {
    const [address] = matchEscrowPda(this.config.programId, roomId);
    const account = await this.connection.getAccountInfo(address, commitment);
    if (!account) throw new Error('Match escrow account was not found.');
    const data = Buffer.from(account.data);
    return {
      creator: new PublicKey(data.subarray(24, 56)),
      opponent: new PublicKey(data.subarray(56, 88)),
      collateralLamports: data.readBigUInt64LE(88),
      creatorDeposited: data[96] === 1,
      opponentDeposited: data[97] === 1,
      feeCharged: data[98] === 1,
      status: data[99] ?? 255,
    };
  }

  async waitForMatchEscrowState(
    roomId: Uint8Array,
    predicate: (state: MatchEscrowState) => boolean,
    options: MatchEscrowReadOptions = {},
  ): Promise<MatchEscrowState> {
    const commitment = options.commitment ?? 'finalized';
    const attempts = Math.max(1, options.attempts ?? 4);
    const initialDelayMs = Math.max(0, options.initialDelayMs ?? 200);
    const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? 800);
    let lastError: unknown = new Error('Match escrow state did not reach the expected state.');

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const state = await this.readMatchEscrowState(roomId, commitment);
        if (predicate(state)) return state;
        lastError = new Error('Match escrow state did not reach the expected state.');
      } catch (error) {
        lastError = error;
      }
      if (attempt + 1 < attempts) {
        const delay = Math.min(maxDelayMs, initialDelayMs * (2 ** attempt));
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async getAccountInfoWithRetry(
    address: PublicKey,
    commitment: Commitment,
  ): Promise<Awaited<ReturnType<Connection['getAccountInfo']>>> {
    return this.withRpcRetry(() => this.connection.getAccountInfo(address, commitment));
  }

  private async withRpcRetry<T>(read: () => Promise<T>, attempts = 3): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await read();
      } catch (error) {
        lastError = error;
        if (!isRetryableRpcError(error) || attempt + 1 >= attempts) throw error;
        const delay = 200 * (2 ** attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async getEntryEscrowState(tournamentId: Uint8Array, player: PublicKey): Promise<{
    player: string;
    amount: bigint;
    quoteId: Uint8Array;
    status: number;
  }> {
    const [address] = entryEscrowPda(this.config.programId, tournamentId, player);
    const account = await this.connection.getAccountInfo(address, this.config.commitment);
    if (!account) throw new Error('Entry escrow account was not found.');
    const data = Buffer.from(account.data);
    return {
      player: new PublicKey(data.subarray(24, 56)).toBase58(),
      amount: data.readBigUInt64LE(56),
      quoteId: data.subarray(64, 96),
      status: data[104] ?? 255,
    };
  }

  async getPrizeReserveState(tournamentId: Uint8Array): Promise<{
    winner: PublicKey;
    amount: bigint;
    status: number;
    winnerSet: boolean;
  }> {
    const [address] = prizeReservePda(this.config.programId, tournamentId);
    const account = await this.connection.getAccountInfo(address, this.config.commitment);
    if (!account) throw new Error('Prize reserve account was not found.');
    const data = Buffer.from(account.data);
    return {
      winner: new PublicKey(data.subarray(24, 56)),
      amount: data.readBigUInt64LE(56),
      status: data[64] ?? 255,
      winnerSet: data[65] === 1,
    };
  }

  async getSolBalance(owner: PublicKey): Promise<bigint> {
    const key = owner.toBase58();
    const cached = this.solBalanceCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const inflight = this.solBalanceReads.get(key);
    if (inflight) return inflight;
    const read = this.withRpcRetry(() => this.connection.getBalance(owner, this.config.commitment))
      .then(lamports => {
        const value = BigInt(lamports);
        this.solBalanceCache.set(key, { value, expiresAt: Date.now() + 8_000 });
        return value;
      })
      .finally(() => {
        this.solBalanceReads.delete(key);
      });
    this.solBalanceReads.set(key, read);
    return read;
  }

  async getPokeBalance(owner: PublicKey): Promise<bigint> {
    const ata = getAssociatedTokenAddressSync(this.config.pokeMint, owner, true);
    try {
      const balance = await this.connection.getTokenAccountBalance(ata, this.config.commitment);
      return BigInt(balance.value.amount);
    } catch {
      return 0n;
    }
  }

  async getPokeAta(owner: PublicKey): Promise<PublicKey> {
    return getAssociatedTokenAddressSync(this.config.pokeMint, owner, true);
  }

  /** Exposed for ATA derivation in callers that mint/create accounts. */
  get tokenProgramId(): PublicKey {
    return TOKEN_PROGRAM_ID;
  }

  resolveQuote(env: NodeJS.ProcessEnv = process.env): PokeUsdQuote {
    const quote = createEnvQuote(env);
    if (quote) return quote;
    if (this.config.cluster !== 'localnet') {
      throw new Error('A production POKE quote is required; mock pricing is localnet-only.');
    }
    return createMockQuote();
  }

  async getPassportStatus(input: {
    owner: PublicKey;
    heldEntryAtoms?: bigint;
    quote?: PokeUsdQuote;
  }): Promise<PassportStatus> {
    const liquidAtoms = await this.getPokeBalance(input.owner);
    const quote = input.quote ?? this.resolveQuote();
    return evaluatePassport({
      liquidAtoms,
      heldEntryAtoms: input.heldEntryAtoms,
      quote,
    });
  }

  async getTreasuryLamports(): Promise<bigint> {
    return this.getSolBalance(this.config.treasuryVault);
  }

  async getFeeVaultLamports(): Promise<bigint> {
    return this.getSolBalance(this.config.feeVault);
  }
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function decodeBase58(value: string): Buffer {
  const bytes = [0];
  for (const character of value) {
    const index = BASE58_ALPHABET.indexOf(character);
    if (index < 0) throw new Error('Invalid transaction instruction encoding.');
    let carry = index;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const character of value) {
    if (character !== '1') break;
    bytes.push(0);
  }
  return Buffer.from(bytes.reverse());
}

function verifyIssuedSignature(input: {
  signature: string;
  serializedTx: Uint8Array;
  expectedSigner: PublicKey;
}): { ok: true } | { ok: false; reason: string } {
  let message: Transaction;
  try {
    message = Transaction.from(input.serializedTx);
  } catch {
    return { ok: false, reason: 'Issued deposit transaction could not be read.' };
  }
  if (!message.feePayer?.equals(input.expectedSigner)) {
    return { ok: false, reason: 'Issued deposit transaction is not for this wallet.' };
  }
  let signature: Buffer;
  try {
    signature = decodeBase58(input.signature);
  } catch {
    return { ok: false, reason: 'Deposit signature is not a valid transaction signature.' };
  }
  if (signature.length !== 64) {
    return { ok: false, reason: 'Deposit signature is not a valid transaction signature.' };
  }
  try {
    message.addSignature(input.expectedSigner, signature);
  } catch {
    return { ok: false, reason: 'Signature does not match the issued deposit transaction.' };
  }
  let valid = false;
  try {
    valid = message.verifySignatures();
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, reason: 'Signature does not match the issued deposit transaction.' };
  }
  return { ok: true };
}

const WALLET_AUGMENTATION_PROGRAMS = [
  new PublicKey('ComputeBudget111111111111111111111111111111'),
  new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'),
  new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
  new PublicKey('Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo'),
];

function isWalletAugmentation(instruction: TransactionInstruction): boolean {
  return WALLET_AUGMENTATION_PROGRAMS.some(programId => instruction.programId.equals(programId));
}

function depositInstructionMismatch(
  issued: TransactionInstruction[],
  signed: TransactionInstruction[],
): string | undefined {
  const shared = Math.min(issued.length, signed.length);
  for (let index = 0; index < shared; index += 1) {
    const left = issued[index]!;
    const right = signed[index]!;
    if (!left.programId.equals(right.programId)) {
      return `instruction ${index} program ${left.programId.toBase58()} != ${right.programId.toBase58()}`;
    }
    if (!Buffer.from(left.data).equals(Buffer.from(right.data))) {
      return `instruction ${index} data`;
    }
    if (left.keys.length !== right.keys.length) {
      return `instruction ${index} account count ${left.keys.length} != ${right.keys.length}`;
    }
    for (let keyIndex = 0; keyIndex < left.keys.length; keyIndex += 1) {
      const expected = left.keys[keyIndex]!;
      const actual = right.keys[keyIndex]!;
      if (!expected.pubkey.equals(actual.pubkey)) {
        return `instruction ${index} account ${keyIndex} pubkey`;
      }
      if (expected.isSigner !== actual.isSigner) {
        return `instruction ${index} account ${keyIndex} signer`;
      }
      // A wallet assertion can promote a readonly account to writable in the
      // compiled message header. It must not take writability away.
      if (expected.isWritable && !actual.isWritable) {
        return `instruction ${index} account ${keyIndex} writable`;
      }
    }
  }
  if (signed.length > issued.length) {
    return `extra instruction program ${signed[issued.length]!.programId.toBase58()}`;
  }
  if (signed.length < issued.length) {
    return `missing issued instruction ${issued.length - signed.length}`;
  }
  return undefined;
}

function verifyIssuedSignedTransaction(input: {
  signature: string;
  serializedTx: Uint8Array;
  signedSerializedTx: Uint8Array;
  expectedSigner: PublicKey;
}): { ok: true } | { ok: false; reason: string } {
  let issued: Transaction;
  let signed: Transaction;
  try {
    issued = Transaction.from(input.serializedTx);
    signed = Transaction.from(input.signedSerializedTx);
  } catch {
    return { ok: false, reason: 'Signed deposit transaction could not be read.' };
  }
  if (!signed.feePayer?.equals(input.expectedSigner)) {
    return { ok: false, reason: 'Signed deposit transaction is not for this wallet.' };
  }
  // Wallets may prepend ComputeBudget priority fees and append Lighthouse or
  // Memo assertions. Those instructions are not part of the deposit. The
  // deposit instructions themselves must still be the issued ones, in order.
  const issuedInstructions = issued.instructions.filter(instruction => !isWalletAugmentation(instruction));
  const signedInstructions = signed.instructions.filter(instruction => !isWalletAugmentation(instruction));
  const mismatch = depositInstructionMismatch(issuedInstructions, signedInstructions);
  if (mismatch) {
    return {
      ok: false,
      reason: `Signed transaction instructions do not match the issued deposit transaction. First difference: ${mismatch}.`,
    };
  }
  let signature: Buffer;
  try {
    signature = decodeBase58(input.signature);
  } catch {
    return { ok: false, reason: 'Deposit signature is not a valid transaction signature.' };
  }
  const walletSignature = signed.signatures.find(entry => entry.publicKey.equals(input.expectedSigner))?.signature;
  if (!walletSignature || !walletSignature.equals(signature)) {
    return { ok: false, reason: 'Submitted signature does not match the signed transaction.' };
  }
  if (!signed.verifySignatures()) {
    return { ok: false, reason: 'Signed deposit transaction has an invalid wallet signature.' };
  }
  return { ok: true };
}

function isRetryableRpcError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|too many requests|rate limit|temporarily unavailable|timeout|timed out|fetch failed|network/i.test(message);
}
