import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

import { ArenaChainClient, type ArenaChainConfig, IX } from '../src/index';

const programId = new PublicKey('6nVegJd8zVaV8RfLL6VQ6AQoB53FPsZSTGfidevdKM98');
const expectedSigner = new PublicKey('11111111111111111111111111111111');
const wrongSigner = new PublicKey('SysvarRent111111111111111111111111111111111');

function config(): ArenaChainConfig {
  return {
    cluster: 'localnet',
    rpcUrl: 'http://127.0.0.1:8899',
    programId,
    pokeMint: PublicKey.default,
    cardsMint: PublicKey.default,
    feeVault: PublicKey.default,
    treasuryVault: PublicKey.default,
    operatorVault: PublicKey.default,
    quoteAuthority: PublicKey.default,
    keeper: PublicKey.default,
    authority: PublicKey.default,
    buybackBps: 2500,
    minBuybackLamports: 1,
    chainEconomyEnabled: true,
    commitment: 'confirmed',
  };
}

test('intent verification rejects a confirmed transaction from another signer', async () => {
  const client = new ArenaChainClient(config());
  (client as unknown as { connection: unknown }).connection = {
    getParsedTransaction: async () => ({
      meta: { err: null },
      transaction: {
        message: {
          accountKeys: [{ pubkey: wrongSigner, signer: true }],
          instructions: [],
        },
      },
    }),
  };
  const result = await client.verifyIntentTransaction('unrelated-signature', {
    expectedSigner,
    expectedProgram: programId,
    discriminator: IX.depositSolWager,
    accounts: [expectedSigner],
    kind: 'sol_wager_deposit',
    roomId: Buffer.alloc(16),
    side: 0,
    amount: 1n,
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /signer/i);
});

test('intent verification rejects a same-signer transaction without the expected action', async () => {
  const client = new ArenaChainClient(config());
  (client as unknown as { connection: unknown }).connection = {
    getParsedTransaction: async () => ({
      meta: { err: null },
      transaction: {
        message: {
          accountKeys: [{ pubkey: expectedSigner, signer: true }],
          instructions: [],
        },
      },
    }),
  };
  const result = await client.verifyIntentTransaction('unrelated-signature', {
    expectedSigner,
    expectedProgram: programId,
    discriminator: IX.depositSolWager,
    accounts: [expectedSigner],
    kind: 'sol_wager_deposit',
    roomId: Buffer.alloc(16),
    side: 0,
    amount: 1n,
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /instruction/i);
});

test('intent verification reconciles a finalized SOL deposit when RPC transaction lookup lags', async () => {
  const client = new ArenaChainClient(config());
  const escrowData = Buffer.alloc(102);
  escrowData.writeBigUInt64LE(1n, 88);
  escrowData[96] = 1;
  (client as unknown as { connection: unknown }).connection = {
    getParsedTransaction: async () => null,
    getSignatureStatuses: async () => ({
      context: { slot: 99 },
      value: [{ confirmationStatus: 'finalized', confirmations: null, err: null, slot: 98 }],
    }),
    getAccountInfo: async () => ({
      data: escrowData,
    }),
  };

  const result = await client.verifyIntentTransaction('landed-signature', {
    expectedSigner,
    expectedProgram: programId,
    discriminator: IX.depositSolWager,
    accounts: [expectedSigner],
    kind: 'sol_wager_deposit',
    roomId: Buffer.alloc(16),
    side: 0,
    amount: 1n,
  });

  assert.equal(result.status, 'confirmed');
  assert.equal(result.slot, 98);
});

test('SOL balance reads retry a public RPC rate limit and reuse the result', async () => {
  const client = new ArenaChainClient(config());
  const owner = Keypair.generate().publicKey;
  let calls = 0;
  (client as unknown as { connection: unknown }).connection = {
    getBalance: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('failed to get balance of account: 429 Too Many Requests');
      }
      return 25_000_000;
    },
  };

  const first = await client.getSolBalance(owner);
  const second = await client.getSolBalance(owner);

  assert.equal(first, 25_000_000n);
  assert.equal(second, 25_000_000n);
  assert.equal(calls, 2);
});

