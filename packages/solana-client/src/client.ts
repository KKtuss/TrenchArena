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

export class ArenaChainClient {
  readonly connection: Connection;
  readonly config: ArenaChainConfig;

  constructor(config: ArenaChainConfig) {
    this.config = config;
    this.connection = new Connection(config.rpcUrl, config.commitment as Commitment);
  }

  get configAddress(): PublicKey {
    return configPda(this.config.programId)[0];
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return this.connection.getLatestBlockhash(this.config.commitment);
  }

  async buildTransaction(
    payer: PublicKey,
    instructions: TransactionInstruction[],
  ): Promise<Transaction> {
    const { blockhash, lastValidBlockHeight } = await this.getLatestBlockhash();
    const tx = new Transaction({
      feePayer: payer,
      blockhash,
      lastValidBlockHeight,
    });
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
      if (!tx) return { signature, status: 'pending', error: 'Transaction is not available yet.' };
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
        const state = await this.getMatchEscrowState(expected.roomId!);
        const deposited = expected.side === 0 ? state.creatorDeposited : state.opponentDeposited;
        if (state.collateralLamports !== expected.amount || !deposited) {
          return { signature, status: 'failed', error: 'Match escrow state does not match the deposit intent.' };
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

  async getMatchEscrowState(roomId: Uint8Array): Promise<{
    creator: PublicKey;
    opponent: PublicKey;
    collateralLamports: bigint;
    creatorDeposited: boolean;
    opponentDeposited: boolean;
    feeCharged: boolean;
    status: number;
  }> {
    const [address] = matchEscrowPda(this.config.programId, roomId);
    const account = await this.connection.getAccountInfo(address, this.config.commitment);
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
    return BigInt(await this.connection.getBalance(owner, this.config.commitment));
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