test('match escrow reads retry transient RPC rate limits', async () => {
  const client = new ArenaChainClient(config());
  const escrowData = Buffer.alloc(102);
  escrowData.writeBigUInt64LE(1n, 88);
  let calls = 0;
  (client as unknown as { connection: unknown }).connection = {
    getAccountInfo: async () => {
      calls += 1;
      if (calls === 1) throw new Error('429 Too Many Requests');
      return { data: escrowData };
    },
  };

  const state = await client.getMatchEscrowState(Buffer.alloc(16));

  assert.equal(calls, 2);
  assert.equal(state.collateralLamports, 1n);
});

test('match escrow polling waits for a finalized state transition', async () => {
  const client = new ArenaChainClient(config());
  let calls = 0;
  (client as unknown as { connection: unknown }).connection = {
    getAccountInfo: async () => {
      calls += 1;
      const escrowData = Buffer.alloc(102);
      escrowData.writeBigUInt64LE(1n, 88);
      escrowData[96] = calls > 1 ? 1 : 0;
      return { data: escrowData };
    },
  };

  const state = await client.waitForMatchEscrowState(
    Buffer.alloc(16),
    escrow => escrow.creatorDeposited,
    { initialDelayMs: 0, maxDelayMs: 0 },
  );

  assert.equal(calls, 2);
  assert.equal(state.creatorDeposited, true);
});

function encodeBase58(input: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const byte of input) value = (value << 8n) + BigInt(byte);
  let encoded = '';
  while (value > 0n) {
    const remainder = value % 58n;
    value /= 58n;
    encoded = alphabet[Number(remainder)] + encoded;
  }
  for (const byte of input) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || '1';
}

function issuedDeposit(payer: Keypair) {
  const tx = new Transaction();
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: payer.publicKey,
    lamports: 1,
  }));
  const serializedTx = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  tx.sign(payer);
  return {
    serializedTx,
    signedSerializedTx: tx.serialize(),
    signature: encodeBase58(tx.signature!),
  };
}

function stubStatusConnection(status: {
  err?: unknown;
  confirmationStatus?: string | null;
} | null) {
  const calls = { status: 0, parsed: 0, account: 0 };
  return {
    calls,
    connection: {
      getSignatureStatuses: async () => {
        calls.status += 1;
        return {
          context: { slot: 9 },
          value: [status ? { slot: 8, confirmations: 1, err: status.err ?? null, confirmationStatus: status.confirmationStatus } : null],
        };
      },
      sendRawTransaction: async () => 'submitted',
      getParsedTransaction: async () => {
        calls.parsed += 1;
        return null;
      },
      getAccountInfo: async () => {
        calls.account += 1;
        return null;
      },
    },
  };
}

test('issued deposit confirmation accepts the signed transaction from one signature status', async () => {
  const payer = Keypair.generate();
  const issued = issuedDeposit(payer);
  const client = new ArenaChainClient(config());
  const stub = stubStatusConnection({ confirmationStatus: 'confirmed' });
  (client as unknown as { connection: unknown }).connection = stub.connection;

  const result = await client.confirmIssuedDeposit({
    signature: issued.signature,
    serializedTx: issued.serializedTx,
    expectedSigner: payer.publicKey,
  });

  assert.equal(result.status, 'confirmed');
  assert.equal(stub.calls.status, 1);
  assert.equal(stub.calls.parsed, 0);
  assert.equal(stub.calls.account, 0);
});

test('issued deposit submits the exact signed transaction before one status read', async () => {
  const payer = Keypair.generate();
  const issued = issuedDeposit(payer);
  const client = new ArenaChainClient(config());
  const stub = stubStatusConnection({ confirmationStatus: 'confirmed' });
  (client as unknown as { connection: unknown }).connection = stub.connection;

  const result = await client.confirmIssuedDeposit({
    signature: issued.signature,
    serializedTx: issued.serializedTx,
    signedSerializedTx: issued.signedSerializedTx,
    expectedSigner: payer.publicKey,
  });

  assert.equal(result.status, 'confirmed');
  assert.equal(stub.calls.status, 1);
  assert.equal(stub.calls.parsed, 0);
  assert.equal(stub.calls.account, 0);
});

const LIGHTHOUSE_PROGRAM = new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');

function signIssued(payer: Keypair, serializedTx: Uint8Array, mutate?: (tx: Transaction) => void) {
  const tx = Transaction.from(serializedTx);
  const before = tx.instructions.map(instruction => ({
    programId: instruction.programId.toBase58(),
    data: Buffer.from(instruction.data).toString('hex'),
    keys: instruction.keys.map(key => key.pubkey.toBase58()),
  }));
  mutate?.(tx);
  tx.sign(payer);
  const signed = Transaction.from(tx.serialize());
  return {
    before,
    signed,
    signedSerializedTx: tx.serialize(),
    signature: encodeBase58(tx.signature!),
  };
}

test('wallet signature does not change the issued deposit instructions', () => {
  const payer = Keypair.generate();
  const issued = issuedDeposit(payer);
  const signed = signIssued(payer, issued.serializedTx);
  const depositInstructions = signed.signed.instructions.filter(
    instruction => !instruction.programId.equals(ComputeBudgetProgram.programId)
      && !instruction.programId.equals(LIGHTHOUSE_PROGRAM),
  );
  assert.deepEqual(depositInstructions.map(instruction => ({
    programId: instruction.programId.toBase58(),
    data: Buffer.from(instruction.data).toString('hex'),
    keys: instruction.keys.map(key => key.pubkey.toBase58()),
  })), signed.before);
  assert.equal(depositInstructions.length, 1);
});

test('wallet priority fee and lighthouse assertions still match the issued deposit', async () => {
  const payer = Keypair.generate();
  const configAccount = Keypair.generate().publicKey;
  const issuedTx = new Transaction();
  issuedTx.feePayer = payer.publicKey;
  issuedTx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  issuedTx.add(new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configAccount, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(IX.createMatchEscrow),
  }));
  issuedTx.add(new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    ],
    data: Buffer.from(IX.depositSolWager),
  }));
  const serializedTx = issuedTx.serialize({ requireAllSignatures: false, verifySignatures: false });
  const signed = signIssued(payer, serializedTx, tx => {
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 }),
    );
    tx.add(new TransactionInstruction({
      programId: LIGHTHOUSE_PROGRAM,
      keys: [{ pubkey: configAccount, isSigner: false, isWritable: true }],
      data: Buffer.from([1, 2, 3]),
    }));
  });
  const arenaInstructions = signed.signed.instructions.filter(instruction => instruction.programId.equals(programId));
  assert.equal(arenaInstructions.length, 2);
  assert.equal(
    arenaInstructions.filter(instruction => Buffer.from(instruction.data).equals(Buffer.from(IX.createMatchEscrow))).length,
    1,
  );
  assert.equal(arenaInstructions[0]!.keys[1]!.isWritable, true);

  const client = new ArenaChainClient(config());
  const stub = stubStatusConnection({ confirmationStatus: 'confirmed' });
  (client as unknown as { connection: unknown }).connection = stub.connection;
  const result = await client.confirmIssuedDeposit({
    signature: signed.signature,
    serializedTx,
    signedSerializedTx: signed.signedSerializedTx,
    expectedSigner: payer.publicKey,
  });

  assert.equal(result.status, 'confirmed');
  assert.equal(stub.calls.status, 1);
});

test('an intentionally modified deposit instruction is rejected before submission', async () => {
  const payer = Keypair.generate();
  const issued = issuedDeposit(payer);
  const signed = signIssued(payer, issued.serializedTx, tx => {
    const instruction = tx.instructions[0]!;
    instruction.data = Buffer.from([9]);
  });
  const client = new ArenaChainClient(config());
  const stub = stubStatusConnection({ confirmationStatus: 'confirmed' });
  let sent = 0;
  stub.connection.sendRawTransaction = async () => {
    sent += 1;
    return 'submitted';
  };
  (client as unknown as { connection: unknown }).connection = stub.connection;

  const result = await client.confirmIssuedDeposit({
    signature: signed.signature,
    serializedTx: issued.serializedTx,
    signedSerializedTx: signed.signedSerializedTx,
    expectedSigner: payer.publicKey,
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /instruction 0 data/);
  assert.equal(sent, 0);
  assert.equal(stub.calls.status, 0);
});

test('a second deposit instruction is rejected', async () => {
  const payer = Keypair.generate();
  const issued = issuedDeposit(payer);
  const signed = signIssued(payer, issued.serializedTx, tx => {
    tx.add(SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: payer.publicKey,
      lamports: 2,
    }));
  });
  const client = new ArenaChainClient(config());
  const stub = stubStatusConnection({ confirmationStatus: 'confirmed' });
  (client as unknown as { connection: unknown }).connection = stub.connection;

  const result = await client.confirmIssuedDeposit({
    signature: signed.signature,
    serializedTx: issued.serializedTx,
    signedSerializedTx: signed.signedSerializedTx,
    expectedSigner: payer.publicKey,
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /extra instruction program 11111111111111111111111111111111/);
  assert.equal(stub.calls.status, 0);
});

test('issued deposit confirmation rejects an unrelated valid signature before any RPC call', async () => {
  const payer = Keypair.generate();
  const issued = issuedDeposit(payer);
  const other = issuedDeposit(payer);
  const client = new ArenaChainClient(config());
  const stub = stubStatusConnection({ confirmationStatus: 'confirmed' });
  (client as unknown as { connection: unknown }).connection = stub.connection;

  const result = await client.confirmIssuedDeposit({
    signature: other.signature,
    serializedTx: issued.serializedTx,
    expectedSigner: payer.publicKey,
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /issued deposit/i);
  assert.equal(stub.calls.status, 0);
  assert.equal(stub.calls.parsed, 0);
  assert.equal(stub.calls.account, 0);
});

test('issued deposit confirmation rejects a client confirmed flag and a not-yet-landed status', async () => {
  const payer = Keypair.generate();
  const issued = issuedDeposit(payer);
  const client = new ArenaChainClient(config());
  const stub = stubStatusConnection({ confirmationStatus: 'processed' });
  (client as unknown as { connection: unknown }).connection = stub.connection;

  const forged = await client.confirmIssuedDeposit({
    signature: 'confirmed',
    serializedTx: issued.serializedTx,
    expectedSigner: payer.publicKey,
  });
  assert.equal(forged.status, 'failed');
  assert.equal(stub.calls.status, 0);

  const pending = await client.confirmIssuedDeposit({
    signature: issued.signature,
    serializedTx: issued.serializedTx,
    expectedSigner: payer.publicKey,
  });
  assert.equal(pending.status, 'pending');
  assert.equal(stub.calls.status, 1);
  assert.equal(stub.calls.parsed, 0);
  assert.equal(stub.calls.account, 0);
});

test('issued deposit confirmation fails a landed transaction that returned an error', async () => {
  const payer = Keypair.generate();
  const issued = issuedDeposit(payer);
  const client = new ArenaChainClient(config());
  const stub = stubStatusConnection({
    confirmationStatus: 'confirmed',
    err: { InstructionError: [0, 'Custom'] },
  });
  (client as unknown as { connection: unknown }).connection = stub.connection;

  const result = await client.confirmIssuedDeposit({
    signature: issued.signature,
    serializedTx: issued.serializedTx,
    expectedSigner: payer.publicKey,
  });

  assert.equal(result.status, 'failed');
  assert.equal(stub.calls.status, 1);
  assert.equal(stub.calls.parsed, 0);
});

test('buildTransaction sets the current blockhash, fee payer, and expiry height before serialization', async () => {
  const client = new ArenaChainClient(config());
  const payer = Keypair.generate();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lastValidBlockHeight = 123456;

  client.connection.getLatestBlockhash = async () => ({
    blockhash,
    lastValidBlockHeight,
  });

  const transaction = await client.buildTransaction(payer.publicKey, [
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
  ]);

  assert.equal(transaction.recentBlockhash, blockhash);
  assert.equal(transaction.feePayer?.toBase58(), payer.publicKey.toBase58());
  assert.equal(transaction.lastValidBlockHeight, lastValidBlockHeight);
  assert.doesNotThrow(() => transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  }));
});

test('intent verification treats RPC 429 as pending after bounded retries', async () => {
  const client = new ArenaChainClient(config());
  client.observationRetryDelayMs = () => 0;
  let calls = 0;
  (client as unknown as { connection: unknown }).connection = {
    getParsedTransaction: async () => {
      calls += 1;
      throw new Error('429 Too Many Requests');
    },
  };

  const result = await client.verifyIntentTransaction('landed-signature', {
    expectedSigner,
    expectedProgram: programId,
    discriminator: IX.depositPokeEntry,
    accounts: [expectedSigner],
    kind: 'poke_entry_deposit',
    tournamentId: Buffer.alloc(16),
    amount: 1n,
  });

  assert.equal(result.status, 'pending');
  assert.match(result.error ?? '', /429/);
  assert.equal(calls, 4);
});

test('intent verification treats timeout and connection reset as pending', async () => {
  for (const message of ['request timed out', 'fetch failed: read ECONNRESET']) {
    const client = new ArenaChainClient(config());
    client.observationRetryDelayMs = () => 0;
    (client as unknown as { connection: unknown }).connection = {
      getParsedTransaction: async () => {
        throw new Error(message);
      },
    };
    const result = await client.verifyIntentTransaction('landed-signature', {
      expectedSigner,
      expectedProgram: programId,
      discriminator: IX.depositPokeEntry,
      accounts: [expectedSigner],
      kind: 'poke_entry_deposit',
      tournamentId: Buffer.alloc(16),
      amount: 1n,
    });
    assert.equal(result.status, 'pending', message);
    assert.equal(result.signature, 'landed-signature');
  }
});

test('intent verification keeps a definitive on-chain error failed', async () => {
  const client = new ArenaChainClient(config());
  client.observationRetryDelayMs = () => 0;
  let calls = 0;
  (client as unknown as { connection: unknown }).connection = {
    getParsedTransaction: async () => {
      calls += 1;
      return {
        meta: { err: { InstructionError: [0, 'Custom'] } },
        transaction: { message: { accountKeys: [], instructions: [] } },
      };
    },
  };

  const result = await client.verifyIntentTransaction('failed-signature', {
    expectedSigner,
    expectedProgram: programId,
    discriminator: IX.depositPokeEntry,
    accounts: [expectedSigner],
    kind: 'poke_entry_deposit',
    tournamentId: Buffer.alloc(16),
    amount: 1n,
  });

  assert.equal(result.status, 'failed');
  assert.equal(calls, 1);
});

test('POKE balance reads retry a rate limit instead of reporting zero', async () => {
  const client = new ArenaChainClient(config());
  client.observationRetryDelayMs = () => 0;
  const owner = Keypair.generate().publicKey;
  let calls = 0;
  (client as unknown as { connection: unknown }).connection = {
    getTokenAccountBalance: async () => {
      calls += 1;
      if (calls === 1) throw new Error('429 Too Many Requests');
      return { value: { amount: '42' } };
    },
  };

  const balance = await client.getPokeBalance(owner);

  assert.equal(balance, 42n);
  assert.equal(calls, 2);
});
